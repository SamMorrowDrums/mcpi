import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Api, Context, Model, Tool } from "../src/types.ts";

/**
 * Offline contract tests for Claude Opus 5 across every provider that serves it.
 *
 * Every case captures the outgoing request payload and aborts before the request
 * leaves the process, so this suite needs no credentials and makes no billable
 * requests. Thinking-level mapping is covered in `opus-5-thinking.test.ts`; this
 * file covers the per-provider catalog contract and the wire payloads.
 */

class PayloadCaptured extends Error {}

interface AnthropicPayload {
	model?: string;
	max_tokens?: number;
	thinking?: { type: string; display?: string };
	output_config?: { effort?: string };
	tools?: Array<{ name: string; input_schema?: Record<string, unknown> }>;
	messages: Array<{
		content: string | Array<{ type: string; source?: { type: string; media_type: string; data: string } }>;
	}>;
}

interface BedrockPayload {
	additionalModelRequestFields?: {
		thinking?: { type: string; display?: string; budget_tokens?: number };
		output_config?: { effort?: string };
	};
	toolConfig?: { tools?: Array<{ toolSpec?: { name?: string } }> };
}

function makeTool(name: string): Tool {
	return { name, description: `The ${name} tool`, parameters: Type.Object({ value: Type.String() }) };
}

function makeContext(): Context {
	return {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		tools: [makeTool("base_tool")],
	};
}

function makeImageContext(): Context {
	return {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "What is in this image?" },
					{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
				],
				timestamp: 1,
			},
		],
	};
}

async function captureAnthropic(
	model: Model<Api>,
	context: Context = makeContext(),
	options: { reasoning?: "high" | "xhigh" | "max"; apiKey?: string } = {},
): Promise<AnthropicPayload> {
	let captured: AnthropicPayload | undefined;
	const s = streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, context, {
		apiKey: options.apiKey ?? "fake-key",
		reasoning: options.reasoning,
		onPayload: (payload) => {
			captured = payload as AnthropicPayload;
			throw new PayloadCaptured();
		},
	});
	await s.result();
	if (!captured) throw new Error("Expected payload capture");
	return captured;
}

async function captureBedrock(
	model: Model<"bedrock-converse-stream">,
	context: Context = makeContext(),
	reasoning: "high" | "xhigh" | "max" = "high",
): Promise<BedrockPayload> {
	let captured: BedrockPayload | undefined;
	const s = streamBedrock(model, context, {
		reasoning,
		onPayload: (payload) => {
			captured = payload as BedrockPayload;
			throw new PayloadCaptured();
		},
	});
	for await (const event of s) {
		if (event.type === "error") break;
	}
	if (!captured) throw new Error("Expected payload capture");
	return captured;
}

describe("Claude Opus 5 catalog metadata", () => {
	it("exposes Opus 5 on the direct Anthropic provider", () => {
		const model = getModel("anthropic", "claude-opus-5");

		expect(model.api).toBe("anthropic-messages");
		expect(model.contextWindow).toBe(1000000);
		expect(model.maxTokens).toBe(128000);
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.compat).toMatchObject({ forceAdaptiveThinking: true, supportsStrictTools: true });
		expect(model.compat?.supportsTemperature).toBe(false);
	});

	it("exposes Opus 5 on GitHub Copilot with a smaller output cap", () => {
		const model = getModel("github-copilot", "claude-opus-5");

		expect(model.api).toBe("anthropic-messages");
		expect(model.contextWindow).toBe(1000000);
		// Copilot caps output at half the direct Anthropic limit, so switching the
		// Copilot default onto Opus 5 lowers max output from gpt-5.4's 128k to 64k.
		expect(model.maxTokens).toBe(64000);
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.compat).toMatchObject({ forceAdaptiveThinking: true });
	});

	it("exposes Opus 5 on Bedrock as inference profiles only", () => {
		const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-5");

		expect(model.api).toBe("bedrock-converse-stream");
		expect(model.contextWindow).toBe(1000000);
		expect(model.maxTokens).toBe(128000);
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);

		// Opus 5 on Bedrock ships as regional inference profiles; there is no bare
		// `anthropic.claude-opus-5` model id.
		expect(getModel("amazon-bedrock", "au.anthropic.claude-opus-5").id).toBe("au.anthropic.claude-opus-5");
		expect(getModel("amazon-bedrock", "eu.anthropic.claude-opus-5").id).toBe("eu.anthropic.claude-opus-5");
		expect(getModel("amazon-bedrock", "global.anthropic.claude-opus-5").id).toBe("global.anthropic.claude-opus-5");
		expect(getModel("amazon-bedrock", "jp.anthropic.claude-opus-5").id).toBe("jp.anthropic.claude-opus-5");
		expect(getModel("amazon-bedrock", "us.anthropic.claude-opus-5").id).toBe("us.anthropic.claude-opus-5");
	});

	it("prices prompt caching identically across providers", () => {
		const expected = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

		expect(getModel("anthropic", "claude-opus-5").cost).toEqual(expected);
		expect(getModel("github-copilot", "claude-opus-5").cost).toEqual(expected);
		expect(getModel("amazon-bedrock", "us.anthropic.claude-opus-5").cost).toEqual(expected);
	});
});

describe("Claude Opus 5 request payloads", () => {
	it("routes direct Anthropic Opus 5 through the Anthropic Messages API", async () => {
		const model = getModel("anthropic", "claude-opus-5");
		const payload = await captureAnthropic(model);

		expect(payload.model).toBe("claude-opus-5");
		expect(payload.max_tokens).toBe(model.maxTokens);
		expect(payload.tools?.map((tool) => tool.name)).toEqual(["base_tool"]);
		expect(payload.tools?.[0]?.input_schema).toBeDefined();
	});

	it("encodes image input for direct Anthropic Opus 5", async () => {
		const payload = await captureAnthropic(getModel("anthropic", "claude-opus-5"), makeImageContext());

		const content = payload.messages.at(-1)?.content;
		expect(Array.isArray(content)).toBe(true);
		expect(Array.isArray(content) && content.some((block) => block.type === "image")).toBe(true);
	});

	it("routes Copilot Opus 5 through the Anthropic Messages API with the Copilot output cap", async () => {
		const model = getModel("github-copilot", "claude-opus-5");
		const payload = await captureAnthropic(model, makeContext(), { apiKey: "tid_copilot_session_test_token" });

		expect(payload.model).toBe("claude-opus-5");
		expect(payload.max_tokens).toBe(64000);
		expect(payload.tools?.map((tool) => tool.name)).toEqual(["base_tool"]);
	});

	// Bedrock reaches adaptive thinking through id predicates in
	// bedrock-converse-stream rather than compat.forceAdaptiveThinking, so these
	// two cases pin that parallel path on the exact profile we default to.
	it("routes Bedrock Opus 5 through Converse with adaptive thinking", async () => {
		const payload = await captureBedrock(getModel("amazon-bedrock", "us.anthropic.claude-opus-5"));

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
		expect(payload.toolConfig?.tools?.map((tool) => tool.toolSpec?.name)).toEqual(["base_tool"]);
	});

	it("passes xhigh effort through to Bedrock Opus 5", async () => {
		const payload = await captureBedrock(
			getModel("amazon-bedrock", "us.anthropic.claude-opus-5"),
			makeContext(),
			"xhigh",
		);

		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "xhigh" });
	});
});
