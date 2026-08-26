#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPackageVersionPublished, packPackage, runCommand } from "./npm-package-utils.mjs";
import {
	getPublicWorkspacePackages,
	getReleaseManifest,
	validatePublicPackageOrder,
} from "./release-packages.mjs";

const STABLE_VERSION_RE = /^\d+\.\d+\.\d+$/;

function printUsage() {
	console.error("Usage: node scripts/publish.mjs [--dry-run | --manifest]");
}

function parseArgs(args) {
	const options = { dryRun: false, manifest: false };
	for (const arg of args) {
		if (arg === "--dry-run") {
			options.dryRun = true;
			continue;
		}
		if (arg === "--manifest") {
			options.manifest = true;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	if (options.dryRun && options.manifest) {
		throw new Error("--dry-run and --manifest cannot be combined");
	}
	return options;
}

export function getPublishArguments(options = {}) {
	const args = ["publish", "--access", "public", "--tag", options.distTag ?? "latest"];
	if (options.provenance !== false) {
		args.push("--provenance");
	}
	args.push("--ignore-scripts");
	return args;
}

export function publishPackages(options = {}) {
	const packages = options.packages ?? getPublicWorkspacePackages();
	const version = packages[0]?.version;
	if (!version) {
		throw new Error("No public packages selected for publication");
	}
	const dryRun = options.dryRun ?? false;
	const distTag = options.distTag ?? "latest";
	if (distTag === "latest" && !STABLE_VERSION_RE.test(version)) {
		throw new Error(`Refusing to publish prerelease version ${version} under the latest dist-tag`);
	}
	validatePublicPackageOrder(packages);
	const provenance = options.provenance ?? true;
	const queryPublished = options.queryPublished ?? isPackageVersionPublished;
	const validatePackage =
		options.validatePackage ??
		((pkg) => {
			packPackage(pkg, { dryRun: true });
		});
	const publishPackage =
		options.publishPackage ??
		((pkg) => {
			runCommand("npm", getPublishArguments({ distTag, provenance }), { cwd: pkg.directory });
		});
	console.log(
		`Publishing ${packages.length} mcpi packages at ${version} with dist-tag ${distTag}${dryRun ? " (dry run)" : ""}\n`,
	);

	const packageStates = packages.map((pkg) => {
		const published = queryPublished(pkg.name, pkg.version);
		console.log(
			published
				? `${pkg.name}@${pkg.version} is already published; validating package contents only.`
				: `${pkg.name}@${pkg.version} is not published; validating package contents before publish.`,
		);
		try {
			validatePackage(pkg);
		} catch (error) {
			throw new Error(
				`Package validation failed for ${pkg.name}@${pkg.version}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		console.log();
		return { ...pkg, published };
	});

	if (dryRun) {
		return packageStates;
	}

	console.log("All packages validated; starting serial publication.\n");
	for (const pkg of packageStates) {
		if (pkg.published) {
			console.log(`Skipping ${pkg.name}@${pkg.version}: already published\n`);
			continue;
		}
		console.log(`Publishing ${pkg.name}@${pkg.version} after all declared public dependencies.`);
		try {
			publishPackage(pkg);
		} catch (error) {
			throw new Error(
				`Publication failed for ${pkg.name}@${pkg.version}. Rerun the same command after resolving the registry error; already-published versions will be skipped.\n${error instanceof Error ? error.message : String(error)}`,
			);
		}
		console.log();
	}

	return packageStates;
}

function main() {
	try {
		const options = parseArgs(process.argv.slice(2));
		if (options.manifest) {
			console.log(JSON.stringify(getReleaseManifest(), null, "\t"));
			return;
		}
		publishPackages({ dryRun: options.dryRun });
	} catch (error) {
		printUsage();
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
