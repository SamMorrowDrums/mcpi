import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@sammorrowdrums/mcpi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineTool } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("deferred tool registration", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-deferred-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps a deferred extension tool active, dispatchable, and marked for the provider", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.create(tempDir, join(agentDir, "sessions"), { id: "deferred-tool-test" });
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.registerTool(
						defineTool({
							name: "mcp_deploy",
							label: "mcp deploy",
							description: "Deploy through a proxied MCP server",
							parameters: Type.Object({ target: Type.String() }),
							deferred: true,
							execute: async (_toolCallId, params) => ({
								content: [{ type: "text", text: `deployed ${params.target}` }],
								details: undefined,
							}),
						}),
					);
					pi.registerTool(
						defineTool({
							name: "mcp_status",
							label: "mcp status",
							description: "Read status from a proxied MCP server",
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: undefined,
							}),
						}),
					);
				},
			],
		});
		await resourceLoader.reload();

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		const toolNames = session.agent.state.tools.map((tool) => tool.name);
		const deferredTool = session.agent.state.tools.find((tool) => tool.name === "mcp_deploy");
		const plainTool = session.agent.state.tools.find((tool) => tool.name === "mcp_status");

		// Registration metadata is visibility only: the tool stays in the agent tools array.
		expect(toolNames).toContain("mcp_deploy");
		expect(deferredTool?.deferred).toBe(true);
		expect(plainTool?.deferred).toBeUndefined();

		// Visibility is not authorization: a deferred tool still executes when the model names it.
		const result = await deferredTool?.execute("call_1", { target: "prod" });
		expect(result?.content).toEqual([{ type: "text", text: "deployed prod" }]);

		// The registry round-trip preserves the flag for renderers and re-registration.
		expect(session.getToolDefinition("mcp_deploy")?.deferred).toBe(true);
		expect(session.getToolDefinition("mcp_status")?.deferred).toBeUndefined();
	});
});
