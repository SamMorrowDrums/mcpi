import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { printHelp } from "../src/cli/args.ts";
import {
	APP_NAME,
	APP_TITLE,
	CONFIG_DIR_NAME,
	ENV_AGENT_DIR,
	ENV_SESSION_DIR,
	getAgentDir,
	getBinDir,
	getCacheDir,
	getDebugLogPath,
	getModelsStorePath,
	getSessionsDir,
	getStateDir,
} from "../src/config.ts";

const PATH_ENV_NAMES = [
	"MCPI_CODING_AGENT_DIR",
	"PI_CODING_AGENT_DIR",
	"XDG_CONFIG_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
] as const;

describe("public mcpi identity", () => {
	const originalEnvironment = new Map<string, string | undefined>();

	beforeEach(() => {
		for (const name of PATH_ENV_NAMES) {
			originalEnvironment.set(name, process.env[name]);
			delete process.env[name];
		}
	});

	afterEach(() => {
		for (const name of PATH_ENV_NAMES) {
			const value = originalEnvironment.get(name);
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		vi.restoreAllMocks();
	});

	it("uses mcpi for product and public configuration names", () => {
		expect(APP_NAME).toBe("mcpi");
		expect(APP_TITLE).toBe("mcpi");
		expect(CONFIG_DIR_NAME).toBe(".mcpi");
		expect(ENV_AGENT_DIR).toBe("MCPI_CODING_AGENT_DIR");
		expect(ENV_SESSION_DIR).toBe("MCPI_CODING_AGENT_SESSION_DIR");
	});

	it("uses XDG config, state, and cache roots", () => {
		process.env.XDG_CONFIG_HOME = "/tmp/mcpi-config";
		process.env.XDG_STATE_HOME = "/tmp/mcpi-state";
		process.env.XDG_CACHE_HOME = "/tmp/mcpi-cache";

		expect(getAgentDir()).toBe(join("/tmp/mcpi-config", "mcpi"));
		expect(getStateDir()).toBe(join("/tmp/mcpi-state", "mcpi"));
		expect(getSessionsDir()).toBe(join("/tmp/mcpi-state", "mcpi", "sessions"));
		expect(getDebugLogPath()).toBe(join("/tmp/mcpi-state", "mcpi", "mcpi-debug.log"));
		expect(getCacheDir()).toBe(join("/tmp/mcpi-cache", "mcpi"));
		expect(getBinDir()).toBe(join("/tmp/mcpi-cache", "mcpi", "bin"));
		expect(getModelsStorePath()).toBe(join("/tmp/mcpi-cache", "mcpi", "models-store.json"));
	});

	it("uses MCPI_CODING_AGENT_DIR as an explicit single-root override", () => {
		process.env.MCPI_CODING_AGENT_DIR = "/tmp/mcpi-root";

		expect(getAgentDir()).toBe("/tmp/mcpi-root");
		expect(getStateDir()).toBe("/tmp/mcpi-root");
		expect(getCacheDir()).toBe("/tmp/mcpi-root");
		expect(getSessionsDir()).toBe(join("/tmp/mcpi-root", "sessions"));
	});

	it("does not accept the removed PI_CODING_AGENT_DIR alias", () => {
		process.env.PI_CODING_AGENT_DIR = "/tmp/legacy-pi-root";
		process.env.XDG_CONFIG_HOME = "/tmp/mcpi-config";

		expect(getAgentDir()).toBe(join("/tmp/mcpi-config", "mcpi"));
	});

	it("prints mcpi help with only MCPI public variables and current paths", () => {
		process.env.XDG_CONFIG_HOME = "/tmp/mcpi-config";
		process.env.XDG_STATE_HOME = "/tmp/mcpi-state";
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		printHelp();

		const output = log.mock.calls.map(([message]) => String(message)).join("\n");
		expect(output).toContain("mcpi - AI coding assistant");
		expect(output).toContain("mcpi update [source|self|mcpi]");
		expect(output).toContain("MCPI_CODING_AGENT_DIR");
		expect(output).toContain("MCPI_CODING_AGENT_SESSION_DIR");
		expect(output).toContain(join("/tmp/mcpi-state", "mcpi", "sessions"));
		expect(output).not.toMatch(/\bPI_(?:CODING_AGENT|OFFLINE|TELEMETRY|CACHE|SHARE|CATALOG|HARDWARE|TUI)/);
		expect(output).not.toContain("~/.pi");
	});
});
