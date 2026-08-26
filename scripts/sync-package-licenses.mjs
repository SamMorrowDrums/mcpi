#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPublicPackageLicenses, syncPublicPackageLicenses } from "./package-licenses.mjs";
import { PUBLIC_PACKAGE_ORDER } from "./release-packages.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function printUsage() {
	console.error("Usage: node scripts/sync-package-licenses.mjs [--check]");
}

try {
	const args = process.argv.slice(2);
	if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
		throw new Error(`Unknown arguments: ${args.join(" ")}`);
	}
	const checking = args[0] === "--check";
	const { authoritative, packageLicenses } = checking
		? assertPublicPackageLicenses(repoRoot, PUBLIC_PACKAGE_ORDER)
		: syncPublicPackageLicenses(repoRoot, PUBLIC_PACKAGE_ORDER);
	console.log(
		`${checking ? "Verified" : "Synchronized"} ${packageLicenses.size} public package licenses against ${authoritative.path} (${authoritative.sha256}).`,
	);
	for (const { path } of packageLicenses.values()) {
		console.log(`  ${path}`);
	}
} catch (error) {
	printUsage();
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
