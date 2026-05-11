/**
 * Test: tool_reference WITHOUT tool_search on Anthropic.
 * Can we explicitly enable a deferred tool via tool_reference
 * in a tool_result, without needing the tool_search tool?
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
	console.log("=== Test: tool_reference WITHOUT tool_search ===\n");
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
				// NO tool_search — testing if tool_reference alone works
			],
			messages: [
				{ role: "user", content: "Get the stock price of Apple with history" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "tc_load", name: "load_skill", input: { name: "stocks" } }],
				},
				// tool_result with tool_reference to activate the deferred tool
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "tc_load",
							content: [{ type: "tool_reference", tool_name: "get_stock_price" } as any],
						},
						// Skill body as separate text block
						{
							type: "text",
							text: "Skill loaded. Use get_stock_price to look up prices.",
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
				console.log("Text:", block.text.slice(0, 200));
			}
		}

		const toolCall = response.content.find(
			(b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use" && b.name === "get_stock_price",
		);
		if (toolCall) {
			const hasHistory = "include_history" in (toolCall.input as Record<string, unknown>);
			console.log(`\ninclude_history used: ${hasHistory}`);
			console.log("Result:", hasHistory ? "PASS — full schema visible via tool_reference alone" : "FAIL");
		} else {
			console.log("\nResult: FAIL — no tool call");
		}
	} catch (err: any) {
		console.log("Error:", err.status, err.message?.slice(0, 300));
	}
}

run().catch(console.error);
