/**
 * Tests for session-scoped subprocess environment (pi.setEnv / pi.unsetEnv).
 *
 * Covers the overlay helper, the bash-tool spawnHook seam, pi.exec(), and the
 * extension API that drives them.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { applyEnvOverlay } from "../src/core/env-overlay.ts";
import { execCommand } from "../src/core/exec.ts";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type BashSpawnContext, createBashTool } from "../src/core/tools/bash.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const isWindows = process.platform === "win32";

function getTextOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n") || ""
	);
}

/** Mirrors how AgentSession composes the session environment into the bash tool. */
function spawnHookFor(sessionEnv: Map<string, string | null>) {
	return (context: BashSpawnContext): BashSpawnContext => ({
		...context,
		env: applyEnvOverlay(context.env, sessionEnv),
	});
}

describe("applyEnvOverlay", () => {
	it("sets values, masks with null, and leaves the base untouched", () => {
		const base = { KEEP: "keep", MASK_ME: "inherited" };
		const result = applyEnvOverlay(
			base,
			new Map([
				["ADDED", "added"],
				["MASK_ME", null],
			]),
		);

		expect(result.ADDED).toBe("added");
		expect(result.KEEP).toBe("keep");
		expect("MASK_ME" in result).toBe(false);
		// The base object must not be mutated.
		expect(base.MASK_ME).toBe("inherited");
		expect("ADDED" in base).toBe(false);
	});

	it("applies entries in order so later entries win", () => {
		const result = applyEnvOverlay({}, [
			["TOKEN", "first"],
			["TOKEN", "second"],
		]);
		expect(result.TOKEN).toBe("second");
	});
});

describe.skipIf(isWindows)("session environment in the bash tool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpi-session-env-"));
	});

	afterEach(() => {
		fs.rmSync(testDir, { recursive: true, force: true });
		delete process.env.TEST_SESSION_ENV_INHERITED;
	});

	it("passes session variables to spawned commands", async () => {
		const sessionEnv = new Map<string, string | null>([["TEST_SESSION_ENV", "from-session"]]);
		const bash = createBashTool(testDir, { spawnHook: spawnHookFor(sessionEnv) });

		const result = await bash.execute("call-1", { command: 'echo "value=$TEST_SESSION_ENV"' });

		expect(getTextOutput(result)).toContain("value=from-session");
	});

	it("masks an inherited variable when the overlay value is null", async () => {
		process.env.TEST_SESSION_ENV_INHERITED = "leaked";
		const sessionEnv = new Map<string, string | null>([["TEST_SESSION_ENV_INHERITED", null]]);
		const bash = createBashTool(testDir, { spawnHook: spawnHookFor(sessionEnv) });

		const result = await bash.execute("call-2", {
			command:
				'if env | grep -q "^TEST_SESSION_ENV_INHERITED="; then echo "value=present"; else echo "value=absent"; fi',
		});

		expect(getTextOutput(result)).toContain("value=absent");
	});

	it("does not mutate process.env", async () => {
		const sessionEnv = new Map<string, string | null>([["TEST_SESSION_ENV", "from-session"]]);
		const bash = createBashTool(testDir, { spawnHook: spawnHookFor(sessionEnv) });

		await bash.execute("call-3", { command: "echo hello" });

		expect(process.env.TEST_SESSION_ENV).toBeUndefined();
	});

	it("still runs a user-supplied spawnHook, which can override the session value", async () => {
		const sessionEnv = new Map<string, string | null>([["TEST_SESSION_ENV", "from-session"]]);
		let sawSessionValue: string | undefined;
		const bash = createBashTool(testDir, {
			spawnHook: (context) => {
				// AgentSession applies the session overlay first...
				const withSession = spawnHookFor(sessionEnv)(context);
				sawSessionValue = withSession.env.TEST_SESSION_ENV;
				// ...then a user hook observes and may override it.
				return { ...withSession, env: { ...withSession.env, TEST_SESSION_ENV: "from-user-hook" } };
			},
		});

		const result = await bash.execute("call-4", { command: 'echo "value=$TEST_SESSION_ENV"' });

		expect(sawSessionValue).toBe("from-session");
		expect(getTextOutput(result)).toContain("value=from-user-hook");
	});
});

describe.skipIf(isWindows)("session environment in execCommand", () => {
	afterEach(() => {
		delete process.env.TEST_SESSION_ENV_INHERITED;
	});

	it("passes the session overlay to the child process", async () => {
		const result = await execCommand(
			"sh",
			["-c", 'printf "%s" "$TEST_SESSION_ENV"'],
			process.cwd(),
			undefined,
			new Map([["TEST_SESSION_ENV", "from-session"]]),
		);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("from-session");
		expect(process.env.TEST_SESSION_ENV).toBeUndefined();
	});

	it("gives per-call options.env precedence over the session overlay", async () => {
		const result = await execCommand(
			"sh",
			["-c", 'printf "%s" "$TEST_SESSION_ENV"'],
			process.cwd(),
			{ env: { TEST_SESSION_ENV: "from-call" } },
			new Map([["TEST_SESSION_ENV", "from-session"]]),
		);

		expect(result.stdout).toBe("from-call");
	});

	it("masks an inherited variable when the overlay value is null", async () => {
		process.env.TEST_SESSION_ENV_INHERITED = "leaked";

		const result = await execCommand(
			"sh",
			["-c", 'if env | grep -q "^TEST_SESSION_ENV_INHERITED="; then printf present; else printf absent; fi'],
			process.cwd(),
			undefined,
			new Map([["TEST_SESSION_ENV_INHERITED", null]]),
		);

		expect(result.stdout).toBe("absent");
		// Masking is scoped to the child; pi's own environment is unchanged.
		expect(process.env.TEST_SESSION_ENV_INHERITED).toBe("leaked");
	});
});

describe("pi.setEnv / pi.unsetEnv extension API", () => {
	let tempDir: string;
	let extensionsDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpi-session-env-ext-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
		sessionManager = SessionManager.inMemory();
		modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function loadRunner(source: string): Promise<ExtensionRunner> {
		const extPath = path.join(extensionsDir, "env.ts");
		fs.writeFileSync(extPath, source);
		const result = await loadExtensions([extPath], tempDir);
		expect(result.errors).toEqual([]);
		return new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
	}

	it("records values set during extension load", async () => {
		const runner = await loadRunner(`export default function(pi) {
	pi.setEnv("TEST_SESSION_ENV", "from-extension");
}`);

		expect(runner.getSessionEnv().get("TEST_SESSION_ENV")).toBe("from-extension");
	});

	it("records unsetEnv as an explicit mask", async () => {
		const runner = await loadRunner(`export default function(pi) {
	pi.setEnv("TEST_SESSION_ENV", "from-extension");
	pi.unsetEnv("TEST_SESSION_ENV");
	pi.unsetEnv("TEST_SESSION_ENV_INHERITED");
}`);

		const sessionEnv = runner.getSessionEnv();
		expect(sessionEnv.get("TEST_SESSION_ENV")).toBeNull();
		expect(sessionEnv.get("TEST_SESSION_ENV_INHERITED")).toBeNull();
	});

	it("shares one session environment across extensions", async () => {
		const first = path.join(extensionsDir, "first.ts");
		const second = path.join(extensionsDir, "second.ts");
		fs.writeFileSync(first, `export default function(pi) { pi.setEnv("FIRST", "1"); }`);
		fs.writeFileSync(second, `export default function(pi) { pi.setEnv("SECOND", "2"); }`);

		const result = await loadExtensions([first, second], tempDir);
		const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

		const sessionEnv = runner.getSessionEnv();
		expect(sessionEnv.get("FIRST")).toBe("1");
		expect(sessionEnv.get("SECOND")).toBe("2");
	});

	it("returns a copy so callers cannot mutate runtime state", async () => {
		const runner = await loadRunner(`export default function(pi) { pi.setEnv("KEY", "value"); }`);

		runner.getSessionEnv().set("KEY", "tampered");

		expect(runner.getSessionEnv().get("KEY")).toBe("value");
	});

	it.skipIf(isWindows)("reaches a command spawned through the bash tool", async () => {
		const runner = await loadRunner(`export default function(pi) {
	pi.setEnv("TEST_SESSION_ENV", "end-to-end");
}`);
		const bash = createBashTool(tempDir, { spawnHook: spawnHookFor(runner.getSessionEnv()) });

		const result = await bash.execute("call-e2e", { command: 'echo "value=$TEST_SESSION_ENV"' });

		expect(getTextOutput(result)).toContain("value=end-to-end");
	});
});
