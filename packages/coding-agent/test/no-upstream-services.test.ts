import { readdirSync, readFileSync } from "fs";
import { dirname, join, relative } from "path";
import { fileURLToPath } from "url";
import { describe, expect, test } from "vitest";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * mcpi is a fork, so it must not silently depend on services operated for upstream pi.
 * Update checks read the mcpi GitHub release feed, install telemetry is gone, and both
 * the model catalog overlay and the share viewer are opt-in via mcpi-owned env vars.
 */
function sourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(path));
		else if (entry.name.endsWith(".ts")) files.push(path);
	}
	return files;
}

function sourcesMatching(pattern: RegExp): string[] {
	return sourceFiles(SRC_DIR)
		.filter((path) => pattern.test(readFileSync(path, "utf-8")))
		.map((path) => relative(SRC_DIR, path));
}

describe("no upstream service dependencies", () => {
	test("finds source files to scan", () => {
		expect(sourceFiles(SRC_DIR).length).toBeGreaterThan(100);
	});

	test("never contacts pi.dev", () => {
		expect(sourcesMatching(/pi\.dev/)).toEqual([]);
	});

	test("reports no install telemetry", () => {
		expect(sourcesMatching(/report-install/)).toEqual([]);
	});
});
