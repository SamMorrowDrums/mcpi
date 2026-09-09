import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { githubCopilotOAuth } from "../src/auth/oauth/github-copilot.ts";
import type { OAuthCredential } from "../src/auth/types.ts";
import { getModel, streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context, Model, Tool } from "../src/types.ts";

/**
 * Live regression for deferred tool loading on GitHub Copilot's Anthropic gateway.
 *
 * These requests are billable, so the suite is opt-in: it runs only when
 * `MCPI_LIVE_COPILOT=1` is set, and never in CI. It resolves the signed-in Copilot
 * credential through the normal mcpi auth path rather than taking a pasted token, so
 * the secret is never copied into an environment variable or a log line.
 *
 * Every request caps output at `MAX_OUTPUT_TOKENS`; the assertions are about the
 * request shape and the reported *input* usage, not the completion.
 */

const LIVE = process.env.MCPI_LIVE_COPILOT === "1";
const MODEL_ID = "claude-opus-5";
const MAX_OUTPUT_TOKENS = 16;

interface Auth {
	apiKey: string;
	baseUrl: string;
}

/** Read the credential mcpi already stored for `github-copilot`, refreshing it if stale. */
async function resolveAuth(): Promise<Auth> {
	const dir = process.env.MCPI_AGENT_DIR ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
	const authPath = process.env.MCPI_AGENT_DIR ? join(dir, "auth.json") : join(dir, "mcpi", "auth.json");
	if (!existsSync(authPath)) throw new Error(`No stored credentials at ${authPath}`);

	const stored = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, OAuthCredential | undefined>;
	let credential = stored["github-copilot"];
	if (!credential || credential.type !== "oauth") throw new Error("No github-copilot OAuth credential stored");

	if (credential.expires && credential.expires <= Date.now()) {
		credential = await githubCopilotOAuth.refresh(credential, AbortSignal.timeout(30000));
	}
	const auth = await githubCopilotOAuth.toAuth(credential);
	if (!auth.apiKey || !auth.baseUrl) throw new Error("Copilot credential did not yield an endpoint");
	return { apiKey: auth.apiKey, baseUrl: auth.baseUrl };
}

let auth: Auth;

/**
 * A realistic catalog tool. The descriptions are long on purpose: a deferred definition
 * only saves context if it was substantial to begin with, so a trivial stub would make the
 * measurement meaningless.
 */
function makeTool(name: string, deferred?: boolean): Tool {
	const topic = name.replace("catalog_", "");
	return {
		name,
		description: [
			`Look up and edit ${topic} records in the community library catalog.`,
			`Use this to find a ${topic} entry, add a new one, correct the details of an existing one, or withdraw one that is no longer part of the collection.`,
			`Reads return the catalog entry with its title, contributors, publication year, shelf location, lending status, and the date the record was last reviewed by a librarian.`,
			`Writes are checked against the catalog style guide, saved to the shared catalog, and noted in the change history with the name of the librarian making the change.`,
			`Prefer looking a record up before editing it so the caller can confirm the details, and pass the full catalog identifier rather than just a title, because several editions can share a title.`,
			`Withdrawing a record is only possible once every copy has been returned and no reading list still points at it.`,
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				target: {
					type: "string",
					description: `Full catalog identifier of the ${topic} record, in the form branch/collection/record.`,
				},
				mode: {
					type: "string",
					enum: ["create", "read", "update", "withdraw"],
					description: "What to do with the catalog record.",
				},
				options: {
					type: "object",
					description: "Extra options such as which fields to return, sort order, or a preview-only flag.",
					additionalProperties: true,
				},
			},
			required: ["target"],
			additionalProperties: false,
		},
		...(deferred ? { deferred: true } : {}),
	};
}

const LOADER = "catalog_books";
const ACTIVATED = [
	"catalog_authors",
	"catalog_periodicals",
	"catalog_audiobooks",
	"catalog_maps",
	"catalog_photographs",
	"catalog_sheet_music",
	"catalog_reading_lists",
	"catalog_branches",
	"catalog_events",
	"catalog_donations",
	"catalog_memberships",
];

const SYSTEM_PROMPT =
	"You are a helpful assistant for a community library. Answer in one short sentence. Do not call any tools unless the user asks you to look something up or change a record.";

function model(): Model<"anthropic-messages"> {
	return { ...getModel("github-copilot", MODEL_ID), baseUrl: auth.baseUrl } as Model<"anthropic-messages">;
}

/** Turn zero: one user message, no tool result, so only registration deferral can hide anything. */
function turnZeroContext(registrationDeferred: boolean): Context {
	return {
		systemPrompt: SYSTEM_PROMPT,
		tools: [makeTool(LOADER), ...ACTIVATED.map((name) => makeTool(name, registrationDeferred))],
		messages: [
			{
				role: "user",
				content: "Great, thanks. Please summarise what you can help me with in one sentence.",
				timestamp: Date.now(),
			},
		],
	};
}

/** A transcript whose single tool result activates the deferred tools via `addedToolNames`. */
function activationContext(addedToolNames: string[]): Context {
	return {
		systemPrompt: SYSTEM_PROMPT,
		tools: [makeTool(LOADER), ...ACTIVATED.map((name) => makeTool(name, true))],
		messages: [
			{ role: "user", content: "I am tidying up the catalog today. Load the catalog tools.", timestamp: Date.now() },
			{
				role: "assistant",
				api: "anthropic-messages",
				provider: "github-copilot",
				model: MODEL_ID,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "call_load", name: LOADER, arguments: { target: "all" } }],
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "call_load",
				toolName: LOADER,
				content: [
					{
						type: "text",
						text: `The catalog tools for ${ACTIVATED.map((n) => n.replace("catalog_", "")).join(", ")} are now available.`,
					},
				],
				addedToolNames,
				isError: false,
				timestamp: Date.now(),
			},
			{
				role: "user",
				content: "Great, thanks. Please summarise what you can help me with in one sentence.",
				timestamp: Date.now(),
			},
		],
	};
}

interface WirePayload {
	tools?: { name: string; defer_loading?: boolean }[];
	messages?: unknown[];
	system?: unknown;
}

interface ProbeResult {
	message: AssistantMessage;
	payload: WirePayload;
	deferred: string[];
	toolOrder: string[];
	/**
	 * Total prompt tokens the gateway charged for.
	 *
	 * `usage.input` alone is useless here: the Copilot gateway caches the prompt
	 * prefix automatically, so almost every prompt token is reported under
	 * `cacheRead` or `cacheWrite` and `input` sits at 2 whether or not anything was
	 * deferred. Summing the three is what actually shows the context saving.
	 */
	promptTokens: number;
}

/** Issue one bounded live request, capturing the exact wire payload alongside the result. */
async function probe(context: Context, mutate?: (payload: WirePayload) => WirePayload): Promise<ProbeResult> {
	let payload: WirePayload | undefined;
	const stream = streamSimple(model(), context, {
		apiKey: auth.apiKey,
		maxTokens: MAX_OUTPUT_TOKENS,
		onPayload: (raw) => {
			payload = raw as WirePayload;
			return mutate ? mutate(payload) : payload;
		},
	});
	for await (const _ of stream) {
		// Drain; only the final message and usage matter.
	}
	const message = await stream.result();
	if (!payload) throw new Error("Expected a wire payload");
	const usage = message.usage;
	return {
		message,
		payload,
		deferred: (payload.tools ?? []).filter((tool) => tool.defer_loading).map((tool) => tool.name),
		toolOrder: (payload.tools ?? []).map((tool) => tool.name),
		promptTokens: usage.input + usage.cacheRead + usage.cacheWrite,
	};
}

describe.skipIf(!LIVE)("GitHub Copilot deferred tools (live)", () => {
	beforeAll(async () => {
		auth = await resolveAuth();
	});

	it(
		"hides registration-deferred schemas at turn zero and is accepted by the gateway",
		{ timeout: 120000 },
		async () => {
			const inline = await probe(turnZeroContext(false));
			expect(inline.message.errorMessage).toBeFalsy();
			expect(inline.deferred).toEqual([]);

			const deferred = await probe(turnZeroContext(true));
			expect(deferred.message.errorMessage).toBeFalsy();
			expect(deferred.deferred.sort()).toEqual([...ACTIVATED].sort());
			// No load point exists on turn zero, so nothing may be referenced back yet.
			expect(JSON.stringify(deferred.payload.messages)).not.toContain("tool_reference");

			// The gateway, not the client, is what withholds the schemas, so the saving has to
			// show up in what the gateway charges for.
			expect(deferred.promptTokens).toBeLessThan(inline.promptTokens);
			expect(inline.promptTokens - deferred.promptTokens).toBeGreaterThan(500);
			console.log(
				`[live] turn-0 prompt tokens: inline=${inline.promptTokens} deferred=${deferred.promptTokens} ` +
					`(${(inline.promptTokens / deferred.promptTokens).toFixed(1)}x)`,
			);
		},
	);

	it("activates deferred tools through addedToolNames without an error", { timeout: 120000 }, async () => {
		const result = await probe(activationContext(ACTIVATED));
		expect(result.message.errorMessage).toBeFalsy();
		expect(result.deferred.sort()).toEqual([...ACTIVATED].sort());
		expect(JSON.stringify(result.payload.messages)).toContain("tool_reference");
		// Activation must not downgrade the request: no capability rejection was seen,
		// so no diagnostic should have been recorded.
		expect(result.message.diagnostics ?? []).toEqual([]);
		console.log(`[live] activation prompt tokens: ${result.promptTokens}`);
	});

	it("keeps the cached tool prefix stable across activation", { timeout: 180000 }, async () => {
		const turnZero = await probe(turnZeroContext(true));
		const first = await probe(activationContext(ACTIVATED));
		const second = await probe(activationContext(ACTIVATED));

		// Cache hits are keyed on an exact prefix. If activation reorders the tool array,
		// flips a flag, or rewrites the system prompt, every prefix cached before
		// activation is invalidated and the saving disappears.
		expect(first.toolOrder).toEqual(turnZero.toolOrder);
		expect(first.deferred).toEqual(turnZero.deferred);
		expect(JSON.stringify(first.payload.system)).toEqual(JSON.stringify(turnZero.payload.system));
		expect(second.toolOrder).toEqual(first.toolOrder);

		// Repeating an identical request must read the prefix back out of cache rather
		// than re-writing it.
		expect(second.message.usage.cacheRead).toBeGreaterThan(0);
		console.log(
			`[live] cache: first write=${first.message.usage.cacheWrite} read=${first.message.usage.cacheRead}, ` +
				`second write=${second.message.usage.cacheWrite} read=${second.message.usage.cacheRead}`,
		);
	});

	it("surfaces an unresolvable tool reference loudly instead of downgrading", { timeout: 120000 }, async () => {
		const result = await probe(activationContext(ACTIVATED), (payload) => {
			const clone = JSON.parse(JSON.stringify(payload)) as WirePayload;
			// Point one reference at a tool that was never declared. The endpoint supports
			// references, so this is a client naming bug and must reach the caller intact.
			const patched = JSON.stringify(clone).replace('"tool_name":"catalog_authors"', '"tool_name":"no_such_tool"');
			return JSON.parse(patched) as WirePayload;
		});

		expect(result.message.errorMessage).toBeTruthy();
		console.log(`[live] unknown reference error: ${result.message.errorMessage}`);
		// Not swallowed and not converted into a capability downgrade.
		expect(result.message.diagnostics?.some((d) => d.type === "deferred_tools_rejected")).toBeFalsy();
	});

	it("reports the unsupported-model fallback without a billable request", async () => {
		// claude-sonnet-4.6 is deliberately outside the verified allowlist.
		const unsupported = getModel("github-copilot", "claude-sonnet-4.6");
		expect(unsupported.compat?.supportsToolReferences).toBeUndefined();

		const stream = streamSimple({ ...unsupported, baseUrl: "http://127.0.0.1:9" }, turnZeroContext(true), {
			apiKey: "unused",
			maxTokens: MAX_OUTPUT_TOKENS,
		});
		const message = await stream.result();
		expect(message.diagnostics).toMatchObject([
			{ type: "deferred_tools_unsupported", details: { provider: "github-copilot" } },
		]);
	});
});
