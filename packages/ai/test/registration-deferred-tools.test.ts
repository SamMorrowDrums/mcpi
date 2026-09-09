import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Api, AssistantMessage, Context, Model, Tool, ToolResultMessage, UserMessage } from "../src/types.ts";
import { DEFERRED_TOOLS_EXPANDED_DIAGNOSTIC, splitDeferredTools } from "../src/utils/deferred-tools.ts";
import type { AssistantMessageDiagnostic } from "../src/utils/diagnostics.ts";

interface AnthropicToolPayload {
	name: string;
	description?: string;
	defer_loading?: boolean;
	cache_control?: unknown;
}

interface AnthropicContentBlock {
	type: string;
	text?: string;
	tool_use_id?: string;
	content?: string | Array<{ type: string; tool_name?: string }>;
}

interface AnthropicPayload {
	system?: Array<{ type: string; text: string }>;
	tools?: AnthropicToolPayload[];
	messages: Array<{ content: string | AnthropicContentBlock[] }>;
}

interface OpenAIPayload {
	tools?: Array<{ name?: string; function?: { name: string } }>;
	input?: Array<{ type?: string; name?: string; namespace?: string; tools?: Array<{ name: string }> }>;
}

interface KimiPayload {
	tools?: Array<{ function: { name: string } }>;
	messages: Array<{ role: string; tools?: Array<{ function: { name: string } }> }>;
}

class PayloadCaptured extends Error {}

function makeTool(name: string, deferred?: boolean): Tool {
	return {
		name,
		description: `The ${name} tool`,
		parameters: Type.Object({ value: Type.String() }),
		...(deferred === undefined ? {} : { deferred }),
	};
}

function makeUserMessage(timestamp: number): UserMessage {
	return { role: "user", content: "Hello", timestamp };
}

function makeAssistantToolCall(
	name: string,
	options: { id?: string; timestamp?: number; model?: string; namespace?: string } = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: options.id ?? "call_1",
				name,
				arguments: {},
				...(options.namespace === undefined ? {} : { namespace: options.namespace }),
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: options.model ?? "claude-opus-4-6",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: options.timestamp ?? 2,
	};
}

function makeToolResult(
	addedToolNames: string[],
	options: { toolCallId?: string; toolName?: string; timestamp?: number } = {},
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: options.toolCallId ?? "call_1",
		toolName: options.toolName ?? "tool_search",
		content: [{ type: "text", text: "done" }],
		addedToolNames,
		isError: false,
		timestamp: options.timestamp ?? 3,
	};
}

/** Turn zero: one user message, nothing loaded yet. */
function turnZero(tools: Tool[]): Context {
	return { systemPrompt: "You are a test agent.", messages: [makeUserMessage(1)], tools };
}

/** A `tool_search` call whose result loads `addedToolNames`. */
function afterLoad(tools: Tool[], addedToolNames: string[]): Context {
	return {
		systemPrompt: "You are a test agent.",
		messages: [
			makeUserMessage(1),
			makeAssistantToolCall("tool_search"),
			makeToolResult(addedToolNames),
			makeUserMessage(4),
		],
		tools,
	};
}

async function capture<T>(
	model: Model<Api>,
	context: Context,
	apiKey = "fake-key",
): Promise<{ payload: T; message: AssistantMessage }> {
	let captured: T | undefined;
	const stream = streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, context, {
		apiKey,
		onPayload: (payload) => {
			captured = payload as T;
			throw new PayloadCaptured();
		},
	});
	const message = await stream.result();
	if (!captured) throw new Error("Expected payload capture");
	return { payload: captured, message };
}

async function capturePayload<T>(model: Model<Api>, context: Context, apiKey = "fake-key"): Promise<T> {
	return (await capture<T>(model, context, apiKey)).payload;
}

function toolNames(payload: AnthropicPayload): string[] {
	return (payload.tools ?? []).map((tool) => tool.name);
}

function deferredToolNames(payload: AnthropicPayload): string[] {
	return (payload.tools ?? []).filter((tool) => tool.defer_loading === true).map((tool) => tool.name);
}

function openAIToolNames(payload: OpenAIPayload): string[] {
	return (payload.tools ?? []).map((tool) => tool.name ?? tool.function?.name ?? "");
}

function findToolResultContent(payload: AnthropicPayload): AnthropicContentBlock[] {
	for (const message of payload.messages) {
		if (typeof message.content !== "string" && message.content.some((block) => block.type === "tool_result")) {
			return message.content;
		}
	}
	throw new Error("No tool result in payload");
}

function toolReferenceNames(payload: AnthropicPayload): string[] {
	const result = findToolResultContent(payload).find((block) => block.type === "tool_result");
	const content = result?.content;
	if (!Array.isArray(content)) return [];
	return content.flatMap((block) => (block.type === "tool_reference" ? [block.tool_name ?? ""] : []));
}

function expansionDiagnostics(message: AssistantMessage): AssistantMessageDiagnostic[] {
	return (message.diagnostics ?? []).filter((diagnostic) => diagnostic.type === DEFERRED_TOOLS_EXPANDED_DIAGNOSTIC);
}

const anthropicDeferring = getModel("anthropic", "claude-opus-4-6");

function makeKimiModel(): Model<"openai-completions"> {
	return {
		id: "kimi-deferred-tools",
		name: "Kimi Deferred Tools",
		api: "openai-completions",
		provider: "moonshotai",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat: { deferredToolsMode: "kimi" },
	};
}

describe("registration-deferred tools", () => {
	it("withholds registration-deferred schemas on turn zero while keeping membership", async () => {
		const payload = await capturePayload<AnthropicPayload>(
			anthropicDeferring,
			turnZero([makeTool("read"), makeTool("mcp_deploy", true)]),
		);

		expect(toolNames(payload)).toEqual(["read", "mcp_deploy"]);
		expect(deferredToolNames(payload)).toEqual(["mcp_deploy"]);
		expect(payload.messages).toHaveLength(1);
	});

	// Mutation guard: dropping the registration flag must be the only thing that changes the wire shape.
	it("sends every schema up front once the registration flag is removed", async () => {
		const tools = [makeTool("read"), makeTool("mcp_deploy", true)];
		const deferredPayload = await capturePayload<AnthropicPayload>(anthropicDeferring, turnZero(tools));
		const plainPayload = await capturePayload<AnthropicPayload>(
			anthropicDeferring,
			turnZero(tools.map(({ deferred: _deferred, ...tool }) => tool)),
		);

		expect(deferredToolNames(plainPayload)).toEqual([]);
		expect(toolNames(plainPayload)).toEqual(toolNames(deferredPayload));
		expect(plainPayload.system).toEqual(deferredPayload.system);
	});

	it("keeps the immediate prefix and tool order stable when a call promotes a deferred tool", async () => {
		const tools = [makeTool("mcp_a", true), makeTool("read"), makeTool("mcp_c", true)];
		const before = await capturePayload<AnthropicPayload>(anthropicDeferring, turnZero(tools));
		const after = await capturePayload<AnthropicPayload>(anthropicDeferring, {
			systemPrompt: "You are a test agent.",
			messages: [
				makeUserMessage(1),
				makeAssistantToolCall("mcp_a"),
				makeToolResult([], { toolName: "mcp_a" }),
				makeUserMessage(4),
			],
			tools,
		});

		expect(toolNames(before)).toEqual(["read", "mcp_a", "mcp_c"]);
		expect(deferredToolNames(before)).toEqual(["mcp_a", "mcp_c"]);
		// Promotion appends after the registration-immediate tools, so the order never shifts.
		expect(toolNames(after)).toEqual(["read", "mcp_a", "mcp_c"]);
		expect(deferredToolNames(after)).toEqual(["mcp_c"]);
	});

	it("keeps system prompt and tool bytes identical when a marker loads a tool", async () => {
		const tools = [makeTool("read"), makeTool("mcp_deploy", true)];
		const before = await capturePayload<AnthropicPayload>(anthropicDeferring, turnZero(tools));
		const after = await capturePayload<AnthropicPayload>(anthropicDeferring, afterLoad(tools, ["mcp_deploy"]));

		expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools));
		expect(JSON.stringify(after.system)).toBe(JSON.stringify(before.system));
	});

	it("emits a tool_reference when a marker loads a registration-deferred tool", async () => {
		const payload = await capturePayload<AnthropicPayload>(
			anthropicDeferring,
			afterLoad([makeTool("read"), makeTool("mcp_deploy", true)], ["mcp_deploy"]),
		);

		expect(deferredToolNames(payload)).toEqual(["mcp_deploy"]);
		expect(toolReferenceNames(payload)).toEqual(["mcp_deploy"]);
	});

	it("promotes a registration-deferred tool the model called before any load point", async () => {
		const payload = await capturePayload<AnthropicPayload>(anthropicDeferring, {
			messages: [
				makeUserMessage(1),
				makeAssistantToolCall("mcp_deploy"),
				makeToolResult([], { toolName: "mcp_deploy" }),
				makeUserMessage(4),
			],
			tools: [makeTool("read"), makeTool("mcp_deploy", true)],
		});

		expect(toolNames(payload)).toEqual(["read", "mcp_deploy"]);
		expect(deferredToolNames(payload)).toEqual([]);
	});

	it("keeps a promoted tool immediate when a later marker names it again", async () => {
		const payload = await capturePayload<AnthropicPayload>(anthropicDeferring, {
			messages: [
				makeUserMessage(1),
				makeAssistantToolCall("mcp_deploy"),
				makeToolResult([], { toolName: "mcp_deploy" }),
				makeAssistantToolCall("tool_search", { id: "call_2", timestamp: 4 }),
				makeToolResult(["mcp_deploy"], { toolCallId: "call_2", timestamp: 5 }),
				makeUserMessage(6),
			],
			tools: [makeTool("read"), makeTool("mcp_deploy", true)],
		});

		expect(deferredToolNames(payload)).toEqual([]);
		expect(toolReferenceNames(payload)).toEqual([]);
	});

	it("keeps a tool deferred when the model calls it after its load point", async () => {
		const payload = await capturePayload<AnthropicPayload>(anthropicDeferring, {
			messages: [
				makeUserMessage(1),
				makeAssistantToolCall("tool_search"),
				makeToolResult(["mcp_deploy"]),
				makeAssistantToolCall("mcp_deploy", { id: "call_2", timestamp: 4 }),
				makeToolResult([], { toolCallId: "call_2", toolName: "mcp_deploy", timestamp: 5 }),
				makeUserMessage(6),
			],
			tools: [makeTool("read"), makeTool("mcp_deploy", true)],
		});

		expect(deferredToolNames(payload)).toEqual(["mcp_deploy"]);
		expect(toolReferenceNames(payload)).toEqual(["mcp_deploy"]);
	});

	it("ignores markers for names that are not registered", async () => {
		const payload = await capturePayload<AnthropicPayload>(
			anthropicDeferring,
			afterLoad([makeTool("read"), makeTool("mcp_deploy", true)], ["ghost_tool"]),
		);

		expect(toolNames(payload)).toEqual(["read", "mcp_deploy"]);
		expect(deferredToolNames(payload)).toEqual(["mcp_deploy"]);
		expect(toolReferenceNames(payload)).toEqual([]);
	});

	it("keeps every tool immediate when all of them are registration-deferred", async () => {
		const tools = [makeTool("mcp_a", true), makeTool("mcp_b", true)];
		const anthropic = await capturePayload<AnthropicPayload>(anthropicDeferring, turnZero(tools));
		const openai = await capturePayload<OpenAIPayload>(getModel("openai", "gpt-5.4"), turnZero(tools));

		expect(toolNames(anthropic)).toEqual(["mcp_a", "mcp_b"]);
		expect(deferredToolNames(anthropic)).toEqual([]);
		expect(openAIToolNames(openai)).toEqual(["mcp_a", "mcp_b"]);
	});

	it("withholds registration-deferred OpenAI schemas until an additional_tools load point", async () => {
		const tools = [makeTool("read"), makeTool("mcp_deploy", true)];
		const before = await capturePayload<OpenAIPayload>(getModel("openai", "gpt-5.4"), turnZero(tools));
		const after = await capturePayload<OpenAIPayload>(
			getModel("openai", "gpt-5.4"),
			afterLoad(tools, ["mcp_deploy"]),
		);
		const additional = (after.input ?? []).find((item) => item.type === "additional_tools");

		expect(openAIToolNames(before)).toEqual(["read"]);
		expect((before.input ?? []).some((item) => item.type === "additional_tools")).toBe(false);
		expect(openAIToolNames(after)).toEqual(["read"]);
		expect(additional?.tools?.map((tool) => tool.name)).toEqual(["mcp_deploy"]);
	});

	it("replays the namespace of a registration-deferred call across a model switch", async () => {
		const context: Context = {
			messages: [
				makeUserMessage(1),
				makeAssistantToolCall("tool_search"),
				makeToolResult(["mcp_deploy"]),
				{
					...makeAssistantToolCall("mcp_deploy", {
						id: "call_2|fc_2",
						timestamp: 4,
						namespace: "mcp",
					}),
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5.5",
				},
				makeToolResult([], { toolCallId: "call_2|fc_2", toolName: "mcp_deploy", timestamp: 5 }),
				makeUserMessage(6),
			],
			tools: [makeTool("read"), makeTool("mcp_deploy", true)],
		};
		const payload = await capturePayload<OpenAIPayload>(getModel("openai", "gpt-5.4"), context);
		const call = (payload.input ?? []).find((item) => item.type === "function_call" && item.name === "mcp_deploy");

		expect(openAIToolNames(payload)).toEqual(["read"]);
		expect(call?.namespace).toBe("mcp");
	});

	it("carries registration deferral across an OpenAI to Anthropic handoff", async () => {
		const context = afterLoad([makeTool("read"), makeTool("mcp_deploy", true)], ["mcp_deploy"]);
		const assistant = context.messages[1] as AssistantMessage;
		assistant.api = "openai-responses";
		assistant.provider = "openai";
		assistant.model = "gpt-5.4";

		const payload = await capturePayload<AnthropicPayload>(anthropicDeferring, context);

		expect(deferredToolNames(payload)).toEqual(["mcp_deploy"]);
		expect(toolReferenceNames(payload)).toEqual(["mcp_deploy"]);
	});

	it("sends registration-deferred schemas up front on Kimi, which has no turn-zero anchor", async () => {
		const model = makeKimiModel();
		const tools = [makeTool("read"), makeTool("mcp_deploy", true)];
		const payload = await capturePayload<KimiPayload>(model, turnZero(tools));

		expect(payload.tools?.map((tool) => tool.function.name)).toEqual(["read", "mcp_deploy"]);
		expect(payload.messages.some((message) => message.tools !== undefined)).toBe(false);
	});

	it("still loads Kimi schemas at a transcript marker", async () => {
		const tools = [makeTool("read"), makeTool("mcp_deploy")];
		const payload = await capturePayload<KimiPayload>(makeKimiModel(), afterLoad(tools, ["mcp_deploy"]));
		const injected = payload.messages.find((message) => message.tools !== undefined);

		expect(payload.tools?.map((tool) => tool.function.name)).toEqual(["read"]);
		expect(injected?.tools?.map((tool) => tool.function.name)).toEqual(["mcp_deploy"]);
	});

	it("does not inject a Kimi schema for a tool the model already used", async () => {
		const payload = await capturePayload<KimiPayload>(makeKimiModel(), {
			messages: [
				makeUserMessage(1),
				makeAssistantToolCall("mcp_deploy"),
				makeToolResult(["mcp_deploy"], { toolName: "mcp_deploy" }),
				makeUserMessage(4),
			],
			tools: [makeTool("read"), makeTool("mcp_deploy")],
		});

		expect(payload.tools?.map((tool) => tool.function.name)).toEqual(["read", "mcp_deploy"]);
		expect(payload.messages.some((message) => message.tools !== undefined)).toBe(false);
	});

	describe("model overrides", () => {
		it("honors an explicit Anthropic supportsToolReferences override", async () => {
			const model: Model<"anthropic-messages"> = {
				...anthropicDeferring,
				provider: "anthropic-proxy",
				compat: { supportsToolReferences: true },
			};
			const payload = await capturePayload<AnthropicPayload>(
				model,
				turnZero([makeTool("read"), makeTool("mcp_deploy", true)]),
			);

			expect(deferredToolNames(payload)).toEqual(["mcp_deploy"]);
		});

		it("honors supportsToolReferences on a GitHub Copilot Claude model", async () => {
			const model: Model<"anthropic-messages"> = {
				...getModel("github-copilot", "claude-opus-5"),
				compat: { ...getModel("github-copilot", "claude-opus-5").compat, supportsToolReferences: true },
			};
			const { payload, message } = await capture<AnthropicPayload>(
				model,
				afterLoad([makeTool("read"), makeTool("mcp_deploy", true)], ["mcp_deploy"]),
			);

			expect(deferredToolNames(payload)).toEqual(["mcp_deploy"]);
			expect(toolReferenceNames(payload)).toEqual(["mcp_deploy"]);
			expect(expansionDiagnostics(message)).toEqual([]);
		});

		it("honors an explicit OpenAI tool-search override", async () => {
			const model: Model<"openai-responses"> = {
				...getModel("openai", "gpt-5.4"),
				provider: "openai-proxy",
				compat: { supportsAdditionalTools: false, supportsToolSearch: true },
			};
			const payload = await capturePayload<OpenAIPayload>(
				model,
				afterLoad([makeTool("read"), makeTool("mcp_deploy", true)], ["mcp_deploy"]),
			);
			const searchOutput = (payload.input ?? []).find((item) => item.type === "tool_search_output");

			expect(openAIToolNames(payload)).toEqual(["read"]);
			expect(searchOutput?.tools?.map((tool) => tool.name)).toEqual(["mcp_deploy"]);
		});
	});

	describe("unsupported models", () => {
		it("expands deferred schemas and reports a diagnostic on Anthropic Haiku", async () => {
			const { payload, message } = await capture<AnthropicPayload>(
				getModel("anthropic", "claude-haiku-4-5"),
				turnZero([makeTool("read"), makeTool("mcp_deploy", true)]),
			);

			expect(toolNames(payload)).toEqual(["read", "mcp_deploy"]);
			expect(deferredToolNames(payload)).toEqual([]);
			expect(expansionDiagnostics(message)).toMatchObject([
				{
					type: DEFERRED_TOOLS_EXPANDED_DIAGNOSTIC,
					details: { provider: "anthropic", model: "claude-haiku-4-5", toolNames: ["mcp_deploy"] },
				},
			]);
		});

		it("reports a diagnostic on an OpenAI Responses model without deferred loading", async () => {
			const { payload, message } = await capture<OpenAIPayload>(
				getModel("openai", "gpt-5.2"),
				turnZero([makeTool("read"), makeTool("mcp_deploy", true)]),
			);

			expect(openAIToolNames(payload)).toEqual(["read", "mcp_deploy"]);
			expect(expansionDiagnostics(message)).toHaveLength(1);
		});

		it("reports a diagnostic on a Completions provider without deferred loading", async () => {
			const { payload, message } = await capture<KimiPayload>(
				getModel("groq", "llama-3.3-70b-versatile"),
				turnZero([makeTool("read"), makeTool("mcp_deploy", true)]),
			);

			expect(payload.tools?.map((tool) => tool.function.name)).toEqual(["read", "mcp_deploy"]);
			expect(expansionDiagnostics(message)).toHaveLength(1);
		});

		it("reports a diagnostic on Kimi, whose deferral only works from a transcript marker", async () => {
			const { payload, message } = await capture<KimiPayload>(
				makeKimiModel(),
				turnZero([makeTool("read"), makeTool("mcp_deploy", true)]),
			);

			expect(payload.tools?.map((tool) => tool.function.name)).toEqual(["read", "mcp_deploy"]);
			expect(expansionDiagnostics(message)).toHaveLength(1);
			expect(expansionDiagnostics(message)[0]?.details?.toolNames).toEqual(["mcp_deploy"]);
		});

		it("stays silent when nothing was registered as deferred", async () => {
			const { message } = await capture<AnthropicPayload>(
				getModel("anthropic", "claude-haiku-4-5"),
				turnZero([makeTool("read"), makeTool("write")]),
			);

			expect(expansionDiagnostics(message)).toEqual([]);
		});

		it("stays silent when the model supports deferred loading", async () => {
			const { message } = await capture<AnthropicPayload>(
				anthropicDeferring,
				turnZero([makeTool("read"), makeTool("mcp_deploy", true)]),
			);

			expect(expansionDiagnostics(message)).toEqual([]);
		});
	});

	describe("splitDeferredTools", () => {
		it("reports registration-deferred names as unsupported when deferral is disabled", () => {
			const placement = splitDeferredTools(turnZero([makeTool("read"), makeTool("mcp_deploy", true)]), {
				enabled: false,
			});

			expect(placement.immediate.map((tool) => tool.name)).toEqual(["read", "mcp_deploy"]);
			expect(placement.deferred.size).toBe(0);
			expect(placement.unsupported).toEqual(["mcp_deploy"]);
		});

		it("reports no unsupported names when deferral is enabled", () => {
			const placement = splitDeferredTools(turnZero([makeTool("read"), makeTool("mcp_deploy", true)]), {
				enabled: true,
			});

			expect(placement.immediate.map((tool) => tool.name)).toEqual(["read"]);
			expect([...placement.deferred.keys()]).toEqual(["mcp_deploy"]);
			expect(placement.unsupported).toEqual([]);
		});

		it("applies the normalizer to registration metadata", () => {
			const placement = splitDeferredTools(turnZero([makeTool("read"), makeTool("mcp_deploy", true)]), {
				enabled: true,
				normalizeName: (name) => name.toUpperCase(),
			});

			expect([...placement.deferred.keys()]).toEqual(["MCP_DEPLOY"]);
		});

		it("keeps registration-deferred tools immediate for APIs that only load at a marker", () => {
			const placement = splitDeferredTools(turnZero([makeTool("read"), makeTool("mcp_deploy", true)]), {
				enabled: true,
				registrationDeferral: false,
			});

			expect(placement.immediate.map((tool) => tool.name)).toEqual(["read", "mcp_deploy"]);
			expect(placement.deferred.size).toBe(0);
			expect(placement.unsupported).toEqual(["mcp_deploy"]);
		});
	});
});
