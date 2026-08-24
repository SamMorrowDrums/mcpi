import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getLegacyPathMigrationError } from "../src/path-migration.ts";

const cwd = "/work/project";
const homeDir = "/home/tester";
const configDir = "/xdg/config/mcpi";
const stateDir = "/xdg/state/mcpi";
const cacheDir = "/xdg/cache/mcpi";
const sessionDir = join(stateDir, "sessions");

function check(paths: string[], env: NodeJS.ProcessEnv = {}): Error | undefined {
	const existingPaths = new Set(paths);
	return getLegacyPathMigrationError({
		cwd,
		homeDir,
		configDir,
		stateDir,
		cacheDir,
		sessionDir,
		env,
		pathExists: (path) => existingPaths.has(path),
	});
}

describe("legacy pi path migration", () => {
	it("does not report legacy paths when none exist", () => {
		expect(check([])).toBeUndefined();
	});

	it("reports an actionable project config migration without moving files", () => {
		const legacyProjectDir = join(cwd, ".pi");
		const error = check([legacyProjectDir]);

		expect(error?.message).toContain("mcpi no longer reads legacy pi config paths.");
		expect(error?.message).toContain(`move "${legacyProjectDir}" to "${join(cwd, ".mcpi")}"`);
		expect(error?.message).toContain("No files were moved automatically.");
	});

	it("reports separate XDG destinations for legacy user data", () => {
		const legacyUserDir = join(homeDir, ".pi", "agent");
		const error = check([legacyUserDir]);

		expect(error?.message).toContain(`mcpi does not read "${legacyUserDir}"`);
		expect(error?.message).toContain(`settings, credentials, and user resources to "${configDir}"`);
		expect(error?.message).toContain(`logs and session JSONL files to "${stateDir}"`);
		expect(error?.message).toContain(`sessions belong in "${sessionDir}"`);
		expect(error?.message).toContain(`caches under "${cacheDir}"`);
	});

	it("does not treat PI_CODING_AGENT_DIR as a compatibility override", () => {
		const legacyUserDir = join(homeDir, ".pi", "agent");
		const error = check([legacyUserDir], { PI_CODING_AGENT_DIR: "/legacy/override" });

		expect(error).toBeDefined();
		expect(error?.message).toContain("MCPI_CODING_AGENT_DIR");
	});

	it("allows an explicit MCPI_CODING_AGENT_DIR migration target", () => {
		const legacyUserDir = join(homeDir, ".pi", "agent");

		expect(check([legacyUserDir], { MCPI_CODING_AGENT_DIR: "/migrated/root" })).toBeUndefined();
	});

	it("does not block when the corresponding mcpi path already exists", () => {
		expect(check([join(cwd, ".pi"), join(cwd, ".mcpi")])).toBeUndefined();
		expect(check([join(homeDir, ".pi", "agent"), configDir, stateDir, sessionDir, cacheDir])).toBeUndefined();
	});

	it("reports only destinations still missing from a partial user migration", () => {
		const legacyUserDir = join(homeDir, ".pi", "agent");
		const error = check([legacyUserDir, configDir, stateDir]);

		expect(error?.message).not.toContain("settings, credentials, and user resources");
		expect(error?.message).toContain(`session JSONL files to "${sessionDir}"`);
		expect(error?.message).toContain(`caches under "${cacheDir}"`);
	});
});
