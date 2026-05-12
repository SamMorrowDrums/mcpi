/**
 * Test: tool_search on Anthropic via github-copilot proxy.
 * Does the copilot proxy support defer_loading + tool_search?
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

const tools: any[] = [
	{
		name: "load_skill",
		description: "Load an MCP skill by name.",
		input_schema: {
			type: "object",
			properties: { name: { type: "string" } },
			required: ["name"],
		},
	},
	{
		name: "get_stock_price",
		description: "Get the current stock price for a ticker symbol",
		input_schema: {
			type: "object",
			properties: {
				ticker: { type: "string", description: "Stock ticker symbol like AAPL" },
				include_history: { type: "boolean", description: "Include 30-day price history" },
			},
			required: ["ticker"],
		},
		defer_loading: true,
	},
];

async function test(label: string, extraTools: any[], extraHeaders?: Record<string, string>) {
	console.log(`\n=== ${label} ===`);
	try {
		const opts: any = {
			model: "claude-opus-4.7",
			max_tokens: 1024,
			system: "You are helpful. Use tools when asked.",
			tools: [...tools, ...extraTools],
			messages: [{ role: "user", content: "Get Apple stock price with history" }],
		};
		const response = await client.messages.create(opts, extraHeaders ? { headers: extraHeaders } : undefined);
		console.log("Stop:", response.stop_reason);
		for (const b of response.content) {
			if (b.type === "tool_use") console.log(`Call: ${b.name}(${JSON.stringify(b.input)})`);
			else if (b.type === "text") console.log("Text:", b.text.slice(0, 150));
			else console.log("Block:", b.type);
		}
		const tc = response.content.find((b: any) => b.type === "tool_use" && b.name === "get_stock_price");
		if (tc && tc.type === "tool_use") {
			const hasHistory = "include_history" in (tc.input as Record<string, unknown>);
			console.log("include_history:", hasHistory ? "YES (full schema)" : "NO (guessed)");
		}
	} catch (err: any) {
		console.log("Error:", err.status, err.message?.slice(0, 200));
	}
}

async function run() {
	// Test 1: tool_search without beta header
	await test("tool_search (no beta header)", [
		{ type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
	]);

	// Test 2: tool_search with advanced-tool-use beta
	await test(
		"tool_search + advanced-tool-use beta",
		[{ type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" }],
		{ "anthropic-beta": "advanced-tool-use-2025-11-20" },
	);

	// Test 3: tool_reference in tool_result without tool_search
	console.log("\n=== tool_reference without tool_search ===");
	try {
		const response = await client.messages.create({
			model: "claude-opus-4.7",
			max_tokens: 1024,
			system: "You are helpful. Use tools when asked.",
			tools: tools as any,
			messages: [
				{ role: "user", content: "Get Apple stock with history" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "tc1", name: "load_skill", input: { name: "stocks" } }],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "tc1",
							content: [{ type: "tool_reference", tool_name: "get_stock_price" } as any],
						},
					],
				},
			],
		});
		console.log("Stop:", response.stop_reason);
		for (const b of response.content) {
			if (b.type === "tool_use") console.log(`Call: ${b.name}(${JSON.stringify(b.input)})`);
			else console.log("Block:", b.type);
		}
	} catch (err: any) {
		console.log("Error:", err.status, err.message?.slice(0, 200));
	}

	// Test 4: tool_reference with tool_search enabled
	console.log("\n=== tool_reference WITH tool_search ===");
	try {
		const response = await client.messages.create({
			model: "claude-opus-4.7",
			max_tokens: 1024,
			system: "You are helpful. Use tools when asked.",
			tools: [...tools, { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" }] as any,
			messages: [
				{ role: "user", content: "Get Apple stock with history" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "tc1", name: "load_skill", input: { name: "stocks" } }],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "tc1",
							content: [{ type: "tool_reference", tool_name: "get_stock_price" } as any],
						},
					],
				},
			],
		});
		console.log("Stop:", response.stop_reason);
		for (const b of response.content) {
			if (b.type === "tool_use") console.log(`Call: ${b.name}(${JSON.stringify(b.input)})`);
			else console.log("Block:", b.type);
		}
		const tc = response.content.find((b: any) => b.type === "tool_use" && b.name === "get_stock_price");
		if (tc && tc.type === "tool_use") {
			const hasHistory = "include_history" in (tc.input as Record<string, unknown>);
			console.log("include_history:", hasHistory ? "YES" : "NO");
		}
	} catch (err: any) {
		console.log("Error:", err.status, err.message?.slice(0, 200));
	}
}

run().catch(console.error);
