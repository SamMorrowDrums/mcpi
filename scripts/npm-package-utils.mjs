import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const BOOTSTRAP_DIST_TAG = "bootstrap";

export function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

export function runCommand(command, args, options = {}) {
	if (options.log !== false) {
		console.log(`$ ${[command, ...args].join(" ")}`);
	}
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
		throw new Error(
			output
				? `Command failed: ${command} ${args.join(" ")}\n${output}`
				: `Command failed: ${command} ${args.join(" ")}`,
		);
	}

	return result;
}

export function assertBuildOutputExists(directory) {
	if (!existsSync(join(directory, "dist"))) {
		throw new Error(`${directory}/dist does not exist. Run npm run build before packing or publishing.`);
	}
}

export function parsePackOutput(stdout) {
	const parsed = JSON.parse(stdout);
	const packed = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
	if (!packed?.filename || !Array.isArray(packed.files)) {
		throw new Error("npm pack returned an unexpected result");
	}
	return packed;
}

export function packPackage(pkg, options = {}) {
	assertBuildOutputExists(pkg.directory);
	const args = ["pack", "--ignore-scripts", "--json"];
	if (options.dryRun) {
		args.push("--dry-run");
	}
	if (options.destination) {
		args.push("--pack-destination", options.destination);
	}
	const result = runCommand("npm", args, { capture: true, cwd: pkg.directory });
	const packed = parsePackOutput(result.stdout);
	console.log(
		`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`,
	);
	return packed;
}

function npmViewExists(subject, args, spawn = spawnSync) {
	const result = spawn(commandForPlatform("npm"), args, {
		encoding: "utf8",
		stdio: ["inherit", "pipe", "pipe"],
	});

	if (result.status === 0 && result.stdout.trim()) {
		return true;
	}

	const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
	if (
		result.status !== 0 &&
		(output.includes("E404") ||
			output.includes("404 Not Found") ||
			output.includes("ETARGET") ||
			output.includes("No matching version found"))
	) {
		return false;
	}

	throw new Error(output ? `Failed to query ${subject}\n${output}` : `Failed to query ${subject}`);
}

export function isPackageRegistered(name, spawn = spawnSync) {
	if (
		npmViewExists(
			`${name}@${BOOTSTRAP_DIST_TAG}`,
			["view", `${name}@${BOOTSTRAP_DIST_TAG}`, "version", "--json"],
			spawn,
		)
	) {
		return true;
	}
	return npmViewExists(`${name}@latest`, ["view", `${name}@latest`, "version", "--json"], spawn);
}

export function isPackageVersionPublished(name, version) {
	return npmViewExists(`${name}@${version}`, ["view", `${name}@${version}`, "version", "--json"]);
}
