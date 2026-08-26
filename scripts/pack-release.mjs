#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packPackage } from "./npm-package-utils.mjs";
import { getPublicWorkspacePackages, getReleaseManifest } from "./release-packages.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function printUsage() {
	console.log(`Usage: node scripts/pack-release.mjs [--manifest | --dry-run | --out <directory>]

  --manifest       Print the exact package order without requiring build output
  --dry-run        Validate all nine built packages with npm pack --dry-run
  --out <dir>      Pack all nine built packages into an empty directory outside the repository
`);
}

function parseArgs(args) {
	const options = { dryRun: false, manifest: false, outDir: undefined };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--manifest") {
			options.manifest = true;
			continue;
		}
		if (arg === "--dry-run") {
			options.dryRun = true;
			continue;
		}
		if (arg === "--out") {
			options.outDir = args[++index];
			if (!options.outDir) throw new Error("--out requires a directory");
			continue;
		}
		if (arg === "--help") {
			printUsage();
			process.exit(0);
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	const selectedModes = [options.manifest, options.dryRun, Boolean(options.outDir)].filter(Boolean);
	if (selectedModes.length !== 1) {
		throw new Error("Choose exactly one of --manifest, --dry-run, or --out");
	}
	return options;
}

function isInsidePath(child, parent) {
	const relativePath = relative(parent, child);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function prepareOutputDirectory(outDir) {
	const resolved = resolve(outDir);
	if (isInsidePath(resolved, repoRoot)) {
		throw new Error(`Package output must be outside the repository: ${resolved}`);
	}
	if (existsSync(resolved) && readdirSync(resolved).length > 0) {
		throw new Error(`Package output directory must be empty: ${resolved}`);
	}
	mkdirSync(resolved, { recursive: true });
	return resolved;
}

try {
	const options = parseArgs(process.argv.slice(2));
	if (options.manifest) {
		console.log(JSON.stringify(getReleaseManifest(), null, "\t"));
	} else {
		const packages = getPublicWorkspacePackages();
		const destination = options.outDir ? prepareOutputDirectory(options.outDir) : undefined;
		console.log(`${options.dryRun ? "Validating" : "Packing"} ${packages.length} packages in release DAG order.\n`);
		for (const pkg of packages) {
			console.log(`${pkg.name}@${pkg.version}`);
			packPackage(pkg, { destination, dryRun: options.dryRun });
			console.log();
		}
		if (destination) {
			console.log(`Packed release artifacts: ${destination}`);
		}
	}
} catch (error) {
	printUsage();
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
