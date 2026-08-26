import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { PACKAGE_LICENSE_FILENAME } from "./package-licenses.mjs";

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

function readPackageLicense(pkg) {
	if (!pkg.license) {
		throw new Error(`${pkg.name} is missing release license metadata`);
	}
	const path = join(pkg.directory, PACKAGE_LICENSE_FILENAME);
	if (!existsSync(path)) {
		throw new Error(`${pkg.name} is missing ${path}`);
	}
	const bytes = readFileSync(path);
	const digest = createHash("sha256").update(bytes).digest("hex");
	if (bytes.length !== pkg.license.size || digest !== pkg.license.sha256) {
		throw new Error(`${path} does not match the authoritative release license metadata`);
	}
	return bytes;
}

function assertPackLicenseMetadata(packed, pkg, expectedLicense) {
	const licenseFiles = packed.files.filter(({ path }) => path === PACKAGE_LICENSE_FILENAME);
	if (licenseFiles.length !== 1) {
		throw new Error(
			`${pkg.name} pack output must contain exactly one ${PACKAGE_LICENSE_FILENAME}; found ${licenseFiles.length}`,
		);
	}
	if (licenseFiles[0].size !== expectedLicense.length) {
		throw new Error(
			`${pkg.name} packed ${PACKAGE_LICENSE_FILENAME} has ${licenseFiles[0].size} bytes; expected ${expectedLicense.length}`,
		);
	}
}

function readTarString(field) {
	const terminator = field.indexOf(0);
	return field.subarray(0, terminator === -1 ? field.length : terminator).toString("utf8");
}

function readTarSize(field, tarballPath) {
	const encoded = readTarString(field).trim();
	if (!/^[0-7]+$/.test(encoded)) {
		throw new Error(`Invalid tar entry size in ${tarballPath}`);
	}
	return Number.parseInt(encoded, 8);
}

function readTarballEntry(tarballPath, expectedPath) {
	const archive = gunzipSync(readFileSync(tarballPath));
	let offset = 0;

	while (offset + 512 <= archive.length) {
		const header = archive.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) {
			break;
		}
		const name = readTarString(header.subarray(0, 100));
		const prefix = readTarString(header.subarray(345, 500));
		const path = prefix ? `${prefix}/${name}` : name;
		const size = readTarSize(header.subarray(124, 136), tarballPath);
		const contentStart = offset + 512;
		const contentEnd = contentStart + size;
		if (contentEnd > archive.length) {
			throw new Error(`Truncated tar entry ${path} in ${tarballPath}`);
		}
		if (path === expectedPath) {
			return archive.subarray(contentStart, contentEnd);
		}
		offset = contentStart + Math.ceil(size / 512) * 512;
	}

	throw new Error(`${tarballPath} does not contain ${expectedPath}`);
}

function assertTarballLicense(tarballPath, pkg, expectedLicense) {
	const packedLicense = readTarballEntry(tarballPath, `package/${PACKAGE_LICENSE_FILENAME}`);
	if (!packedLicense.equals(expectedLicense)) {
		throw new Error(
			`${pkg.name} tarball ${tarballPath} contains ${PACKAGE_LICENSE_FILENAME} bytes that differ from the authoritative license`,
		);
	}
}

export function packPackage(pkg, options = {}) {
	assertBuildOutputExists(pkg.directory);
	const expectedLicense = readPackageLicense(pkg);
	const args = ["pack", "--ignore-scripts", "--json"];
	if (options.dryRun) {
		args.push("--dry-run");
	}
	const destination = options.destination ? resolve(options.destination) : resolve(pkg.directory);
	if (options.destination) {
		args.push("--pack-destination", destination);
	}
	const result = runCommand("npm", args, { capture: true, cwd: pkg.directory });
	const packed = parsePackOutput(result.stdout);
	assertPackLicenseMetadata(packed, pkg, expectedLicense);
	if (!options.dryRun) {
		assertTarballLicense(join(destination, packed.filename), pkg, expectedLicense);
	}
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
