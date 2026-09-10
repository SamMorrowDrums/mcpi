import type { Api, Context, Model, Tool } from "../types.ts";
import { type AssistantMessageDiagnostic, appendAssistantMessageDiagnostic } from "./diagnostics.ts";

type ToolNameNormalizer = (name: string) => string;

const identityToolName: ToolNameNormalizer = (name) => name;

/** Diagnostic emitted when an API sends schemas up front that deferral would have withheld. */
export const DEFERRED_TOOLS_UNSUPPORTED_DIAGNOSTIC = "deferred_tools_unsupported";

/** Diagnostic emitted when an endpoint rejected the deferred-tool protocol itself. */
export const DEFERRED_TOOLS_REJECTED_DIAGNOSTIC = "deferred_tools_rejected";

/** Diagnostic emitted when a load point revealed deferred schemas to the model. */
export const DEFERRED_TOOLS_LOADED_DIAGNOSTIC = "deferred_tools_loaded";

/** How the current tools split across the request tools array and transcript load points. */
export interface DeferredToolPlacement {
	/** Tools whose schemas are sent up front, registration order first, then promoted tools. */
	immediate: Tool[];
	/** Tools whose schemas are withheld until a transcript load point, keyed by normalized name. */
	deferred: Map<string, Tool>;
	/** Names deferral would have withheld but that were sent as full schemas anyway. */
	unsupported: string[];
}

/** How a single API wants tools split. */
export interface SplitDeferredToolsOptions {
	/** False when the target model cannot withhold any schema. */
	enabled: boolean;
	/**
	 * False when the API can only reveal a schema at a transcript marker, because it has no
	 * turn-zero anchor and no server-side catalog the model could search. Deferring a
	 * registered tool there would leave it in `Context.tools` but name it nowhere in the
	 * request, so the model could never discover or call it. Those tools stay immediate for
	 * the whole session instead, and are reported through `unsupported`.
	 */
	registrationDeferral?: boolean;
	/**
	 * True when the caller adds its own discovery tool to the request, such as Anthropic's
	 * server-side tool-search tool. The safety floor below exists only to guarantee the model
	 * has something to start from; a discovery tool provides that, so the floor stands down and
	 * a fully deferred tool set stays deferred.
	 */
	providesToolSearch?: boolean;
	/** Applied to every tool name before comparison, for APIs that rewrite names. */
	normalizeName?: ToolNameNormalizer;
}

/** Normalized names of the tools registered with `deferred: true`. */
function listRegistrationDeferred(uniqueTools: ReadonlyMap<string, Tool>): Set<string> {
	const names = new Set<string>();
	for (const [name, tool] of uniqueTools) {
		if (tool.deferred === true) names.add(name);
	}
	return names;
}

/**
 * Split current tools into up-front definitions and definitions loaded from the transcript.
 *
 * A tool is deferred when it was registered with `deferred: true` or when a
 * `ToolResultMessage.addedToolNames` marker introduced it. Either way it stays in
 * `Context.tools`, so dispatch and grammar membership never change.
 *
 * A deferred tool is promoted back to immediate when the transcript shows the model calling
 * it before any load point covered it. That keeps replayed histories valid: a `tool_use`
 * block always has a schema behind it. Promotion is sticky because the call stays in the
 * transcript, and promoted tools are appended after the registration-immediate ones so the
 * cacheable prefix of the tools array does not shift.
 *
 * Deferring is withholding a schema, never withholding a name. An API that keeps deferred
 * entries in its own tools array, such as Anthropic's `defer_loading`, still names every tool
 * in the request, so a call the model does make resolves. `registrationDeferral: false` exists
 * for the APIs that would instead drop the tool from the request altogether.
 *
 * Deferral is resolved even for an API that cannot express it. Those names come back in
 * `unsupported` with their full schemas kept immediate, so the caller can report the
 * expansion instead of silently inlining every schema.
 */
export function splitDeferredTools(context: Context, options: SplitDeferredToolsOptions): DeferredToolPlacement {
	const normalizeName = options.normalizeName ?? identityToolName;
	const uniqueTools = new Map<string, Tool>();
	for (const tool of context.tools ?? []) uniqueTools.set(normalizeName(tool.name), tool);
	const registrationDeferred = listRegistrationDeferred(uniqueTools);
	const honorRegistration = options.registrationDeferral !== false;

	const deferredNames = new Set(registrationDeferred);
	const loadedNames = new Set<string>();
	const usedNames = new Set<string>();
	for (const message of context.messages) {
		if (message.role === "assistant") {
			// A native search the model ran is a load point, exactly like a marker. It is applied
			// before this message's calls because that is the order the transcript replays: the
			// search items sit immediately ahead of the calls they enabled. Without this, a tool
			// the model found and called reactively would look like it was called with its schema
			// already visible, and would be pulled back into the up-front tools array for the rest
			// of the session -- churning the cached prefix and undoing the deferral it just used.
			for (const step of message.toolSearchSteps ?? []) {
				for (const rawName of step.loadedToolNames) {
					const name = normalizeName(rawName);
					if (usedNames.has(name)) continue;
					deferredNames.add(name);
					loadedNames.add(name);
				}
			}
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const name = normalizeName(block.name);
				usedNames.add(name);
				// Called before any load point covered it, so its schema was already visible.
				if (!loadedNames.has(name)) deferredNames.delete(name);
			}
		} else if (message.role === "toolResult") {
			for (const rawName of message.addedToolNames ?? []) {
				const name = normalizeName(rawName);
				if (usedNames.has(name)) continue;
				deferredNames.add(name);
				loadedNames.add(name);
			}
		}
	}
	for (const name of deferredNames) {
		if (!uniqueTools.has(name)) deferredNames.delete(name);
	}

	// An API with no turn-zero anchor cannot withhold a registered tool's schema without also
	// withholding its name, which would make the tool undiscoverable. Those tools are sent up
	// front and stay that way: a later marker must not pull one back out of the tools array,
	// because the model has already seen it and removing it would churn the cached prefix.
	const unanchored = new Set<string>();
	if (!honorRegistration) {
		for (const name of registrationDeferred) {
			deferredNames.delete(name);
			unanchored.add(name);
		}
	}
	// Registration order keeps the reported names stable across turns.
	const orderNames = (names: ReadonlySet<string>): string[] => [...uniqueTools.keys()].filter((n) => names.has(n));

	if (!options.enabled) {
		// Registration order is preserved rather than reassembled from immediate plus deferred,
		// which would reorder the tools array and invalidate the provider's cached prefix.
		return {
			immediate: [...uniqueTools.values()],
			deferred: new Map(),
			unsupported: orderNames(new Set([...deferredNames, ...unanchored])),
		};
	}

	const immediate: Tool[] = [];
	const promoted: Tool[] = [];
	const deferred = new Map<string, Tool>();
	for (const [name, tool] of uniqueTools) {
		if (deferredNames.has(name)) deferred.set(name, tool);
		else if (honorRegistration && registrationDeferred.has(name)) promoted.push(tool);
		else immediate.push(tool);
	}
	immediate.push(...promoted);

	// Safety floor: never leave a request without an up-front tool while tools are registered,
	// unless the caller supplies a discovery tool that can reach the deferred ones.
	if (options.providesToolSearch !== true && immediate.length === 0 && deferred.size > 0) {
		return {
			immediate: [...uniqueTools.values()],
			deferred: new Map(),
			unsupported: orderNames(new Set([...unanchored, ...deferred.keys()])),
		};
	}
	return { immediate, deferred, unsupported: orderNames(unanchored) };
}

/**
 * Record that schemas deferral would have withheld were sent up front instead, so a silent
 * loss of progressive disclosure is always visible. No-op when nothing was expanded.
 */
export function appendDeferredToolsUnsupportedDiagnostic(
	message: { diagnostics?: AssistantMessageDiagnostic[] },
	model: Pick<Model<Api>, "id" | "provider">,
	deferredCandidates: readonly string[],
): void {
	if (deferredCandidates.length === 0) return;
	appendAssistantMessageDiagnostic(message, {
		type: DEFERRED_TOOLS_UNSUPPORTED_DIAGNOSTIC,
		timestamp: Date.now(),
		details: {
			reason: `${model.provider}/${model.id} does not support deferred tool loading; deferred tool schemas were sent up front`,
			provider: model.provider,
			model: model.id,
			deferredCandidates: [...deferredCandidates],
		},
	});
}

/**
 * Signals that the endpoint does not implement the deferred-tool protocol at all: the field
 * is rejected as unknown, or the item type is unrecognized.
 */
const DEFERRED_TOOL_CAPABILITY_REJECTION =
	/extra inputs are not permitted|not permitted|unsupported|not supported|unrecognized|unexpected (?:field|keyword|argument|property)|unknown (?:field|parameter|argument|property)|does not match any of the expected|invalid[^.]{0,32}\btype\b/i;

/**
 * Signals that the endpoint *does* implement the protocol and could not resolve one name.
 * That is a client-side activation or naming bug, not a capability gap, so it must surface
 * rather than silently downgrade the request.
 */
const DEFERRED_TOOL_RESOLUTION_FAILURE = /not found|does not exist|no such|unresolved|unknown tool\b/i;

/**
 * True only for an unambiguous rejection of the deferred-tool protocol itself: a 400 naming
 * one of `fields` *and* describing it as unknown, extra, or unsupported.
 *
 * A 400 that names a field but reports it as unresolved is deliberately excluded, because it
 * proves the endpoint implements the field. Downgrading there would mask a client bug behind
 * a silent capability loss.
 *
 * Shared so every API applies the same rule to its own field names. `anthropic-messages`
 * carries an equivalent local copy that predates this seam and can adopt it directly.
 */
export function isDeferredToolRejection(error: unknown, fields: RegExp): boolean {
	if (!(error instanceof Error)) return false;
	if ((error as { status?: unknown }).status !== 400) return false;
	if (!fields.test(error.message)) return false;
	if (DEFERRED_TOOL_RESOLUTION_FAILURE.test(error.message)) return false;
	return DEFERRED_TOOL_CAPABILITY_REJECTION.test(error.message);
}

/**
 * Per-process record of endpoints that claimed deferred-tool support and then rejected it.
 *
 * Keyed by provider, model and base URL rather than model alone, because the same model id
 * behind a different gateway is a different implementation. Process-lifetime only: built-in
 * catalog metadata is probe-verified, so this is only reachable for an endpoint that
 * advertises the capability without implementing it.
 */
export function createDeferredToolEndpointRegistry(): {
	disable: (model: Pick<Model<Api>, "id" | "provider" | "baseUrl">) => void;
	isDisabled: (model: Pick<Model<Api>, "id" | "provider" | "baseUrl">) => boolean;
} {
	const disabled = new Set<string>();
	const key = (model: Pick<Model<Api>, "id" | "provider" | "baseUrl">): string =>
		`${model.provider}\u0000${model.id}\u0000${model.baseUrl}`;
	return {
		disable: (model) => {
			disabled.add(key(model));
		},
		isDisabled: (model) => disabled.has(key(model)),
	};
}

/**
 * Record that a tool search revealed deferred schemas, so discovery is measurable separately
 * from execution. This reports what the model was shown; it never authorizes a call, and a
 * tool the model names without a preceding load still executes.
 *
 * Only searches are reported. A marker load is already in the transcript as
 * `ToolResultMessage.addedToolNames`, and it is applied while the *request* is built, so there
 * is no assistant message of its own to carry a diagnostic.
 */
export function appendDeferredToolsLoadedDiagnostic(
	message: { diagnostics?: AssistantMessageDiagnostic[] },
	source: "hosted-search" | "client-search",
	loadedToolNames: readonly string[],
	details?: Record<string, unknown>,
): void {
	if (loadedToolNames.length === 0) return;
	appendAssistantMessageDiagnostic(message, {
		type: DEFERRED_TOOLS_LOADED_DIAGNOSTIC,
		timestamp: Date.now(),
		details: { source, loadedToolNames: [...loadedToolNames], ...details },
	});
}
