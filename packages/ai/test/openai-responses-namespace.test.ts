import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { convertResponsesMessages, processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { Api, AssistantMessage, AssistantMessageEvent, Model, ToolCall } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

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
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

async function* createFunctionCallEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		sequence_number: 0,
		output_index: 0,
		item: {
			type: "function_call",
			id: "fc_test",
			call_id: "call_test",
			name: "lookup",
			arguments: "",
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		sequence_number: 1,
		output_index: 0,
		item: {
			type: "function_call",
			id: "fc_test",
			call_id: "call_test",
			name: "lookup",
			arguments: '{"value":"hello"}',
			namespace: "dynamic_tools",
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.completed",
		sequence_number: 2,
		response: { id: "resp_test", status: "completed" },
	} as ResponseStreamEvent;
}

async function* createCustomToolCallEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		sequence_number: 0,
		output_index: 0,
		item: {
			type: "custom_tool_call",
			id: "ctc_test",
			call_id: "call_test",
			name: "query",
			input: "",
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		sequence_number: 1,
		output_index: 0,
		item: {
			type: "custom_tool_call",
			id: "ctc_test",
			call_id: "call_test",
			name: "query",
			input: "hello",
			namespace: "dynamic_tools",
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.completed",
		sequence_number: 2,
		response: { id: "resp_test", status: "completed" },
	} as ResponseStreamEvent;
}

/**
 * Records the namespace exactly as it is at the moment `toolcall_end` is
 * pushed. The event carries `slot.block` by reference, so reading it afterwards
 * would also observe any later mutation — which is precisely the regression
 * this needs to catch.
 */
function captureToolCallEndNamespaces(stream: AssistantMessageEventStream): Array<string | undefined> {
	const seen: Array<string | undefined> = [];
	const original = stream.push.bind(stream);
	vi.spyOn(stream, "push").mockImplementation((event: AssistantMessageEvent) => {
		if (event.type === "toolcall_end") seen.push(event.toolCall.namespace);
		return original(event);
	});
	return seen;
}

function getToolCall(output: AssistantMessage): ToolCall {
	const block = output.content[0];
	if (!block || block.type !== "toolCall") throw new Error("Expected toolCall block");
	return block;
}

describe("OpenAI Responses tool-call namespaces", () => {
	// The namespace is assigned to the streaming block immediately before
	// `toolcall_end` is pushed. Consumers that serialize the event synchronously
	// (the protocol and telemetry layers do) only see what is set at push time,
	// so assigning it after the push would silently drop it for them while every
	// assertion against the persisted message kept passing.
	it("carries the function namespace at the moment toolcall_end is pushed", async () => {
		const output = createOutput();
		const stream = new AssistantMessageEventStream();
		const seen = captureToolCallEndNamespaces(stream);

		await processResponsesStream(createFunctionCallEvents(), output, stream, model);

		expect(seen).toEqual(["dynamic_tools"]);
		expect(getToolCall(output).namespace).toBe("dynamic_tools");
	});

	it("carries the custom-tool namespace at the moment toolcall_end is pushed", async () => {
		const output = createOutput();
		const stream = new AssistantMessageEventStream();
		const seen = captureToolCallEndNamespaces(stream);

		await processResponsesStream(createCustomToolCallEvents(), output, stream, model, {
			grammarToolInputProperties: new Map([["query", "input"]]),
		});

		expect(seen).toEqual(["dynamic_tools"]);
		expect(getToolCall(output).namespace).toBe("dynamic_tools");
	});

	it("round-trips a function namespace received only on output_item.done", async () => {
		const output = createOutput();
		await processResponsesStream(createFunctionCallEvents(), output, new AssistantMessageEventStream(), model);

		const toolCall = getToolCall(output);
		expect(toolCall).toMatchObject({
			id: "call_test|fc_test",
			name: "lookup",
			arguments: { value: "hello" },
			namespace: "dynamic_tools",
		});

		const replayed = convertResponsesMessages(model, { messages: [output] }, new Set(["openai"])).find(
			(item) => item.type === "function_call",
		);
		expect(replayed).toMatchObject({
			type: "function_call",
			id: "fc_test",
			call_id: "call_test",
			name: "lookup",
			arguments: '{"value":"hello"}',
			namespace: "dynamic_tools",
		});
	});

	it("round-trips a custom-tool namespace received only on output_item.done", async () => {
		const output = createOutput();
		const grammarToolInputProperties = new Map([["query", "input"]]);
		await processResponsesStream(createCustomToolCallEvents(), output, new AssistantMessageEventStream(), model, {
			grammarToolInputProperties,
		});

		const toolCall = getToolCall(output);
		expect(toolCall).toMatchObject({
			id: "call_test|ctc_test",
			name: "query",
			arguments: { input: "hello" },
			namespace: "dynamic_tools",
		});

		const replayed = convertResponsesMessages(model, { messages: [output] }, new Set(["openai"]), {
			grammarToolInputProperties,
		}).find((item) => item.type === "custom_tool_call");
		expect(replayed).toMatchObject({
			type: "custom_tool_call",
			id: "ctc_test",
			call_id: "call_test",
			name: "query",
			input: "hello",
			namespace: "dynamic_tools",
		});
	});

	it("drops namespaces when the target cannot replay their load items", () => {
		const output = createOutput();
		output.content.push(
			{
				type: "toolCall",
				id: "call_function|fc_test",
				name: "lookup",
				arguments: { value: "hello" },
				namespace: "dynamic_tools",
			},
			{
				type: "toolCall",
				id: "call_custom|ctc_test",
				name: "query",
				arguments: { input: "hello" },
				namespace: "dynamic_tools",
			},
		);
		const targetModels: Model<Api>[] = [
			{ ...model, id: "gpt-5.2", name: "GPT-5.2" },
			{ ...model, provider: "azure-openai-responses" },
			{
				...model,
				api: "openai-codex-responses",
				provider: "openai-codex",
				id: "gpt-5.3-codex-spark",
				name: "GPT-5.3 Codex Spark",
			},
		];

		for (const targetModel of targetModels) {
			const replayed = convertResponsesMessages(targetModel, { messages: [output] }, new Set(["openai"]), {
				grammarToolInputProperties: new Map([["query", "input"]]),
			});
			const functionCall = replayed.find((item) => item.type === "function_call");
			const customToolCall = replayed.find((item) => item.type === "custom_tool_call");
			expect(functionCall).toBeDefined();
			expect(functionCall).not.toHaveProperty("namespace");
			expect(customToolCall).toBeDefined();
			expect(customToolCall).not.toHaveProperty("namespace");
		}
	});

	it("does not add a namespace to ordinary function calls", () => {
		const output = createOutput();
		output.content.push({
			type: "toolCall",
			id: "call_test|fc_test",
			name: "lookup",
			arguments: { value: "hello" },
		});

		const replayed = convertResponsesMessages(model, { messages: [output] }, new Set(["openai"])).find(
			(item) => item.type === "function_call",
		);
		expect(replayed).toBeDefined();
		expect(replayed).not.toHaveProperty("namespace");
	});
});
