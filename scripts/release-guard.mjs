#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const RELEASE_TAG_RE = /^v(\d+\.\d+\.\d+)$/;

function printUsage() {
	console.error("Usage: node scripts/release-guard.mjs --tag <vX.Y.Z> [--source-ref <ref>]");
}

function parseArgs(args) {
	const options = { sourceRef: undefined, tag: undefined };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--tag") {
			options.tag = args[++index];
			if (!options.tag) throw new Error("--tag requires a value");
			continue;
		}
		if (arg === "--source-ref") {
			options.sourceRef = args[++index];
			if (!options.sourceRef) throw new Error("--source-ref requires a value");
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	if (!options.tag) throw new Error("--tag is required");
	options.sourceRef ??= options.tag;
	return options;
}

function resolveCommit(ref) {
	const result = spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
		throw new Error(`Cannot resolve ${ref} to a commit${output ? `:\n${output}` : ""}`);
	}
	return result.stdout.trim();
}

export function validateReleaseContext({ headSha, packages, sourceSha, tag, tagSha }) {
	const match = RELEASE_TAG_RE.exec(tag);
	if (!match) {
		throw new Error(`Stable release tag must be vX.Y.Z; received ${tag}`);
	}
	const version = match[1];
	const mismatches = packages.filter((pkg) => pkg.version !== version);
	if (mismatches.length > 0) {
		throw new Error(
			`Release tag ${tag} does not match every public package:\n${mismatches
				.map((pkg) => `  ${pkg.name}: ${pkg.version}`)
				.join("\n")}`,
		);
	}
	if (headSha !== tagSha) {
		throw new Error(`Checked-out HEAD ${headSha} does not match reviewed tag ${tag} at ${tagSha}`);
	}
	if (sourceSha !== tagSha) {
		throw new Error(`Source ref resolves to ${sourceSha}, but reviewed tag ${tag} resolves to ${tagSha}`);
	}
	return version;
}

function main() {
	try {
		const options = parseArgs(process.argv.slice(2));
		const packages = getPublicWorkspacePackages();
		const headSha = resolveCommit("HEAD");
		const tagSha = resolveCommit(options.tag);
		const sourceSha = resolveCommit(options.sourceRef);
		const version = validateReleaseContext({
			headSha,
			packages,
			sourceSha,
			tag: options.tag,
			tagSha,
		});
		console.log(`Release guard passed: ${options.tag} (${version}) -> ${tagSha}`);
	} catch (error) {
		printUsage();
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
