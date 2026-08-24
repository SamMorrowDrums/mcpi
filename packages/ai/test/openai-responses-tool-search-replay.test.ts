import type {
	ResponseFunctionToolCall,
	ResponseStreamEvent,
	ResponseToolSearchCall,
	ResponseToolSearchOutputItem,
} from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { convertResponsesMessages, processResponsesStream } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, ToolResultMessage } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

const model: Model<"openai-responses"> = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

function createOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const toolSearchCall: ResponseToolSearchCall = {
	type: "tool_search_call",
	id: "ts_call_item",
	call_id: "search_call",
	arguments: { query: "github pull request" },
	execution: "server",
	status: "completed",
};

const toolSearchOutput: ResponseToolSearchOutputItem = {
	type: "tool_search_output",
	id: "ts_output_item",
	call_id: "search_call",
	execution: "server",
	status: "completed",
	tools: [
		{
			type: "function",
			name: "pull_request_read",
			description: "Read a pull request",
			parameters: { type: "object", properties: {} },
			strict: false,
			defer_loading: true,
		},
	],
};

const namespacedFunctionCall: ResponseFunctionToolCall = {
	type: "function_call",
	id: "fc_read",
	call_id: "call_read",
	name: "pull_request_read",
	namespace: "github-mcp-server",
	arguments: '{"pullNumber":4}',
	status: "completed",
};

async function* createFirstTurnEvents(): AsyncIterable<ResponseStreamEvent> {
	const items = [toolSearchCall, toolSearchOutput, namespacedFunctionCall];
	for (const [index, item] of items.entries()) {
		yield {
			type: "response.output_item.added",
			item,
			output_index: index,
			sequence_number: index * 2,
		} as ResponseStreamEvent;
		yield {
			type: "response.output_item.done",
			item,
			output_index: index,
			sequence_number: index * 2 + 1,
		} as ResponseStreamEvent;
	}
}

describe("OpenAI Responses hosted tool-search replay", () => {
	it("round-trips tool-search items and function-call namespace into the second turn", async () => {
		const output = createOutput();
		const stream = new AssistantMessageEventStream();
		const pushSpy = vi.spyOn(stream, "push");

		await processResponsesStream(createFirstTurnEvents(), output, stream, model);

		expect(output.serverTools).toEqual({
			provider: "openai-responses",
			items: [toolSearchCall, toolSearchOutput],
		});
		expect(output.content).toHaveLength(1);
		const persistedToolCall = output.content[0];
		if (persistedToolCall?.type !== "toolCall") {
			throw new Error("Expected persisted tool call");
		}
		expect(persistedToolCall.namespace).toBe("github-mcp-server");

		const emittedEvents = pushSpy.mock.calls.map(([event]) => event as AssistantMessageEvent);
		const toolCallEnd = emittedEvents.find((event) => event.type === "toolcall_end");
		if (!toolCallEnd || toolCallEnd.type !== "toolcall_end") {
			throw new Error("Expected toolcall_end event");
		}
		expect(toolCallEnd.toolCall.namespace).toBe("github-mcp-server");

		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: persistedToolCall.id,
			toolName: persistedToolCall.name,
			content: [{ type: "text", text: '{"title":"Namespace parity"}' }],
			isError: false,
			timestamp: Date.now(),
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "Read pull request 4.", timestamp: Date.now() - 1000 },
				output,
				toolResult,
			],
		};

		const secondTurnInput = convertResponsesMessages(model, context, new Set(["openai"]));
		expect(
			secondTurnInput.map((item) => ("type" in item ? item.type : "role" in item ? item.role : "item_reference")),
		).toEqual(["user", "tool_search_call", "tool_search_output", "function_call", "function_call_output"]);
		expect(secondTurnInput[1]).toEqual(toolSearchCall);
		expect(secondTurnInput[2]).toEqual(toolSearchOutput);

		const replayedFunctionCall = secondTurnInput[3];
		if (replayedFunctionCall?.type !== "function_call") {
			throw new Error("Expected replayed function call");
		}
		expect(replayedFunctionCall).toMatchObject({
			call_id: "call_read",
			name: "pull_request_read",
			namespace: "github-mcp-server",
		});
	});
});
