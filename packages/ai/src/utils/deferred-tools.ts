import type { Api, Context, Model, Tool } from "../types.ts";
import { type AssistantMessageDiagnostic, appendAssistantMessageDiagnostic } from "./diagnostics.ts";

type ToolNameNormalizer = (name: string) => string;

const identityToolName: ToolNameNormalizer = (name) => name;

/** Diagnostic emitted when a model without deferred loading has to send deferred schemas up front. */
export const DEFERRED_TOOLS_EXPANDED_DIAGNOSTIC = "deferred_tools_expanded";

/** How the current tools split across the request tools array and transcript load points. */
export interface DeferredToolPlacement {
	/** Tools whose schemas are sent up front, registration order first, then promoted tools. */
	immediate: Tool[];
	/** Tools whose schemas are withheld until a transcript load point, keyed by normalized name. */
	deferred: Map<string, Tool>;
	/** Registration-deferred names sent as full schemas because the target model cannot defer. */
	unsupported: string[];
}

/** Normalized names of tools registered with `deferred: true`. */
export function listDeferredToolNames(
	tools: readonly Tool[] | undefined,
	normalizeName: ToolNameNormalizer = identityToolName,
): string[] {
	const names: string[] = [];
	for (const tool of tools ?? []) {
		if (tool.deferred === true) names.push(normalizeName(tool.name));
	}
	return names;
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
 * Registration-deferred names the API cannot honor are returned in `unsupported` with their
 * full schemas kept immediate, so callers can surface a diagnostic instead of silently
 * dropping the tool.
 */
export function splitDeferredTools(context: Context, options: SplitDeferredToolsOptions): DeferredToolPlacement {
	const normalizeName = options.normalizeName ?? identityToolName;
	const uniqueTools = new Map<string, Tool>();
	for (const tool of context.tools ?? []) uniqueTools.set(normalizeName(tool.name), tool);
	const registrationDeferred = new Set(
		listDeferredToolNames(context.tools, normalizeName).filter((name) => uniqueTools.get(name)?.deferred === true),
	);
	const honorRegistration = options.enabled && options.registrationDeferral !== false;
	if (!options.enabled) {
		return { immediate: [...uniqueTools.values()], deferred: new Map(), unsupported: [...registrationDeferred] };
	}
	const unsupported = honorRegistration ? [] : [...registrationDeferred];

	const deferredNames = honorRegistration ? new Set(registrationDeferred) : new Set<string>();
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
		return { immediate: [...deferred.values()], deferred: new Map(), unsupported };
	}
	return { immediate, deferred, unsupported };
}

/**
 * Record that a model without deferred loading received full schemas for deferred tools.
 * No-op when nothing was expanded.
 */
export function appendDeferredToolExpansionDiagnostic(
	message: { diagnostics?: AssistantMessageDiagnostic[] },
	model: Pick<Model<Api>, "id" | "provider">,
	expandedToolNames: readonly string[],
): void {
	if (expandedToolNames.length === 0) return;
	appendAssistantMessageDiagnostic(message, {
		type: DEFERRED_TOOLS_EXPANDED_DIAGNOSTIC,
		timestamp: Date.now(),
		details: {
			reason: `${model.provider}/${model.id} does not support deferred tool loading; deferred tool schemas were sent up front`,
			provider: model.provider,
			model: model.id,
			toolNames: [...expandedToolNames],
		},
	});
}
