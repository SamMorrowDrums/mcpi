import type Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { ProviderReplayAssistantMessage } from "../src/api/provider-replay.ts";
import { transformMessages } from "../src/api/transform-messages.ts";
import { getModel } from "../src/compat.ts";
import type { Api, AssistantMessage, Context, JsonValue, Model, Tool, ToolResultMessage } from "../src/types.ts";

function createSseResponse(events: unknown[]): Response {
	const body = events
		.map((event) => {
			const type = (event as { type: string }).type;
			return `event: ${type}\ndata: ${JSON.stringify(event)}\n`;
		})
		.join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function messageStart(id: string): unknown {
	return {
		type: "message_start",
		message: {
			id,
			usage: {
				input_tokens: 10,
				output_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
	};
}

function messageEnd(stopReason: "end_turn" | "tool_use"): unknown[] {
	return [
		{
			type: "message_delta",
			delta: { stop_reason: stopReason },
			usage: {
				input_tokens: 10,
				output_tokens: 20,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
		{ type: "message_stop" },
	];
}

const originalBlocks: JsonValue[] = [
	{ type: "thinking", thinking: "First signed thought.\n", signature: "signature-one" },
	{
		type: "server_tool_use",
		id: "srvtoolu_search_1",
		name: "tool_search_tool_bm25",
		input: { query: "read repository file" },
		caller: { type: "direct" },
	},
	{
		type: "tool_search_tool_result",
		tool_use_id: "srvtoolu_search_1",
		content: {
			type: "tool_search_tool_search_result",
			tool_references: [{ type: "tool_reference", tool_name: "Read" }],
		},
	},
	{ type: "thinking", thinking: "Second signed thought.\n", signature: "signature-two" },
	{
		type: "tool_use",
		id: "toolu_provider_original",
		name: "Read",
		input: { path: "README.md" },
		caller: { type: "direct" },
	},
];

function nativeSearchEvents(): unknown[] {
	return [
		messageStart("msg_native_search"),
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "thinking", thinking: "", signature: "" },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "thinking_delta", thinking: "First signed thought.\n" },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "signature_delta", signature: "signature-one" },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "content_block_start",
			index: 1,
			content_block: {
				type: "server_tool_use",
				id: "srvtoolu_search_1",
				name: "tool_search_tool_bm25",
				input: {},
				caller: { type: "direct" },
			},
		},
		{
			type: "content_block_delta",
			index: 1,
			delta: { type: "input_json_delta", partial_json: '{"query":"read repository file"}' },
		},
		{ type: "content_block_stop", index: 1 },
		{
			type: "content_block_start",
			index: 2,
			content_block: originalBlocks[2],
		},
		{ type: "content_block_stop", index: 2 },
		{
			type: "content_block_start",
			index: 3,
			content_block: { type: "thinking", thinking: "", signature: "" },
		},
		{
			type: "content_block_delta",
			index: 3,
			delta: { type: "thinking_delta", thinking: "Second signed thought.\n" },
		},
		{
			type: "content_block_delta",
			index: 3,
			delta: { type: "signature_delta", signature: "signature-two" },
		},
		{ type: "content_block_stop", index: 3 },
		{
			type: "content_block_start",
			index: 4,
			content_block: {
				type: "tool_use",
				id: "toolu_provider_original",
				name: "Read",
				input: {},
				caller: { type: "direct" },
			},
		},
		{
			type: "content_block_delta",
			index: 4,
			delta: { type: "input_json_delta", partial_json: '{"path":"README.md"}' },
		},
		{ type: "content_block_stop", index: 4 },
		...messageEnd("tool_use"),
	];
}

function makeTool(name: string, deferred = false): Tool {
	return {
		name,
		description: `The ${name} tool`,
		parameters: Type.Object({ path: Type.Optional(Type.String()) }),
		deferred,
	};
}

function createClient(
	responses: Response[],
	captured: MessageCreateParamsStreaming[],
	validateSecondRequest: (params: MessageCreateParamsStreaming) => void,
): Anthropic {
	return {
		messages: {
			create: (params: MessageCreateParamsStreaming) => {
				captured.push(params);
				if (captured.length === 2) validateSecondRequest(params);
				const response = responses.shift();
				if (!response) throw new Error("Unexpected Anthropic request");
				return { asResponse: async () => response };
			},
		},
	} as unknown as Anthropic;
}

async function drain(stream: ReturnType<typeof streamAnthropic>): Promise<AssistantMessage> {
	for await (const _event of stream) {
		// Drain the stream before reading its result.
	}
	return await stream.result();
}

describe("Anthropic provider-native tool replay", () => {
	it("replays native search and signed thinking exactly after JSON persistence", async () => {
		const model = getModel("github-copilot", "claude-opus-5");
		const captured: MessageCreateParamsStreaming[] = [];
		const client = createClient(
			[
				createSseResponse(nativeSearchEvents()),
				createSseResponse([messageStart("msg_followup"), ...messageEnd("end_turn")]),
			],
			captured,
			(params) => {
				const assistant = params.messages.find((message) => message.role === "assistant");
				expect(assistant?.content).toEqual(originalBlocks);
				const toolResultMessage = params.messages.find(
					(message) =>
						message.role === "user" &&
						Array.isArray(message.content) &&
						message.content.some((block) => block.type === "tool_result"),
				);
				if (!toolResultMessage || !Array.isArray(toolResultMessage.content)) {
					throw new Error("Expected a tool result message");
				}
				expect(toolResultMessage.content[0]).toMatchObject({
					type: "tool_result",
					tool_use_id: "toolu_provider_original",
					content: [{ type: "tool_reference", tool_name: "late_tool" }],
				});
			},
		);
		const initialContext: Context = {
			messages: [{ role: "user", content: "Read the repository file.", timestamp: 1 }],
			tools: [makeTool("local_read"), makeTool("late_tool", true)],
		};

		const first = await drain(streamAnthropic(model, initialContext, { client }));
		expect(first.content.map((block) => block.type)).toEqual(["thinking", "thinking", "toolCall"]);
		expect(first.content.filter((block) => block.type === "toolCall")).toHaveLength(1);
		expect((first as ProviderReplayAssistantMessage).providerReplay?.content).toEqual(originalBlocks);

		const persisted = JSON.parse(JSON.stringify(first)) as AssistantMessage;
		const localToolCall = persisted.content.find((block) => block.type === "toolCall");
		if (!localToolCall || localToolCall.type !== "toolCall") throw new Error("Expected a local tool call");
		localToolCall.id = "local_dispatch_id";
		localToolCall.name = "local_read";
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: localToolCall.id,
			toolName: localToolCall.name,
			content: [{ type: "text", text: "file contents" }],
			addedToolNames: ["late_tool"],
			isError: false,
			timestamp: 2,
		};

		const followup = await drain(
			streamAnthropic(
				model,
				{
					messages: [initialContext.messages[0], persisted, toolResult],
					tools: initialContext.tools,
				},
				{ client },
			),
		);

		expect(followup.stopReason).toBe("stop");
		expect(followup.errorMessage).toBeUndefined();
		expect(captured).toHaveLength(2);
	});

	it("preserves redacted thinking, multiple searches, errors, empty results, and interleaved text", async () => {
		const model = getModel("github-copilot", "claude-opus-5");
		const expectedBlocks = [
			{ type: "redacted_thinking", data: "redacted-payload" },
			{
				type: "server_tool_use",
				id: "srvtoolu_search_error",
				name: "tool_search_tool_bm25",
				input: { query: "missing tool" },
				caller: { type: "direct" },
			},
			{
				type: "tool_search_tool_result",
				tool_use_id: "srvtoolu_search_error",
				content: {
					type: "tool_search_tool_result_error",
					error_code: "unavailable",
					error_message: "catalog temporarily unavailable",
				},
			},
			{ type: "text", text: "Visible interlude." },
			{
				type: "server_tool_use",
				id: "srvtoolu_search_empty",
				name: "tool_search_tool_bm25",
				input: { query: "no matches" },
				caller: { type: "direct" },
			},
			{
				type: "tool_search_tool_result",
				tool_use_id: "srvtoolu_search_empty",
				content: {
					type: "tool_search_tool_search_result",
					tool_references: [],
				},
			},
			{ type: "thinking", thinking: "Final signed thought.", signature: "signature-final" },
			{
				type: "tool_use",
				id: "toolu_final",
				name: "local_read",
				input: { path: "CHANGELOG.md" },
				caller: { type: "direct" },
			},
		];
		const events = [
			messageStart("msg_native_variants"),
			{
				type: "content_block_start",
				index: 0,
				content_block: expectedBlocks[0],
			},
			{ type: "content_block_stop", index: 0 },
			{
				type: "content_block_start",
				index: 1,
				content_block: {
					type: "server_tool_use",
					id: "srvtoolu_search_error",
					name: "tool_search_tool_bm25",
					input: {},
					caller: { type: "direct" },
				},
			},
			{
				type: "content_block_delta",
				index: 1,
				delta: { type: "input_json_delta", partial_json: '{"query":"missing tool"}' },
			},
			{ type: "content_block_stop", index: 1 },
			{ type: "content_block_start", index: 2, content_block: expectedBlocks[2] },
			{ type: "content_block_stop", index: 2 },
			{ type: "content_block_start", index: 3, content_block: { type: "text", text: "Visible " } },
			{
				type: "content_block_delta",
				index: 3,
				delta: { type: "text_delta", text: "interlude." },
			},
			{ type: "content_block_stop", index: 3 },
			{
				type: "content_block_start",
				index: 4,
				content_block: {
					type: "server_tool_use",
					id: "srvtoolu_search_empty",
					name: "tool_search_tool_bm25",
					input: {},
					caller: { type: "direct" },
				},
			},
			{
				type: "content_block_delta",
				index: 4,
				delta: { type: "input_json_delta", partial_json: '{"query":"no matches"}' },
			},
			{ type: "content_block_stop", index: 4 },
			{ type: "content_block_start", index: 5, content_block: expectedBlocks[5] },
			{ type: "content_block_stop", index: 5 },
			{
				type: "content_block_start",
				index: 6,
				content_block: { type: "thinking", thinking: "Final ", signature: "" },
			},
			{
				type: "content_block_delta",
				index: 6,
				delta: { type: "thinking_delta", thinking: "signed thought." },
			},
			{
				type: "content_block_delta",
				index: 6,
				delta: { type: "signature_delta", signature: "signature-final" },
			},
			{ type: "content_block_stop", index: 6 },
			{
				type: "content_block_start",
				index: 7,
				content_block: {
					type: "tool_use",
					id: "toolu_final",
					name: "local_read",
					input: {},
					caller: { type: "direct" },
				},
			},
			{
				type: "content_block_delta",
				index: 7,
				delta: { type: "input_json_delta", partial_json: '{"path":"CHANGELOG.md"}' },
			},
			{ type: "content_block_stop", index: 7 },
			...messageEnd("tool_use"),
		];
		const captured: MessageCreateParamsStreaming[] = [];
		const client = createClient(
			[
				createSseResponse(events),
				createSseResponse([messageStart("msg_after_variants"), ...messageEnd("end_turn")]),
			],
			captured,
			(params) => {
				const assistant = params.messages.find((message) => message.role === "assistant");
				expect(assistant?.content).toEqual(expectedBlocks);
			},
		);
		const first = await drain(
			streamAnthropic(
				model,
				{
					messages: [{ role: "user", content: "Exercise native search variants.", timestamp: 1 }],
					tools: [makeTool("local_read")],
				},
				{ client },
			),
		);

		expect((first as ProviderReplayAssistantMessage).providerReplay?.content).toEqual(expectedBlocks);
		expect(first.content.map((block) => block.type)).toEqual(["thinking", "text", "thinking", "toolCall"]);
		expect(first.content.filter((block) => block.type === "toolCall")).toHaveLength(1);
		const finalCall = first.content.find((block) => block.type === "toolCall");
		if (!finalCall || finalCall.type !== "toolCall") throw new Error("Expected the final local tool call");

		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: finalCall.id,
			toolName: finalCall.name,
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: 2,
		};
		const persisted = JSON.parse(JSON.stringify(first)) as AssistantMessage;
		const followup = await drain(
			streamAnthropic(
				model,
				{
					messages: [
						{ role: "user", content: "Exercise native search variants.", timestamp: 1 },
						persisted,
						toolResult,
					],
					tools: [makeTool("local_read")],
				},
				{ client },
			),
		);

		expect(followup.stopReason).toBe("stop");
	});

	it("drops provider-native replay data for provider and model handoffs", () => {
		const source: ProviderReplayAssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Signed thought", thinkingSignature: "signature" },
				{ type: "toolCall", id: "toolu_1", name: "read", arguments: {} },
			],
			api: "anthropic-messages",
			provider: "github-copilot",
			model: "claude-opus-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		} as ProviderReplayAssistantMessage;
		source.providerReplay = {
			provider: "github-copilot",
			api: "anthropic-messages",
			model: "claude-opus-5",
			content: originalBlocks,
		};
		const targets: Model<Api>[] = [getModel("github-copilot", "claude-sonnet-5"), getModel("openai", "gpt-5-mini")];

		for (const target of targets) {
			const [transformed] = transformMessages([source], target);
			if (transformed.role !== "assistant") throw new Error("Expected an assistant message");
			expect((transformed as ProviderReplayAssistantMessage).providerReplay).toBeUndefined();
			expect(JSON.stringify(transformed)).not.toContain("server_tool_use");
			expect(JSON.stringify(transformed)).not.toContain("tool_search_tool_result");
			expect(transformed.content[0]).toEqual({ type: "text", text: "Signed thought" });
		}
	});

	it("fails old adjacent signed-thinking sessions locally with actionable guidance", async () => {
		const model = getModel("github-copilot", "claude-opus-5");
		let requestCount = 0;
		const client = {
			messages: {
				create: () => {
					requestCount++;
					throw new Error("The provider request must not be attempted");
				},
			},
		} as unknown as Anthropic;
		const legacyAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "First", thinkingSignature: "signature-one" },
				{ type: "thinking", thinking: "Second", thinkingSignature: "signature-two" },
				{ type: "toolCall", id: "toolu_old", name: "local_read", arguments: {} },
			],
			api: "anthropic-messages",
			provider: "github-copilot",
			model: "claude-opus-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		};
		const result = await drain(
			streamAnthropic(
				model,
				{
					messages: [
						{ role: "user", content: "Old session", timestamp: 1 },
						legacyAssistant,
						{
							role: "toolResult",
							toolCallId: "toolu_old",
							toolName: "local_read",
							content: [{ type: "text", text: "done" }],
							isError: false,
							timestamp: 3,
						},
					],
					tools: [makeTool("local_read")],
				},
				{ client },
			),
		);

		expect(requestCount).toBe(0);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("no provider-native replay data");
		expect(result.errorMessage).toContain("Start a new session or branch before this turn");
	});

	it("does not retry a provider rejection of mutated replay content", async () => {
		const model = getModel("github-copilot", "claude-opus-5");
		let requestCount = 0;
		const client = {
			messages: {
				create: (params: MessageCreateParamsStreaming) => {
					requestCount++;
					if (requestCount === 1) {
						return { asResponse: async () => createSseResponse(nativeSearchEvents()) };
					}
					const assistant = params.messages.find((message) => message.role === "assistant");
					if (JSON.stringify(assistant?.content) !== JSON.stringify(originalBlocks)) {
						const error = new Error(
							"400 thinking or redacted_thinking blocks in the latest assistant message cannot be modified",
						) as Error & { status: number };
						error.status = 400;
						throw error;
					}
					return {
						asResponse: async () =>
							createSseResponse([messageStart("msg_unexpected"), ...messageEnd("end_turn")]),
					};
				},
			},
		} as unknown as Anthropic;
		const first = await drain(
			streamAnthropic(
				model,
				{
					messages: [{ role: "user", content: "Create native replay.", timestamp: 1 }],
					tools: [makeTool("local_read"), makeTool("late_tool", true)],
				},
				{ client },
			),
		);
		const mutated = JSON.parse(JSON.stringify(first)) as AssistantMessage;
		const mutatedReplay = (mutated as ProviderReplayAssistantMessage).providerReplay;
		if (!mutatedReplay) throw new Error("Expected provider replay data");
		mutatedReplay.content.splice(1, 2);
		const finalCall = mutated.content.find((block) => block.type === "toolCall");
		if (!finalCall || finalCall.type !== "toolCall") throw new Error("Expected a final tool call");

		const result = await drain(
			streamAnthropic(
				model,
				{
					messages: [
						{ role: "user", content: "Create native replay.", timestamp: 1 },
						mutated,
						{
							role: "toolResult",
							toolCallId: finalCall.id,
							toolName: finalCall.name,
							content: [{ type: "text", text: "done" }],
							isError: false,
							timestamp: 2,
						},
					],
					tools: [makeTool("local_read"), makeTool("late_tool", true)],
				},
				{ client, maxRetries: 3 },
			),
		);

		expect(requestCount).toBe(2);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("cannot be modified");
	});

	it("does not sanitize signed thinking in legacy replay", async () => {
		const model = getModel("github-copilot", "claude-opus-5");
		const signedThinking = `exact${String.fromCharCode(0xd800)}bytes`;
		const captured: MessageCreateParamsStreaming[] = [];
		const client = createClient(
			[createSseResponse([messageStart("msg_legacy_signed"), ...messageEnd("end_turn")])],
			captured,
			() => {},
		);
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: signedThinking, thinkingSignature: "signature" }],
			api: "anthropic-messages",
			provider: "github-copilot",
			model: "claude-opus-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		};

		await drain(
			streamAnthropic(
				model,
				{
					messages: [
						{ role: "user", content: "Legacy signed block", timestamp: 1 },
						assistant,
						{ role: "user", content: "Continue", timestamp: 3 },
					],
				},
				{ client },
			),
		);

		const replayedAssistant = captured[0].messages.find((message) => message.role === "assistant");
		expect(replayedAssistant?.content).toEqual([
			{ type: "thinking", thinking: signedThinking, signature: "signature" },
		]);
	});
});
