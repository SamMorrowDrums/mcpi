#!/usr/bin/env node
/**
 * Release script for mcpi
 *
 * Usage:
 *   node scripts/release.mjs <major|minor|patch>
 *   node scripts/release.mjs <x.y.z>
 *
 * Steps:
 * 1. Check for uncommitted changes
 * 2. Verify HEAD is the reviewed origin/main tip
 * 3. Verify every public workspace package is registered on npm
 * 4. Bump version via npm run version:xxx or set an explicit version
 * 5. Update CHANGELOG.md files: [Unreleased] -> [version] - date
 * 6. Regenerate release artifacts
 * 7. Run checks and tests
 * 8. Commit and tag the release
 * 9. Add new [Unreleased] section to changelogs
 * 10. Commit next-cycle changelog updates
 * 11. Atomically push main and the tag to trigger CI publication
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPackageRegistered } from "./npm-package-utils.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";
import { assertReleaseRefSafety } from "./release-ref-safety.mjs";

const RELEASE_TARGET = process.argv[2];
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

if (!RELEASE_TARGET || (!BUMP_TYPES.has(RELEASE_TARGET) && !SEMVER_RE.test(RELEASE_TARGET))) {
	console.error("Usage: node scripts/release.mjs <major|minor|patch|x.y.z>");
	process.exit(1);
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
	} catch (e) {
		if (!options.ignoreError) {
			console.error(`Command failed: ${cmd}`);
			process.exit(1);
		}
		return null;
	}
}

function getVersion() {
	const pkg = JSON.parse(readFileSync("packages/ai/package.json", "utf-8"));
	return pkg.version;
}

function assertPackagesAreRegisteredWithNpm() {
	const packageNames = getPublicWorkspacePackages().map((pkg) => pkg.name);
	const unregisteredPackages = [];

	console.log("Checking npm package registration...");
	for (const packageName of packageNames) {
		if (isPackageRegistered(packageName)) {
			console.log(`  ${packageName}`);
			continue;
		}
		unregisteredPackages.push(packageName);
	}

	if (unregisteredPackages.length > 0) {
		throw new Error(`The following public workspace packages are not registered on npm:\n${unregisteredPackages.map((packageName) => `  ${packageName}`).join("\n")}\nRegister them before running a release.`);
	}

	console.log("  All public workspace packages are registered on npm\n");
}

function compareVersions(a, b) {
	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);

	for (let i = 0; i < 3; i++) {
		const diff = (aParts[i] || 0) - (bParts[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}

	return 0;
}

function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function removeStaleWorkspaceLockEntries() {
	const workspaceVersions = new Map(
		getPublicWorkspacePackages().map((pkg) => [pkg.name, pkg.version]),
	);
	const lockPath = "package-lock.json";
	const lock = JSON.parse(readFileSync(lockPath, "utf8"));
	let removed = 0;

	for (const [path, pkg] of Object.entries(lock.packages)) {
		if (!path.startsWith("packages/") || pkg.link === true) {
			continue;
		}
		for (const [name, version] of workspaceVersions) {
			if (path.endsWith(`/node_modules/${name}`) && pkg.version !== version) {
				delete lock.packages[path];
				removed++;
				break;
			}
		}
	}

	if (removed > 0) {
		writeFileSync(lockPath, `${JSON.stringify(lock, null, "\t")}\n`);
		console.log(`Removed ${removed} stale workspace package lock ${removed === 1 ? "entry" : "entries"}.`);
	}
}

function stageChangedFiles() {
	const output = run("git ls-files -m -o -d --exclude-standard", { silent: true });
	const paths = [...new Set((output || "").split("\n").map((line) => line.trim()).filter(Boolean))];
	if (paths.length === 0) {
		return;
	}

	run(`git add -- ${paths.map(shellQuote).join(" ")}`);
}

function bumpOrSetVersion(target) {
	const currentVersion = getVersion();

	if (BUMP_TYPES.has(target)) {
		console.log(`Bumping version (${target})...`);
		run(`npm run version:${target}`);
	} else {
		if (compareVersions(target, currentVersion) <= 0) {
			console.error(`Error: explicit version ${target} must be greater than current version ${currentVersion}.`);
			process.exit(1);
		}

		console.log(`Setting explicit version (${target})...`);
		run(`npm version ${target} --workspaces --no-git-tag-version --no-workspaces-update && node scripts/sync-versions.js && npm install --package-lock-only --ignore-scripts`);
	}

	// npm version can temporarily install the previous workspace versions before
	// sync-versions updates inter-package ranges. Remove those stale lock entries,
	// refresh the lockfile, then hydrate from the final dependency graph.
	removeStaleWorkspaceLockEntries();
	run("npm install --package-lock-only --ignore-scripts");
	run("npm ci --ignore-scripts");
	return getVersion();
}

function getChangelogs() {
	return getPublicWorkspacePackages().map(({ directory, name }) => {
		const path = join(directory, "CHANGELOG.md");
		if (!existsSync(path)) {
			throw new Error(`${name} is missing ${path}`);
		}
		return path;
	});
}

function updateChangelogsForRelease(version) {
	const date = new Date().toISOString().split("T")[0];
	const changelogs = getChangelogs();

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");
		const unreleasedSections = content.match(/^## \[Unreleased\]$/gm) ?? [];
		if (unreleasedSections.length !== 1) {
			throw new Error(`${changelog} must contain exactly one [Unreleased] section before release`);
		}

		const updated = content.replace("## [Unreleased]", `## [${version}] - ${date}`);
		writeFileSync(changelog, updated);
		console.log(`  Updated ${changelog}`);
	}
}

function addUnreleasedSection() {
	const changelogs = getChangelogs();
	const unreleasedSection = "## [Unreleased]\n\n";

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");
		if (content.includes("## [Unreleased]")) {
			throw new Error(`${changelog} already contains an [Unreleased] section`);
		}

		// Insert after "# Changelog\n\n"
		const updated = content.replace(/^(# Changelog\n\n)/, `$1${unreleasedSection}`);
		if (updated === content) {
			throw new Error(`${changelog} does not start with the expected changelog heading`);
		}
		writeFileSync(changelog, updated);
		console.log(`  Added [Unreleased] to ${changelog}`);
	}
}

// Main flow
console.log("\n=== Release Script ===\n");

// 1. Check for uncommitted changes
console.log("Checking for uncommitted changes...");
const status = run("git status --porcelain", { silent: true });
if (status && status.trim()) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}
console.log("  Working directory clean\n");

// 2. Require the reviewed origin/main tip before modifying the worktree.
assertReleaseRefSafety();

// 3. Verify npm package registration before modifying the worktree.
assertPackagesAreRegisteredWithNpm();

// 4. Bump or set version
const version = bumpOrSetVersion(RELEASE_TARGET);
console.log(`  New version: ${version}\n`);

// 5. Update changelogs
console.log("Updating CHANGELOG.md files...");
updateChangelogsForRelease(version);
console.log();

// 6. Regenerate release artifacts
console.log("Regenerating release artifacts...");
run("npm run generate:models");
run("npm run check:model-data");
run("npm run shrinkwrap:coding-agent");
run("npm run install-lock:coding-agent");
console.log();

// 7. Run checks and tests
console.log("Running checks...");
run("npm run check");
console.log();

console.log("Building packages for tests...");
run("npm run build:offline");
console.log();

console.log("Running tests...");
run("./test.sh", { env: { ...process.env, RELEASE_TAG: `v${version}` } });
console.log();

// 8. Commit and tag
console.log("Committing and tagging...");
stageChangedFiles();
run(`git commit -m "Release v${version}"`);
run(`git tag v${version}`);
console.log();

// 9. Add new [Unreleased] sections
console.log("Adding [Unreleased] sections for next cycle...");
addUnreleasedSection();
console.log();

// 10. Commit
console.log("Committing changelog updates...");
stageChangedFiles();
run(`git commit -m "Add [Unreleased] section for next cycle"`);
console.log();

// 11. Push the reviewed main ref and tag atomically.
console.log("Pushing main and tag to remote atomically...");
run(`git push --atomic origin HEAD:refs/heads/main refs/tags/v${version}`);
console.log();

console.log(`=== Prepared release v${version}; CI publication starts after the tag push ===`);
