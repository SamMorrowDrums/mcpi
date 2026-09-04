/**
 * Tool Call ID Normalization Tests
 *
 * Tests that tool call IDs from OpenAI Responses API (github-copilot, openai-codex, opencode)
 * are properly normalized when sent to other providers.
 *
 * OpenAI Responses API generates IDs in format: {call_id}|{id}
 * where {id} can be 400+ chars with special characters (+, /, =).
 *
 * Regression test for: https://github.com/earendil-works/pi-mono/issues/1022
 */

import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/openai-completions.ts";
import { completeSimple, getEnvApiKey, getModel } from "../src/compat.ts";
import type {
	AssistantMessage,
	Message,
	Model,
	OpenAICompletionsCompat,
	Tool,
	ToolResultMessage,
} from "../src/types.ts";
import { resolveApiKey } from "./oauth.ts";

// Resolve API keys
const copilotToken = await resolveApiKey("github-copilot");
const openrouterKey = getEnvApiKey("openrouter");
const codexToken = await resolveApiKey("openai-codex");

// Simple echo tool for testing
const echoToolSchema = Type.Object({
	message: Type.String({ description: "Message to echo back" }),
});

const echoTool: Tool<typeof echoToolSchema> = {
	name: "echo",
	description: "Echoes the message back",
	parameters: echoToolSchema,
};

/**
 * Test 1: Live cross-provider handoff
 *
 * 1. Use github-copilot gpt-5.3-codex to generate a tool call
 * 2. Switch to openrouter openai/gpt-5.2-codex and complete
 * 3. Switch to openai-codex gpt-5.5 and complete
 *
 * Both should succeed without "call_id too long" errors.
 */
describe("Tool Call ID Normalization - Live Handoff", () => {
	it.skipIf(!copilotToken || !openrouterKey)(
		"github-copilot -> openrouter should normalize pipe-separated IDs",
		async () => {
			const copilotModel = getModel("github-copilot", "gpt-5.3-codex");
			const openrouterModel = getModel("openrouter", "openai/gpt-5.2-codex");

			// Step 1: Generate tool call with github-copilot
			const userMessage: Message = {
				role: "user",
				content: "Use the echo tool to echo 'hello world'",
				timestamp: Date.now(),
			};

			const assistantResponse = await completeSimple(
				copilotModel,
				{
					systemPrompt: "You are a helpful assistant. Use the echo tool when asked.",
					messages: [userMessage],
					tools: [echoTool],
				},
				{ apiKey: copilotToken },
			);

			expect(assistantResponse.stopReason, `Copilot error: ${assistantResponse.errorMessage}`).toBe("toolUse");

			const toolCall = assistantResponse.content.find((c) => c.type === "toolCall");
			expect(toolCall).toBeDefined();
			if (!toolCall || toolCall.type !== "toolCall") {
				throw new Error("Expected GitHub Copilot to return a tool call");
			}
			expect(toolCall.id).toContain("|");
			console.log(`Tool call ID from github-copilot: ${toolCall.id.slice(0, 80)}...`);

			// Create tool result
			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "echo",
				content: [{ type: "text", text: "hello world" }],
				isError: false,
				timestamp: Date.now(),
			};

			// Step 2: Complete with openrouter (uses openai-completions API)
			const openrouterResponse = await completeSimple(
				openrouterModel,
				{
					systemPrompt: "You are a helpful assistant.",
					messages: [
						userMessage,
						assistantResponse,
						toolResult,
						{ role: "user", content: "Say hi", timestamp: Date.now() },
					],
					tools: [echoTool],
				},
				{ apiKey: openrouterKey },
			);

			// Should NOT fail with "call_id too long" error
			expect(openrouterResponse.stopReason, `OpenRouter error: ${openrouterResponse.errorMessage}`).not.toBe(
				"error",
			);
			expect(openrouterResponse.errorMessage).toBeUndefined();
		},
		60000,
	);

	it.skipIf(!copilotToken || !codexToken)(
		"github-copilot -> openai-codex should normalize pipe-separated IDs",
		async () => {
			const copilotModel = getModel("github-copilot", "gpt-5.3-codex");
			const codexModel = getModel("openai-codex", "gpt-5.5");

			// Step 1: Generate tool call with github-copilot
			const userMessage: Message = {
				role: "user",
				content: "Use the echo tool to echo 'test message'",
				timestamp: Date.now(),
			};

			const assistantResponse = await completeSimple(
				copilotModel,
				{
					systemPrompt: "You are a helpful assistant. Use the echo tool when asked.",
					messages: [userMessage],
					tools: [echoTool],
				},
				{ apiKey: copilotToken },
			);

			expect(assistantResponse.stopReason, `Copilot error: ${assistantResponse.errorMessage}`).toBe("toolUse");

			const toolCall = assistantResponse.content.find((c) => c.type === "toolCall");
			expect(toolCall).toBeDefined();
			if (!toolCall || toolCall.type !== "toolCall") {
				throw new Error("Expected GitHub Copilot to return a tool call");
			}

			// Create tool result
			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "echo",
				content: [{ type: "text", text: "test message" }],
				isError: false,
				timestamp: Date.now(),
			};

			// Step 2: Complete with openai-codex (uses openai-codex-responses API)
			const codexResponse = await completeSimple(
				codexModel,
				{
					systemPrompt: "You are a helpful assistant.",
					messages: [
						userMessage,
						assistantResponse,
						toolResult,
						{ role: "user", content: "Say hi", timestamp: Date.now() },
					],
					tools: [echoTool],
				},
				{ apiKey: codexToken },
			);

			// Should NOT fail with ID validation error
			expect(codexResponse.stopReason, `Codex error: ${codexResponse.errorMessage}`).not.toBe("error");
			expect(codexResponse.errorMessage).toBeUndefined();
		},
		60000,
	);
});

/**
 * Test 2: Prefilled context with exact failing IDs from issue #1022
 *
 * Uses the exact tool call ID format that caused the error:
 * "call_xxx|very_long_base64_with_special_chars+/="
 */
describe("Tool Call ID Normalization - Prefilled Context", () => {
	// Exact tool call ID from issue #1022 JSONL
	const FAILING_TOOL_CALL_ID =
		"call_pAYbIr76hXIjncD9UE4eGfnS|t5nnb2qYMFWGSsr13fhCd1CaCu3t3qONEPuOudu4HSVEtA8YJSL6FAZUxvoOoD792VIJWl91g87EdqsCWp9krVsdBysQoDaf9lMCLb8BS4EYi4gQd5kBQBYLlgD71PYwvf+TbMD9J9/5OMD42oxSRj8H+vRf78/l2Xla33LWz4nOgsddBlbvabICRs8GHt5C9PK5keFtzyi3lsyVKNlfduK3iphsZqs4MLv4zyGJnvZo/+QzShyk5xnMSQX/f98+aEoNflEApCdEOXipipgeiNWnpFSHbcwmMkZoJhURNu+JEz3xCh1mrXeYoN5o+trLL3IXJacSsLYXDrYTipZZbJFRPAucgbnjYBC+/ZzJOfkwCs+Gkw7EoZR7ZQgJ8ma+9586n4tT4cI8DEhBSZsWMjrCt8dxKg==";

	// Build prefilled context with the failing ID
	function buildPrefilledMessages(): Message[] {
		const userMessage: Message = {
			role: "user",
			content: "Use the echo tool to echo 'hello'",
			timestamp: Date.now() - 2000,
		};

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: FAILING_TOOL_CALL_ID,
					name: "echo",
					arguments: { message: "hello" },
				},
			],
			api: "openai-responses",
			provider: "github-copilot",
			model: "gpt-5.2-codex",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now() - 1500,
		};

		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: FAILING_TOOL_CALL_ID,
			toolName: "echo",
			content: [{ type: "text", text: "hello" }],
			isError: false,
			timestamp: Date.now() - 1000,
		};

		const followUpUser: Message = {
			role: "user",
			content: "Say hi",
			timestamp: Date.now(),
		};

		return [userMessage, assistantMessage, toolResult, followUpUser];
	}

	it("normalizes historical tool call IDs without requiring the source model in the catalog", () => {
		const targetModel: Model<"openai-completions"> = {
			id: "synthetic-openai-completions",
			name: "Synthetic OpenAI Completions",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://example.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		const compat: Omit<Required<OpenAICompletionsCompat>, "deferredToolsMode"> & {
			deferredToolsMode?: OpenAICompletionsCompat["deferredToolsMode"];
		} = {
			supportsStore: true,
			supportsDeveloperRole: true,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
			maxTokensField: "max_completion_tokens",
			requiresToolResultName: false,
			requiresAssistantAfterToolResult: false,
			requiresThinkingAsText: false,
			requiresReasoningContentOnAssistantMessages: false,
			thinkingFormat: "openai",
			openRouterRouting: {},
			vercelGatewayRouting: {},
			chatTemplateKwargs: {},
			chatTemplateArgs: {},
			zaiToolStream: false,
			supportsThinkingTokenBudget: false,
			supportsStrictMode: true,
			supportsOpenAIGrammarTools: false,
			cacheControlFormat: "anthropic",
			sendSessionAffinityHeaders: false,
			sessionAffinityFormat: "openrouter",
			supportsLongCacheRetention: true,
		};

		const messages = convertMessages(targetModel, { messages: buildPrefilledMessages(), tools: [echoTool] }, compat);
		const assistantMessage = messages.find((message) => message.role === "assistant");
		const toolResult = messages.find((message) => message.role === "tool");
		if (!assistantMessage || assistantMessage.role !== "assistant" || !toolResult || toolResult.role !== "tool") {
			throw new Error("Expected converted assistant and tool messages");
		}
		const normalizedId = assistantMessage.tool_calls?.[0]?.id;
		if (!normalizedId) {
			throw new Error("Expected converted assistant message to contain a tool call ID");
		}

		expect(normalizedId).toBe("call_pAYbIr76hXIjncD9UE4eGfnS_1q6evuz1");
		expect(normalizedId).toBe(toolResult.tool_call_id);
		expect(normalizedId).not.toBe(FAILING_TOOL_CALL_ID);
		expect(normalizedId.length).toBeLessThanOrEqual(40);
		expect(normalizedId).toMatch(/^[a-zA-Z0-9_-]+$/);
	});

	it.skipIf(!openrouterKey)(
		"openrouter should handle prefilled context with long pipe-separated IDs",
		async () => {
			const model = getModel("openrouter", "openai/gpt-5.2-codex");
			const messages = buildPrefilledMessages();

			const response = await completeSimple(
				model,
				{
					systemPrompt: "You are a helpful assistant.",
					messages,
					tools: [echoTool],
				},
				{ apiKey: openrouterKey },
			);

			// Should NOT fail with "call_id too long" error
			expect(response.stopReason, `OpenRouter error: ${response.errorMessage}`).not.toBe("error");
			if (response.errorMessage) {
				expect(response.errorMessage).not.toContain("call_id");
				expect(response.errorMessage).not.toContain("too long");
			}
		},
		30000,
	);

	it.skipIf(!codexToken)(
		"openai-codex should handle prefilled context with long pipe-separated IDs",
		async () => {
			const model = getModel("openai-codex", "gpt-5.5");
			const messages = buildPrefilledMessages();

			const response = await completeSimple(
				model,
				{
					systemPrompt: "You are a helpful assistant.",
					messages,
					tools: [echoTool],
				},
				{ apiKey: codexToken },
			);

			// Should NOT fail with ID validation error
			expect(response.stopReason, `Codex error: ${response.errorMessage}`).not.toBe("error");
			if (response.errorMessage) {
				expect(response.errorMessage).not.toContain("id");
				expect(response.errorMessage).not.toContain("additional characters");
			}
		},
		30000,
	);
});
