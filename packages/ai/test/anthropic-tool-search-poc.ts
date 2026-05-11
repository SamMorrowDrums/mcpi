/**
 * Test: Does adding tool_search on Anthropic properly reveal
 * deferred tool schemas after load_skill?
 */
import Anthropic from "@anthropic-ai/sdk";
import { getGitHubCopilotBaseUrl } from "../src/utils/oauth/github-copilot.js";
import { resolveApiKey } from "./oauth.js";

const oauthToken = await resolveApiKey("github-copilot");
if (!oauthToken) {
	console.error("No token");
	process.exit(1);
}

const baseUrl = getGitHubCopilotBaseUrl(oauthToken);
const client = new Anthropic({
	apiKey: null,
	authToken: oauthToken,
	baseURL: baseUrl,
	defaultHeaders: {
		accept: "application/json",
		"User-Agent": "GitHubCopilotChat/0.35.0",
		"Editor-Version": "vscode/1.107.0",
		"Editor-Plugin-Version": "copilot-chat/0.35.0",
		"Copilot-Integration-Id": "vscode-chat",
		"X-Initiator": "user",
		"Openai-Intent": "conversation-edits",
	},
});

async function run() {
	console.log("=== Test: Anthropic defer_loading + tool_search ===\n");
	try {
		const response = await client.messages.create({
			model: "claude-opus-4.7",
			max_tokens: 1024,
			system: `You are a helpful assistant with MCP skills.
Call load_skill to discover tools. After loading a skill, call the tools it names.`,
			tools: [
				{
					name: "load_skill",
					description: "Load an MCP skill by name.",
					input_schema: {
						type: "object" as const,
						properties: { name: { type: "string" } },
						required: ["name"],
					},
				},
				{
					name: "get_stock_price",
					description: "Get the current stock price for a ticker symbol",
					input_schema: {
						type: "object" as const,
						properties: {
							ticker: { type: "string", description: "Stock ticker symbol like AAPL" },
							include_history: { type: "boolean", description: "Include 30-day price history" },
						},
						required: ["ticker"],
					},
					defer_loading: true,
				},
				// Add tool search
				{
					type: "tool_search_tool_regex_20251119",
					name: "tool_search_tool_regex",
				} as any,
			],
			messages: [
				{ role: "user", content: "Get the stock price of Apple with history" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "tc_load", name: "load_skill", input: { name: "stocks" } }],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "tc_load",
							content:
								"# Stocks Skill\n\nUse get_stock_price to look up prices.\nAllowed tools: get_stock_price",
						},
					],
				},
			],
		});

		console.log("Stop reason:", response.stop_reason);
		for (const block of response.content) {
			if (block.type === "tool_use") {
				console.log(`Tool call: ${block.name}(${JSON.stringify(block.input)})`);
			} else if (block.type === "text") {
				console.log("Text:", block.text.slice(0, 300));
			} else {
				console.log("Block:", block.type, JSON.stringify(block).slice(0, 200));
			}
		}

		// Check if include_history was used (proves schema was visible)
		const toolCall = response.content.find(
			(b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use" && b.name === "get_stock_price",
		);
		if (toolCall) {
			const hasHistory = "include_history" in (toolCall.input as Record<string, unknown>);
			console.log(`\ninclude_history param used: ${hasHistory}`);
			console.log("Result:", hasHistory ? "PASS — model saw full schema" : "FAIL — model guessed params");
		}
	} catch (err: any) {
		console.log("Error:", err.status, err.message?.slice(0, 300));
	}
}

run().catch(console.error);
