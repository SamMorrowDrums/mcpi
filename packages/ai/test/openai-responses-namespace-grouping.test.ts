import type {
	NamespaceTool,
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
} from "openai/resources/responses/responses.js";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import { convertResponsesTools } from "../src/providers/openai-responses-shared.js";
import type { Context, Model, Tool } from "../src/types.js";

type DeferredMcpTool = Tool & {
	deferred?: boolean;
	mcpServerName?: string;
};

const emptyParameters = Type.Object({});

function createTool(name: string, options: Pick<DeferredMcpTool, "deferred" | "mcpServerName"> = {}): DeferredMcpTool {
	return {
		name,
		description: `${name} description`,
		parameters: emptyParameters,
		...options,
	};
}

function expectNamespace(tool: OpenAITool | undefined): NamespaceTool {
	if (tool?.type !== "namespace") {
		throw new Error("Expected namespace tool");
	}
	return tool;
}

describe("OpenAI Responses namespace grouping", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps a stable non-deferred prefix and groups deferred MCP tools by sanitized namespace", () => {
		const tools: DeferredMcpTool[] = [
			createTool("github_read", { deferred: true }),
			createTool("load_skill"),
			createTool("external_search", { deferred: true }),
			createTool("eager_lookup", { mcpServerName: "eager.example" }),
			createTool("github_write", { deferred: true }),
			createTool("bash"),
			createTool("context_lookup", { deferred: true }),
		];

		const result = convertResponsesTools(tools, {
			namespaceGrouping: {
				github_read: "io.github/server",
				github_write: "io.github/server",
				context_lookup: "team tools/context.7",
			},
		});

		expect(result.map((tool) => tool.type)).toEqual([
			"function",
			"function",
			"function",
			"function",
			"namespace",
			"namespace",
			"tool_search",
		]);
		expect(result[0]).toMatchObject({ name: "load_skill", type: "function" });
		expect(result[1]).toMatchObject({ name: "eager_lookup", type: "function" });
		expect(result[2]).toMatchObject({ name: "bash", type: "function" });
		expect(result[3]).toMatchObject({
			defer_loading: true,
			name: "external_search",
			type: "function",
		});

		const githubNamespace = expectNamespace(result[4]);
		expect(githubNamespace).toMatchObject({
			description: 'MCP server "io.github/server".',
			name: "io-github-server",
		});
		expect(githubNamespace.tools.map((tool) => tool.name)).toEqual(["github_read", "github_write"]);
		expect(githubNamespace.tools).toEqual(expect.arrayContaining([expect.objectContaining({ defer_loading: true })]));

		const contextNamespace = expectNamespace(result[5]);
		expect(contextNamespace.name).toBe("team-tools-context-7");
		expect(contextNamespace.tools.map((tool) => tool.name)).toEqual(["context_lookup"]);
		expect(result.at(-1)).toEqual({ type: "tool_search" });
	});

	it("preserves the flat conversion path when no namespace map is supplied", () => {
		const result = convertResponsesTools([
			createTool("deferred_first", { deferred: true }),
			createTool("always_loaded"),
		]);

		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({
			defer_loading: true,
			name: "deferred_first",
			type: "function",
		});
		expect(result[1]).toMatchObject({ name: "always_loaded", type: "function" });
	});

	it("auto-detects deferred mcpServerName metadata in the request builder", async () => {
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
		const context: Context = {
			messages: [{ role: "user", content: "Use a tool.", timestamp: Date.now() }],
			tools: [
				createTool("standalone_search", { deferred: true }),
				createTool("load_skill", { mcpServerName: "eager.example" }),
				createTool("github_read", {
					deferred: true,
					mcpServerName: "github.com/mcp",
				}),
			],
		};
		let capturedPayload: ResponseCreateParamsStreaming | undefined;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(model, context, {
			apiKey: "test-key",
			onPayload: (payload) => {
				capturedPayload = payload as ResponseCreateParamsStreaming;
			},
		});
		await stream.result();

		expect(capturedPayload?.tools?.map((tool) => tool.type)).toEqual([
			"function",
			"function",
			"namespace",
			"tool_search",
		]);
		expect(capturedPayload?.tools?.[0]).toMatchObject({ name: "load_skill", type: "function" });
		expect(capturedPayload?.tools?.[1]).toMatchObject({
			defer_loading: true,
			name: "standalone_search",
			type: "function",
		});
		const namespace = expectNamespace(capturedPayload?.tools?.[2]);
		expect(namespace.name).toBe("github-com-mcp");
		expect(namespace.tools.map((tool) => tool.name)).toEqual(["github_read"]);
		expect(capturedPayload?.tools?.[3]).toEqual({ type: "tool_search" });
	});
});
