import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPublicPackageLicenses, PACKAGE_LICENSE_FILENAME } from "./package-licenses.mjs";
import { findPackageDirectories } from "./package-workspaces.mjs";

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicPackagePrefix = "@sammorrowdrums/mcpi-";

export const PUBLIC_PACKAGE_ORDER = Object.freeze([
	Object.freeze({ directory: "packages/telemetry", name: "@sammorrowdrums/mcpi-telemetry" }),
	Object.freeze({ directory: "packages/protocol", name: "@sammorrowdrums/mcpi-protocol" }),
	Object.freeze({ directory: "packages/tui", name: "@sammorrowdrums/mcpi-tui" }),
	Object.freeze({ directory: "packages/ai", name: "@sammorrowdrums/mcpi-ai" }),
	Object.freeze({ directory: "packages/client", name: "@sammorrowdrums/mcpi-client" }),
	Object.freeze({ directory: "packages/agent", name: "@sammorrowdrums/mcpi-agent-core" }),
	Object.freeze({ directory: "packages/server", name: "@sammorrowdrums/mcpi-server" }),
	Object.freeze({
		directory: "packages/session-backends/sqlite-node",
		name: "@sammorrowdrums/mcpi-session-backend-sqlite-node",
	}),
	Object.freeze({ directory: "packages/coding-agent", name: "@sammorrowdrums/mcpi" }),
]);

function readPackageJson(repoRoot, directory) {
	return JSON.parse(readFileSync(join(repoRoot, directory, "package.json"), "utf8"));
}

function normalizePath(path) {
	return path.replaceAll("\\", "/");
}

function packageDependencies(manifest) {
	return {
		...(manifest.dependencies ?? {}),
		...(manifest.optionalDependencies ?? {}),
		...(manifest.peerDependencies ?? {}),
	};
}

function isMcpiPackage(name) {
	return name === "@sammorrowdrums/mcpi" || name.startsWith(publicPackagePrefix);
}

export function validatePublicPackageOrder(packages) {
	const packageIndex = new Map(packages.map((pkg, index) => [pkg.name, index]));
	const versions = new Set(packages.map((pkg) => pkg.version));

	if (versions.size !== 1) {
		throw new Error(`Public packages are not lockstep versioned: ${[...versions].join(", ")}`);
	}

	for (const [index, pkg] of packages.entries()) {
		for (const [dependencyName, dependencyVersion] of Object.entries(pkg.dependencies)) {
			const dependencyIndex = packageIndex.get(dependencyName);
			if (dependencyIndex === undefined) {
				throw new Error(`${pkg.name} depends on unlisted public package ${dependencyName}`);
			}
			if (dependencyIndex >= index) {
				throw new Error(
					`${pkg.name} appears before dependency ${dependencyName}; fix PUBLIC_PACKAGE_ORDER before publishing`,
				);
			}
			if (dependencyVersion !== `^${pkg.version}`) {
				throw new Error(
					`${pkg.name} depends on ${dependencyName}@${dependencyVersion}; expected ^${pkg.version} for lockstep publishing`,
				);
			}
		}
	}
}

export function getPublicWorkspacePackages(repoRoot = defaultRepoRoot) {
	const expectedNames = new Set(PUBLIC_PACKAGE_ORDER.map((pkg) => pkg.name));
	const expectedDirectories = new Set(PUBLIC_PACKAGE_ORDER.map((pkg) => pkg.directory));
	const discoveredPublicPackages = findPackageDirectories(join(repoRoot, "packages"))
		.map((directory) => {
			const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
			return {
				directory: normalizePath(relative(repoRoot, directory)),
				manifest,
			};
		})
		.filter(({ manifest }) => manifest.private !== true);
	const discoveredNames = new Set(discoveredPublicPackages.map(({ manifest }) => manifest.name));
	const discoveredDirectories = new Set(discoveredPublicPackages.map(({ directory }) => directory));
	const missing = [...expectedNames].filter((name) => !discoveredNames.has(name));
	const unexpected = [...discoveredNames].filter((name) => !expectedNames.has(name));
	const unexpectedDirectories = [...discoveredDirectories].filter((directory) => !expectedDirectories.has(directory));

	if (missing.length > 0 || unexpected.length > 0 || unexpectedDirectories.length > 0) {
		const errors = [];
		if (missing.length > 0) errors.push(`missing: ${missing.join(", ")}`);
		if (unexpected.length > 0) errors.push(`unexpected: ${unexpected.join(", ")}`);
		if (unexpectedDirectories.length > 0) {
			errors.push(`unexpected directories: ${unexpectedDirectories.join(", ")}`);
		}
		throw new Error(`Public workspace selection does not match the release manifest (${errors.join("; ")})`);
	}

	const { packageLicenses } = assertPublicPackageLicenses(repoRoot, PUBLIC_PACKAGE_ORDER);
	const packages = PUBLIC_PACKAGE_ORDER.map(({ directory, name }) => {
		const manifest = readPackageJson(repoRoot, directory);
		if (manifest.name !== name) {
			throw new Error(`${directory}/package.json has name ${manifest.name}; expected ${name}`);
		}
		if (manifest.private === true) {
			throw new Error(`${name} is in PUBLIC_PACKAGE_ORDER but is marked private`);
		}
		if (manifest.publishConfig?.access !== "public") {
			throw new Error(`${name} must declare publishConfig.access as public`);
		}
		if (manifest.publishConfig?.registry !== "https://registry.npmjs.org/") {
			throw new Error(`${name} must declare the public npm registry in publishConfig.registry`);
		}
		if (manifest.license !== "MIT") {
			throw new Error(`${name} must declare the authoritative MIT license`);
		}
		if (!Array.isArray(manifest.files) || !manifest.files.includes(PACKAGE_LICENSE_FILENAME)) {
			throw new Error(`${name} must include ${PACKAGE_LICENSE_FILENAME} in package.json files`);
		}
		if (
			manifest.repository?.url !== "git+https://github.com/SamMorrowDrums/mcpi.git" ||
			manifest.repository?.directory !== directory
		) {
			throw new Error(`${name} must declare repository metadata for ${directory}`);
		}

		const dependencies = Object.fromEntries(
			Object.entries(packageDependencies(manifest)).filter(([dependencyName]) => isMcpiPackage(dependencyName)),
		);
		return {
			dependencies,
			directory,
			license: packageLicenses.get(directory),
			name,
			version: manifest.version,
		};
	});

	validatePublicPackageOrder(packages);
	return packages;
}

export function getReleaseManifest(options = {}) {
	const packages = getPublicWorkspacePackages(options.repoRoot);
	return {
		distTag: options.distTag ?? "latest",
		version: packages[0].version,
		license: {
			name: "MIT",
			source: "LICENSE",
			sha256: packages[0].license.sha256,
			size: packages[0].license.size,
		},
		packages: packages.map((pkg, index) => ({
			order: index + 1,
			name: pkg.name,
			directory: pkg.directory,
			dependencies: Object.keys(pkg.dependencies),
			license: pkg.license.path,
		})),
	};
}
