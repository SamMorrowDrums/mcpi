#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BOOTSTRAP_DIST_TAG, runCommand } from "./npm-package-utils.mjs";
import { publishPackages } from "./publish.mjs";
import { getPublicWorkspacePackages, getReleaseManifest } from "./release-packages.mjs";

export { BOOTSTRAP_DIST_TAG };
const BOOTSTRAP_VERSION_RE = /^\d+\.\d+\.\d+-bootstrap\.\d+$/;

function printUsage() {
	console.error(
		"Usage: node scripts/bootstrap-publish.mjs [--manifest | --dry-run | --confirm-human-auth]",
	);
}

function parseArgs(args) {
	const options = { confirmHumanAuth: false, dryRun: false, manifest: false };
	for (const arg of args) {
		if (arg === "--manifest") {
			options.manifest = true;
			continue;
		}
		if (arg === "--dry-run") {
			options.dryRun = true;
			continue;
		}
		if (arg === "--confirm-human-auth") {
			options.confirmHumanAuth = true;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	if (options.manifest && (options.dryRun || options.confirmHumanAuth)) {
		throw new Error("--manifest cannot be combined with publishing options");
	}
	if (options.dryRun && options.confirmHumanAuth) {
		throw new Error("--dry-run does not require --confirm-human-auth");
	}
	return options;
}

export function validateBootstrapInvocation({ confirmed, env, version }) {
	if (!BOOTSTRAP_VERSION_RE.test(version)) {
		throw new Error(
			`Bootstrap publication requires a prerelease version like 0.85.0-bootstrap.0; received ${version}`,
		);
	}
	if (!confirmed) {
		throw new Error("Bootstrap publication requires --confirm-human-auth");
	}
	if (env.CI && env.CI !== "false") {
		throw new Error("Bootstrap publication is local-only and cannot run in CI");
	}
	if (env.NPM_TOKEN || env.NODE_AUTH_TOKEN) {
		throw new Error("Bootstrap publication requires an interactive npm login, not NPM_TOKEN or NODE_AUTH_TOKEN");
	}
}

function main() {
	try {
		const options = parseArgs(process.argv.slice(2));
		if (options.manifest) {
			console.log(JSON.stringify(getReleaseManifest({ distTag: BOOTSTRAP_DIST_TAG }), null, "\t"));
		} else {
			const packages = getPublicWorkspacePackages();
			if (!options.dryRun) {
				validateBootstrapInvocation({
					confirmed: options.confirmHumanAuth,
					env: process.env,
					version: packages[0].version,
				});
				runCommand("npm", ["whoami"]);
			}
			publishPackages({
				distTag: BOOTSTRAP_DIST_TAG,
				dryRun: options.dryRun,
				packages,
				provenance: false,
			});
		}
	} catch (error) {
		printUsage();
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
