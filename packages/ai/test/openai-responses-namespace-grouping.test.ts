import { describe, expect, it } from "vitest";
import { convertResponsesTools } from "../src/providers/openai-responses-shared.js";
import type { Tool } from "../src/types.js";
import { Type } from "typebox";

/**
 * Tests for namespace grouping in convertResponsesTools.
 *
 * When `namespaceGrouping` option is provided, deferred MCP tools are grouped
 * into {type: "namespace"} objects by server, non-deferred tools are placed first
 * (cacheable prefix), and {type: "tool_search"} is appended at the end.
 */
describe("convertResponsesTools namespace grouping", () => {
	const makeTools = (count: number, prefix: string, deferred: boolean): Tool[] =>
		Array.from({ length: count }, (_, i) => ({
			name: `${prefix}_${i}`,
			description: `${prefix} tool ${i}`,
			parameters: Type.Object({}),
			...(deferred ? { deferred: true } : {}),
		}));

	it("without namespaceGrouping, produces flat function tools (backward compat)", () => {
		const tools: Tool[] = [
			{ name: "bash", description: "Run shell", parameters: Type.Object({}), deferred: false } as any,
			{ name: "mcp_tool", description: "An MCP tool", parameters: Type.Object({}), deferred: true } as any,
		];

		const result = convertResponsesTools(tools, { strict: false });
		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({ type: "function", name: "bash" });
		expect(result[1]).toMatchObject({ type: "function", name: "mcp_tool", defer_loading: true });
	});

	it("groups deferred MCP tools by server into namespace objects", () => {
		const tools: Tool[] = [
			{ name: "bash", description: "Shell", parameters: Type.Object({}) },
			{ name: "pr_read", description: "Read PR", parameters: Type.Object({}), deferred: true } as any,
			{ name: "pr_write", description: "Write PR", parameters: Type.Object({}), deferred: true } as any,
			{ name: "search_code", description: "Search", parameters: Type.Object({}), deferred: true } as any,
		];

		const namespaceGrouping: Record<string, string> = {
			pr_read: "github-mcp-server",
			pr_write: "github-mcp-server",
			search_code: "code-search-server",
		};

		const result = convertResponsesTools(tools, { strict: false, namespaceGrouping });

		// Non-deferred first
		expect(result[0]).toMatchObject({ type: "function", name: "bash" });
		expect((result[0] as any).defer_loading).toBeUndefined();

		// Two namespace objects
		const namespaces = result.filter((t) => (t as any).type === "namespace");
		expect(namespaces).toHaveLength(2);

		const ghNamespace = namespaces.find((n) => (n as any).name === "github-mcp-server") as any;
		expect(ghNamespace).toBeDefined();
		expect(ghNamespace.tools).toHaveLength(2);
		expect(ghNamespace.tools.map((t: any) => t.name).sort()).toEqual(["pr_read", "pr_write"]);

		const codeNamespace = namespaces.find((n) => (n as any).name === "code-search-server") as any;
		expect(codeNamespace).toBeDefined();
		expect(codeNamespace.tools).toHaveLength(1);
		expect(codeNamespace.tools[0].name).toBe("search_code");

		// tool_search at end
		const last = result[result.length - 1] as any;
		expect(last.type).toBe("tool_search");
	});

	it("non-deferred tools come first (cacheable prefix), deferred after", () => {
		const tools: Tool[] = [
			// Interleave deferred and non-deferred in input
			{ name: "deferred_a", description: "D", parameters: Type.Object({}), deferred: true } as any,
			{ name: "non_deferred_1", description: "ND", parameters: Type.Object({}) },
			{ name: "deferred_b", description: "D", parameters: Type.Object({}), deferred: true } as any,
			{ name: "non_deferred_2", description: "ND", parameters: Type.Object({}) },
		];

		const namespaceGrouping: Record<string, string> = {
			deferred_a: "server1",
			deferred_b: "server1",
		};

		const result = convertResponsesTools(tools, { strict: false, namespaceGrouping });

		// Non-deferred functions first
		expect(result[0]).toMatchObject({ type: "function", name: "non_deferred_1" });
		expect(result[1]).toMatchObject({ type: "function", name: "non_deferred_2" });

		// Then namespace
		expect((result[2] as any).type).toBe("namespace");

		// Then tool_search
		expect((result[3] as any).type).toBe("tool_search");
	});

	it("sanitizes dots in server names for namespace names", () => {
		const tools: Tool[] = [
			{ name: "tool1", description: "T", parameters: Type.Object({}), deferred: true } as any,
		];

		const namespaceGrouping = { tool1: "io.github.server" };
		const result = convertResponsesTools(tools, { strict: false, namespaceGrouping });

		const ns = result.find((t) => (t as any).type === "namespace") as any;
		expect(ns.name).toBe("io-github-server");
	});

	it("deferred tools without server mapping become standalone deferred", () => {
		const tools: Tool[] = [
			{ name: "mcp_tool", description: "MCP", parameters: Type.Object({}), deferred: true } as any,
			{ name: "external_tool", description: "External", parameters: Type.Object({}), deferred: true } as any,
		];

		// Only mcp_tool maps to a server
		const namespaceGrouping = { mcp_tool: "my-server" };
		const result = convertResponsesTools(tools, { strict: false, namespaceGrouping });

		// external_tool is standalone deferred (before namespaces)
		const funcTools = result.filter((t) => (t as any).type === "function");
		expect(funcTools).toHaveLength(1);
		expect(funcTools[0]).toMatchObject({ name: "external_tool", defer_loading: true });

		// mcp_tool grouped into namespace
		const ns = result.find((t) => (t as any).type === "namespace") as any;
		expect(ns.tools[0].name).toBe("mcp_tool");
	});

	it("no tool_search when no deferred tools exist", () => {
		const tools: Tool[] = [
			{ name: "bash", description: "Shell", parameters: Type.Object({}) },
			{ name: "grep", description: "Search", parameters: Type.Object({}) },
		];

		const result = convertResponsesTools(tools, { strict: false, namespaceGrouping: {} });
		expect(result.every((t) => (t as any).type === "function")).toBe(true);
		expect(result.find((t) => (t as any).type === "tool_search")).toBeUndefined();
	});

	it("realistic PDE scenario: Arm B with 80+ deferred MCP tools", () => {
		const nonDeferred: Tool[] = []; // B has no non-deferred tools
		const mcpTools = makeTools(80, "mcp", true);
		const tools = [...nonDeferred, ...mcpTools];

		const namespaceGrouping: Record<string, string> = {};
		for (const t of mcpTools) {
			namespaceGrouping[t.name] = "github-mcp-server";
		}

		const result = convertResponsesTools(tools, { strict: false, namespaceGrouping });

		// One namespace for all 80 tools + tool_search
		expect(result).toHaveLength(2); // 1 namespace + 1 tool_search
		expect((result[0] as any).type).toBe("namespace");
		expect((result[0] as any).tools).toHaveLength(80);
		expect((result[1] as any).type).toBe("tool_search");
	});

	it("realistic PDE scenario: Arm C with non-deferred prefix + deferred MCP", () => {
		// C: load_skill (non-deferred) + deferred MCP tools
		const loadSkill: Tool = { name: "load_skill", description: "Load a skill", parameters: Type.Object({}) };
		const mcpTools = makeTools(40, "mcp", true);
		const tools = [loadSkill, ...mcpTools];

		const namespaceGrouping: Record<string, string> = {};
		for (const t of mcpTools) {
			namespaceGrouping[t.name] = "github-mcp-server";
		}

		const result = convertResponsesTools(tools, { strict: false, namespaceGrouping });

		// load_skill first (cacheable prefix), then namespace, then tool_search
		expect(result).toHaveLength(3);
		expect(result[0]).toMatchObject({ type: "function", name: "load_skill" });
		expect((result[0] as any).defer_loading).toBeUndefined();
		expect((result[1] as any).type).toBe("namespace");
		expect((result[1] as any).tools).toHaveLength(40);
		expect((result[2] as any).type).toBe("tool_search");
	});
});
