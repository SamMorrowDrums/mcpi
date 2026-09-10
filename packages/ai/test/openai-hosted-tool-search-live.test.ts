import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context, Model, Tool, ToolCall } from "../src/types.ts";

/**
 * Credential-gated live probe for hosted tool search on the OpenAI Responses API.
 *
 * Two properties can only be observed against the real endpoint. First, whether the server
 * accepts a replayed `tool_search_call` / `tool_search_output` pair as input on a later turn:
 * the offline wire test asserts mcpi *sends* it, not that OpenAI takes it. Second, whether a
 * namespace actually withholds member names and descriptions from the model, which is a
 * server-side rendering decision and is therefore invisible in the request payload — the
 * request carries the full nested schemas either way, so only the reported input token count
 * can tell the two apart.
 *
 * Skipped unless OPENAI_API_KEY is set. Makes a handful of small billable requests.
 */

const TOKEN = process.env.OPENAI_API_KEY;
/** gpt-5.4 is the first model that serves hosted search; override to probe a later one. */
const MODEL_OVERRIDE = process.env.MCPI_OPENAI_SEARCH_MODEL;
const MODEL_ID = MODEL_OVERRIDE ?? "gpt-5.4";
const NAMESPACE = { name: "catalogue", description: "Read records from the library catalogue." };

/**
 * Each definition carries its own prose. Repeated padding across a large tool list compresses
 * differently and would make the inline-versus-deferred token comparison meaningless.
 */
function makeTool(name: string, detail: string, deferred: boolean, namespaced: boolean): Tool {
	return {
		name,
		description: detail,
		...(deferred ? { deferred: true } : {}),
		...(deferred && namespaced ? { namespace: NAMESPACE } : {}),
		parameters: {
			type: "object",
			properties: {
				entry: { type: "string", description: `Identifier of the ${name} entry to read.` },
				fields: { type: "array", items: { type: "string" }, description: "Field names to include." },
			},
			required: ["entry"],
			additionalProperties: false,
		},
	};
}

const IMMEDIATE_NAME = "catalogue_index";
const DEFERRED_TOOLS: { name: string; detail: string }[] = [
	{
		name: "catalogue_authors",
		detail:
			"Read one author record from the library catalogue. An author record holds the preferred display name, any alternate spellings recorded by cataloguers over the years, birth and death years where they are known, and a short biographical note written for readers browsing the shelves.",
	},
	{
		name: "catalogue_titles",
		detail:
			"Read one title record. A title record holds the work's main title, any subtitle printed on the title page, the uniform title used to gather translations together, and the language the work was originally written in.",
	},
	{
		name: "catalogue_editions",
		detail:
			"Read one edition record. Editions describe a particular printing: the publisher, the city and year of publication, the page count, the binding, and the identifiers such as ISBN that distinguish it from other printings of the same work.",
	},
	{
		name: "catalogue_subjects",
		detail:
			"Read one subject heading. Subject headings place a work within the classification scheme, listing the broader heading it sits under, the narrower headings beneath it, and the related headings a reader might follow sideways.",
	},
	{
		name: "catalogue_shelves",
		detail:
			"Read one shelf location. A shelf location gives the building, the floor, the range, and the call number span held there, so a reader can walk to the right part of the collection without asking at the desk.",
	},
	{
		name: "catalogue_loans",
		detail:
			"Read one loan record. A loan record shows which copy left the building, the date it was taken out, the date it is due back, and how many times the loan has been renewed by the reader who holds it.",
	},
	{
		name: "catalogue_notes",
		detail:
			"Read one cataloguer's note. Notes carry the observations that do not fit the structured fields: a description of an unusual binding, a record of a previous owner's bookplate, or an explanation of why two similar records were kept apart.",
	},
	{
		name: "catalogue_reviews",
		detail:
			"Read one review summary. Review summaries collect what published reviewers said about a work, when the review appeared, which publication carried it, and a brief extract chosen to convey the reviewer's overall judgement.",
	},
];

const DEFERRED_NAMES = DEFERRED_TOOLS.map((tool) => tool.name);

function makeTools(deferred: boolean, namespaced = true): Tool[] {
	return [
		makeTool(
			IMMEDIATE_NAME,
			"List the sections of the library catalogue that are available to read, so a reader knows which section to open next.",
			false,
			false,
		),
		...DEFERRED_TOOLS.map((tool) => makeTool(tool.name, tool.detail, deferred, namespaced)),
	];
}

interface ResponsesPayload {
	tools?: { type?: string; name?: string; defer_loading?: boolean; tools?: { name?: string }[] }[];
	input?: { type?: string; name?: string }[];
}

interface ProbeResult {
	message: AssistantMessage;
	payload: ResponsesPayload | undefined;
	promptTokens: number;
	calls: ToolCall[];
}

async function probe(context: Context, maxTokens: number): Promise<ProbeResult> {
	const base = getModel("openai", "gpt-5.4");
	const model: Model<"openai-responses"> = MODEL_OVERRIDE ? { ...base, id: MODEL_OVERRIDE } : base;
	let payload: ResponsesPayload | undefined;
	const s = streamSimple(model, context, {
		apiKey: TOKEN,
		maxTokens,
		onPayload: (p) => {
			payload = p as ResponsesPayload;
			return p;
		},
	});
	for await (const _ of s) {
		// Drain the stream; the final usage and content are read from result().
	}
	const message = await s.result();
	expect(message.errorMessage).toBeFalsy();
	const { input, cacheRead, cacheWrite } = message.usage;
	return {
		message,
		payload,
		promptTokens: input + cacheRead + cacheWrite,
		calls: message.content.filter((entry) => entry.type === "toolCall"),
	};
}

function turnZero(tools: Tool[]): Context {
	return {
		systemPrompt: "You are a terse assistant. Answer in one short sentence and call no tools.",
		tools,
		messages: [{ role: "user", content: "Say ready.", timestamp: Date.now() }],
	};
}

describe.skipIf(!TOKEN)("OpenAI hosted tool search (live)", () => {
	it("withholds deferred definitions from the model at turn zero", { retry: 2, timeout: 120000 }, async () => {
		const inline = await probe(turnZero(makeTools(false)), 16);
		const flat = await probe(turnZero(makeTools(true, false)), 16);
		const grouped = await probe(turnZero(makeTools(true)), 16);

		expect(inline.payload?.tools?.some((tool) => tool.type === "tool_search")).toBe(false);
		expect(grouped.payload?.tools?.some((tool) => tool.type === "tool_search")).toBe(true);
		expect(grouped.payload?.tools?.find((tool) => tool.type === "namespace")?.tools?.length).toBe(
			DEFERRED_NAMES.length,
		);

		// Deferring at all has to buy something, or the whole mechanism is cost with no benefit.
		expect(inline.promptTokens - flat.promptTokens).toBeGreaterThan(200);
		// A flat deferred function still shows its name and description; a namespace shows only
		// the group summary. This is the assertion the offline test cannot make, because both
		// requests put the same bytes on the wire.
		expect(flat.promptTokens - grouped.promptTokens).toBeGreaterThan(100);
	});

	/**
	 * Reachability without a skill. Nothing in this transcript names the tool the reader needs;
	 * the model has to search for it, and mcpi has to record that search so the next turn can
	 * replay it. If OpenAI rejects the replayed search items, the second request errors here.
	 */
	it("finds and calls a tool no marker named", { retry: 2, timeout: 180000 }, async () => {
		const tools = makeTools(true);
		const target = "catalogue_reviews";
		const question = "What have reviewers written about 'Dune'? Use the catalogue.";
		const context: Context = {
			systemPrompt: "You are a librarian. Search the catalogue for the right tool, then call it.",
			messages: [{ role: "user", content: question, timestamp: Date.now() }],
			tools,
		};
		const found = await probe(context, 1024);

		expect(found.message.toolSearchSteps ?? []).not.toEqual([]);
		expect(found.message.toolSearchSteps?.flatMap((step) => step.loadedToolNames)).toContain(target);
		expect(found.calls.map((entry) => entry.name)).toContain(target);
		expect(found.message.diagnostics?.map((entry) => entry.type)).toContain("deferred_tools_loaded");

		// Second turn: the search that made the call legal is gone from the model's view unless
		// mcpi replays it, and the endpoint has to accept the replayed items as input.
		const call = found.calls.find((entry) => entry.name === target);
		const next = await probe(
			{
				...context,
				messages: [
					...context.messages,
					found.message,
					{
						role: "toolResult",
						toolCallId: call?.id ?? "call_1",
						toolName: target,
						content: [{ type: "text", text: "Reviewers praised its world-building." }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			256,
		);

		expect(next.payload?.input?.some((item) => item.type === "tool_search_call")).toBe(true);
		expect(next.payload?.input?.some((item) => item.type === "tool_search_output")).toBe(true);
		// The tool stays out of the up-front array: a replayed search is a load point, so the
		// splitter must not promote it back and churn the cached prefix.
		expect(next.payload?.tools?.filter((tool) => tool.defer_loading === true).map((tool) => tool.name)).toEqual([]);
		expect(next.payload?.tools?.find((tool) => tool.type === "namespace")?.tools?.length).toBe(DEFERRED_NAMES.length);
	});

	/** The skill path. A marker names the tool, so the model has no reason to search for it. */
	it("loads a marker-named tool without searching", { retry: 2, timeout: 120000 }, async () => {
		const tools = makeTools(true);
		const target = "catalogue_editions";
		const loaded = await probe(
			{
				systemPrompt: "You are a librarian. Call the tool the previous result told you to call.",
				tools,
				messages: [
					{ role: "user", content: "Which publisher printed this edition?", timestamp: Date.now() },
					{
						role: "assistant",
						api: "openai-responses",
						provider: "openai",
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
						content: [{ type: "toolCall", id: "call_load|fc_load", name: IMMEDIATE_NAME, arguments: {} }],
						timestamp: Date.now(),
					},
					{
						role: "toolResult",
						toolCallId: "call_load|fc_load",
						toolName: IMMEDIATE_NAME,
						content: [{ type: "text", text: `Editions are handled by ${target}. Call it now.` }],
						addedToolNames: [target],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			1024,
		);

		// Pushed by the marker, so the model never had to search.
		expect(loaded.payload?.input?.some((item) => item.type === "tool_search_output")).toBe(true);
		expect(loaded.message.toolSearchSteps ?? []).toEqual([]);
		expect(loaded.calls.map((entry) => entry.name)).toContain(target);
	});
});
