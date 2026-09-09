import type { Api, Context, Model, Tool } from "../types.ts";
import { type AssistantMessageDiagnostic, appendAssistantMessageDiagnostic } from "./diagnostics.ts";

type ToolNameNormalizer = (name: string) => string;

const identityToolName: ToolNameNormalizer = (name) => name;

/** Diagnostic emitted when an API sends schemas up front that deferral would have withheld. */
export const DEFERRED_TOOLS_UNSUPPORTED_DIAGNOSTIC = "deferred_tools_unsupported";

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
	 * False when the API can only load a schema at a transcript marker. Registration
	 * deferral has no anchor on turn zero there, so honoring it would hide the tool for good.
	 */
	registrationDeferral?: boolean;
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

	// An API that only loads schemas at a transcript marker has no turn-zero anchor, so a
	// registration-deferred tool that no marker covers would stay hidden for good. Send it up
	// front and report it. A marker-covered tool keeps its anchor and stays deferred.
	const unanchored = new Set<string>();
	if (!honorRegistration) {
		for (const name of registrationDeferred) {
			if (loadedNames.has(name)) continue;
			if (deferredNames.delete(name)) unanchored.add(name);
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

	// Safety floor: never leave a request without an up-front tool while tools are registered.
	if (immediate.length === 0 && deferred.size > 0) {
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
