import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context, Model, Tool } from "../src/types.ts";

interface CapturedTool {
	type?: string;
	name?: string;
	description?: string;
	defer_loading?: boolean;
	tools?: CapturedTool[];
}

interface CapturedInputItem {
	type?: string;
	name?: string;
	namespace?: string;
	call_id?: string | null;
	execution?: string;
	arguments?: unknown;
	tools?: CapturedTool[];
}

interface CapturedParams {
	tools?: CapturedTool[];
	input?: CapturedInputItem[];
}

const mockState = vi.hoisted(() => ({
	createParams: [] as Record<string, unknown>[],
	failNextWith: undefined as Error | undefined,
	searchStep: undefined as { execution: "server" | "client"; callId: string | null; names: string[] } | undefined,
}));

vi.mock("openai", () => {
	async function* createMockStream(): AsyncIterable<ResponseStreamEvent> {
		yield { type: "response.created", sequence_number: 0, response: { id: "resp_test" } } as ResponseStreamEvent;
		const search = mockState.searchStep;
		if (search) {
			yield {
				type: "response.output_item.done",
				sequence_number: 1,
				output_index: 0,
				item: {
					type: "tool_search_call",
					id: "ts_test",
					call_id: search.callId,
					execution: search.execution,
					status: "completed",
					arguments: { query: "deploy" },
				},
			} as ResponseStreamEvent;
			yield {
				type: "response.output_item.done",
				sequence_number: 2,
				output_index: 1,
				item: {
					type: "tool_search_output",
					id: "tso_test",
					call_id: search.callId,
					execution: search.execution,
					status: "completed",
					tools: [
						{
							type: "namespace",
							name: "github-mcp",
							description: "GitHub MCP server",
							tools: search.names.map((name) => ({ type: "function", name, description: name, parameters: {} })),
						},
					],
				},
			} as ResponseStreamEvent;
		}
		yield {
			type: "response.completed",
			sequence_number: 3,
			response: { id: "resp_test", status: "completed", usage: { input_tokens: 10, output_tokens: 5 } },
		} as ResponseStreamEvent;
	}

	class FakeOpenAI {
		responses = {
			create: (params: Record<string, unknown>) => {
				mockState.createParams.push(params);
				const failure = mockState.failNextWith;
				mockState.failNextWith = undefined;
				const promise = Promise.resolve() as unknown as {
					withResponse: () => Promise<{ data: AsyncIterable<ResponseStreamEvent>; response: Response }>;
				};
				promise.withResponse = async () => {
					if (failure) throw failure;
					return {
						data: createMockStream(),
						response: new Response(null, { status: 200 }),
					};
				};
				return promise;
			},
		};
	}

	return { default: FakeOpenAI };
});

/** Shaped like the OpenAI SDK's `BadRequestError`, which carries `status` and `headers`. */
function badRequest(message: string): Error {
	const error = new Error(`400 ${message}`) as Error & { status: number; headers: Headers };
	error.status = 400;
	error.headers = new Headers();
	return error;
}

function makeTool(name: string, deferred?: boolean, namespace?: { name: string; description: string }): Tool {
	return {
		name,
		description: `The ${name} tool`,
		parameters: Type.Object({ value: Type.String() }),
		...(deferred === undefined ? {} : { deferred }),
		...(namespace === undefined ? {} : { namespace }),
	};
}

function turnZero(tools: Tool[]): Context {
	return { messages: [{ role: "user", content: "Hello", timestamp: 1 }], tools };
}

/** Each test needs its own endpoint key, because the rejection downgrade is process-lifetime. */
function openaiModel(baseUrl: string): Model<"openai-responses"> {
	return { ...getModel("openai", "gpt-5.4"), baseUrl };
}

async function run(model: Model<"openai-responses">, context: Context): Promise<AssistantMessage> {
	const s = streamOpenAIResponses(model, context, { apiKey: "sk-test" });
	for await (const _event of s) {
		// Drain; the final message is read from result().
	}
	return await s.result();
}

function params(index: number): CapturedParams {
	return mockState.createParams[index] as unknown as CapturedParams;
}

/** Names whose full schema is sent up front, which is what a cached prefix is made of. */
function immediateNames(index: number): string[] {
	return (params(index).tools ?? [])
		.filter((tool) => tool.type !== "namespace" && tool.type !== "tool_search" && tool.defer_loading !== true)
		.map((tool) => tool.name ?? "");
}

function deferredNames(index: number): string[] {
	return (params(index).tools ?? [])
		.filter((tool) => tool.type !== "namespace" && tool.defer_loading === true)
		.map((tool) => tool.name ?? "");
}

function namespaceEntries(index: number): CapturedTool[] {
	return (params(index).tools ?? []).filter((tool) => tool.type === "namespace");
}

function hasToolSearch(index: number): boolean {
	return (params(index).tools ?? []).some((tool) => tool.type === "tool_search");
}

function diagnosticTypes(message: AssistantMessage): string[] {
	return (message.diagnostics ?? []).map((diagnostic) => diagnostic.type);
}

describe("OpenAI deferred tools on the wire", () => {
	beforeEach(() => {
		mockState.createParams = [];
		mockState.failNextWith = undefined;
		mockState.searchStep = undefined;
	});

	it("declares hosted search alongside the deferred catalog at turn zero", async () => {
		const message = await run(
			openaiModel("https://turn-zero.test/v1"),
			turnZero([makeTool("read"), makeTool("mcp_deploy", true)]),
		);

		expect(immediateNames(0)).toEqual(["read"]);
		expect(deferredNames(0)).toEqual(["mcp_deploy"]);
		expect(hasToolSearch(0)).toBe(true);
		expect(params(0).input?.some((item) => item.type === "additional_tools")).toBe(false);
		expect(diagnosticTypes(message)).toEqual([]);
	});

	it("puts tool_search last so the cacheable prefix does not move", async () => {
		await run(openaiModel("https://order.test/v1"), turnZero([makeTool("read"), makeTool("mcp_deploy", true)]));
		const types = (params(0).tools ?? []).map((tool) => tool.type);

		expect(types.at(-1)).toBe("tool_search");
		expect(types.at(0)).toBe("function");
	});

	it("omits tool_search when nothing is deferred", async () => {
		await run(openaiModel("https://nothing.test/v1"), turnZero([makeTool("read")]));

		expect(hasToolSearch(0)).toBe(false);
		expect(immediateNames(0)).toEqual(["read"]);
	});

	it("groups a declared namespace instead of listing its tools flat", async () => {
		const namespace = { name: "github.mcp", description: "GitHub MCP server" };
		await run(
			openaiModel("https://namespace.test/v1"),
			turnZero([
				makeTool("read"),
				makeTool("mcp_deploy", true, namespace),
				makeTool("mcp_rollback", true, namespace),
			]),
		);

		expect(deferredNames(0)).toEqual([]);
		expect(namespaceEntries(0)).toMatchObject([
			{ type: "namespace", name: "github-mcp", description: "GitHub MCP server" },
		]);
		expect(namespaceEntries(0)[0]?.tools?.map((tool) => tool.name)).toEqual(["mcp_deploy", "mcp_rollback"]);
	});

	it("keeps two servers that sanitize to the same name in separate groups", async () => {
		await run(
			openaiModel("https://collide.test/v1"),
			turnZero([
				makeTool("a_tool", true, { name: "acme/mcp", description: "First" }),
				makeTool("b_tool", true, { name: "acme.mcp", description: "Second" }),
			]),
		);

		expect(namespaceEntries(0).map((entry) => entry.name)).toEqual(["acme-mcp", "acme-mcp-2"]);
	});

	it("records a hosted search step and reports what it loaded", async () => {
		mockState.searchStep = { execution: "server", callId: null, names: ["mcp_deploy"] };
		const message = await run(
			openaiModel("https://hosted.test/v1"),
			turnZero([makeTool("read"), makeTool("mcp_deploy", true)]),
		);

		expect(message.toolSearchSteps).toMatchObject([{ execution: "server", loadedToolNames: ["mcp_deploy"] }]);
		expect(message.toolSearchSteps?.[0]).not.toHaveProperty("callId");
		expect(diagnosticTypes(message)).toEqual(["deferred_tools_loaded"]);
		expect(message.diagnostics?.[0]?.details).toMatchObject({
			source: "hosted-search",
			loadedToolNames: ["mcp_deploy"],
		});
	});

	it("reports a client-run search as client-search", async () => {
		mockState.searchStep = { execution: "client", callId: "ts_call_1", names: ["mcp_deploy"] };
		const message = await run(
			openaiModel("https://client.test/v1"),
			turnZero([makeTool("read"), makeTool("mcp_deploy", true)]),
		);

		// A client search must echo its call id back, unlike a hosted one.
		expect(message.toolSearchSteps).toMatchObject([{ execution: "client", callId: "ts_call_1" }]);
		expect(message.diagnostics?.[0]?.details).toMatchObject({ source: "client-search" });
	});

	it("does not report a marker load as a search", async () => {
		const model = openaiModel("https://marker.test/v1");
		const message = await run(model, {
			messages: [
				{ role: "user", content: "Hello", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: {} }],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5.4",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call_1|fc_1",
					toolName: "read",
					content: [{ type: "text", text: "done" }],
					addedToolNames: ["mcp_deploy"],
					isError: false,
					timestamp: 3,
				},
			],
			tools: [makeTool("read"), makeTool("mcp_deploy", true)],
		});

		// The marker is already in the transcript as `addedToolNames`, and it is applied while
		// this request is built, so there is no search to report on the response it produces.
		expect((params(0).input ?? []).some((item) => item.type === "tool_search_output")).toBe(true);
		expect(message.toolSearchSteps ?? []).toEqual([]);
		expect(diagnosticTypes(message)).not.toContain("deferred_tools_loaded");
	});

	it("replays a recorded search before the call it enabled", async () => {
		const model = openaiModel("https://replay.test/v1");
		mockState.searchStep = { execution: "server", callId: null, names: ["mcp_deploy"] };
		const first = await run(model, turnZero([makeTool("read"), makeTool("mcp_deploy", true)]));
		mockState.searchStep = undefined;

		const context: Context = {
			messages: [
				{ role: "user", content: "Hello", timestamp: 1 },
				{
					...first,
					content: [{ type: "toolCall", id: "call_1|fc_1", name: "mcp_deploy", arguments: {} }],
					stopReason: "toolUse",
				},
				{
					role: "toolResult",
					toolCallId: "call_1|fc_1",
					toolName: "mcp_deploy",
					content: [{ type: "text", text: "done" }],
					isError: false,
					timestamp: 3,
				},
				{ role: "user", content: "Continue", timestamp: 4 },
			],
			tools: [makeTool("read"), makeTool("mcp_deploy", true)],
		};
		await run(model, context);
		const input = params(1).input ?? [];
		const searchIndex = input.findIndex((item) => item.type === "tool_search_call");
		const outputIndex = input.findIndex((item) => item.type === "tool_search_output");
		const callIndex = input.findIndex((item) => item.type === "function_call" && item.name === "mcp_deploy");

		// Without the replay the call would name a tool this request never loaded, and the tool
		// would be pulled back into the up-front array for the rest of the session.
		expect(searchIndex).toBeGreaterThanOrEqual(0);
		expect(searchIndex).toBeLessThan(outputIndex);
		expect(outputIndex).toBeLessThan(callIndex);
		expect(input[searchIndex]?.execution).toBe("server");
		expect(input[searchIndex]).not.toHaveProperty("call_id");
		expect(immediateNames(1)).toEqual(["read"]);
		expect(deferredNames(1)).toEqual(["mcp_deploy"]);
	});

	it("keeps the tools array byte-identical across turns for an unchanged tool set", async () => {
		const model = openaiModel("https://cache.test/v1");
		const tools = [makeTool("read"), makeTool("mcp_deploy", true, { name: "github.mcp", description: "GitHub" })];
		await run(model, turnZero(tools));
		await run(model, {
			messages: [
				{ role: "user", content: "Hello", timestamp: 1 },
				{ role: "user", content: "Again", timestamp: 2 },
			],
			tools,
		});

		expect(JSON.stringify(params(1).tools)).toBe(JSON.stringify(params(0).tools));
	});

	it("drops a replayed search entry whose tool is no longer registered", async () => {
		const model = openaiModel("https://stale.test/v1");
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			toolSearchSteps: [{ execution: "server", loadedToolNames: ["ghost_tool"] }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		};
		await run(model, {
			messages: [
				{ role: "user", content: "Hello", timestamp: 1 },
				assistant,
				{ role: "user", content: "Go", timestamp: 3 },
			],
			tools: [makeTool("read"), makeTool("mcp_deploy", true)],
		});

		// Replaying it would load a schema this request never declared.
		expect((params(0).input ?? []).some((item) => item.type === "tool_search_output")).toBe(false);
	});

	it("downgrades to full schemas when the endpoint rejects the protocol", async () => {
		mockState.failNextWith = badRequest("Extra inputs are not permitted: tools.1.defer_loading");
		const message = await run(
			openaiModel("https://reject.test/v1"),
			turnZero([makeTool("read"), makeTool("mcp_deploy", true)]),
		);

		expect(mockState.createParams).toHaveLength(2);
		expect(immediateNames(1)).toEqual(["read", "mcp_deploy"]);
		expect(hasToolSearch(1)).toBe(false);
		expect(diagnosticTypes(message)).toEqual(["deferred_tools_rejected", "deferred_tools_unsupported"]);
	});

	it("keeps the downgrade for the rest of the process on that endpoint", async () => {
		const model = openaiModel("https://sticky.test/v1");
		mockState.failNextWith = badRequest("Unknown parameter: tools.1.defer_loading");
		await run(model, turnZero([makeTool("read"), makeTool("mcp_deploy", true)]));
		await run(model, turnZero([makeTool("read"), makeTool("mcp_deploy", true)]));

		// A third request would mean the downgrade was forgotten and the 400 is paid again.
		expect(mockState.createParams).toHaveLength(3);
		expect(immediateNames(2)).toEqual(["read", "mcp_deploy"]);
		expect(hasToolSearch(2)).toBe(false);
	});

	it("does not downgrade a 400 that proves the endpoint implements the protocol", async () => {
		mockState.failNextWith = badRequest("Tool 'mcp_deploy' not found in namespace 'github-mcp'");
		const message = await run(
			openaiModel("https://resolve.test/v1"),
			turnZero([makeTool("read"), makeTool("mcp_deploy", true)]),
		);

		// Downgrading here would hide a client activation or naming bug behind a silent
		// capability loss, so the provider's message has to surface unchanged.
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toMatch(/not found/);
		expect(mockState.createParams).toHaveLength(1);
		expect(diagnosticTypes(message)).not.toContain("deferred_tools_rejected");
	});

	it("does not downgrade an unrelated 400", async () => {
		mockState.failNextWith = badRequest("Invalid value for temperature");
		const message = await run(
			openaiModel("https://unrelated.test/v1"),
			turnZero([makeTool("read"), makeTool("mcp_deploy", true)]),
		);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toMatch(/temperature/);
		expect(mockState.createParams).toHaveLength(1);
		expect(diagnosticTypes(message)).not.toContain("deferred_tools_rejected");
	});
});
