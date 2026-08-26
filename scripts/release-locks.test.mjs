import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { findPackageDirectories } from "./package-workspaces.mjs";
import { PUBLIC_PACKAGE_ORDER } from "./release-packages.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const futureVersion = "9.99.0";

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
	await writeFile(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function runNode(script, args, cwd) {
	const result = spawnSync(process.execPath, [join(repoRoot, "scripts", script), ...args], {
		cwd,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
}

test("generates shrinkwrap and installer locks for a future lockstep version", async () => {
	const root = await mkdtemp(join(tmpdir(), "mcpi-release-locks-"));
	try {
		await copyFile(join(repoRoot, "package-lock.json"), join(root, "package-lock.json"));
		for (const sourceDirectory of findPackageDirectories(join(repoRoot, "packages"))) {
			const directory = join(root, relative(repoRoot, sourceDirectory));
			await mkdir(directory, { recursive: true });
			await copyFile(join(sourceDirectory, "package.json"), join(directory, "package.json"));
		}

		for (const { directory } of PUBLIC_PACKAGE_ORDER) {
			const path = join(root, directory, "package.json");
			const manifest = await readJson(path);
			manifest.version = futureVersion;
			await writeJson(path, manifest);
		}

		runNode("sync-versions.js", [join(root, "packages")], root);
		runNode("generate-coding-agent-shrinkwrap.mjs", ["--repo-root", root], root);
		runNode("generate-coding-agent-install-lock.mjs", ["--repo-root", root], root);
		runNode("generate-coding-agent-shrinkwrap.mjs", ["--check", "--repo-root", root], root);
		runNode("generate-coding-agent-install-lock.mjs", ["--check", "--repo-root", root], root);

		const shrinkwrap = await readJson(join(root, "packages/coding-agent/npm-shrinkwrap.json"));
		const installerPackage = await readJson(join(root, "packages/coding-agent/install-lock/package.json"));
		const installerLock = await readJson(join(root, "packages/coding-agent/install-lock/package-lock.json"));

		assert.equal(shrinkwrap.version, futureVersion);
		assert.equal(shrinkwrap.packages[""].version, futureVersion);
		assert.equal(installerPackage.private, true);
		assert.equal(installerPackage.version, futureVersion);
		assert.equal(installerPackage.dependencies["@sammorrowdrums/mcpi"], futureVersion);
		assert.equal(installerLock.version, futureVersion);

		for (const lock of [shrinkwrap, installerLock]) {
			for (const [path, entry] of Object.entries(lock.packages)) {
				if (path.includes("node_modules/@sammorrowdrums/mcpi")) {
					assert.equal(entry.version, futureVersion, path);
					assert.match(entry.resolved, new RegExp(`${futureVersion.replaceAll(".", "\\.")}\\.tgz$`), path);
				}
				if (typeof entry.resolved === "string") {
					assert.doesNotMatch(entry.resolved, /^(file:|link:|workspace:|\.\.?\/|\/)/, path);
				}
			}
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
