import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const AUTHORITATIVE_LICENSE_PATH = "LICENSE";
export const PACKAGE_LICENSE_FILENAME = "LICENSE";

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function readAuthoritativeLicense(repoRoot) {
	const path = join(repoRoot, AUTHORITATIVE_LICENSE_PATH);
	if (!existsSync(path)) {
		throw new Error(`Authoritative license is missing: ${AUTHORITATIVE_LICENSE_PATH}`);
	}
	const bytes = readFileSync(path);
	return {
		bytes,
		path: AUTHORITATIVE_LICENSE_PATH,
		sha256: sha256(bytes),
		size: bytes.length,
	};
}

export function assertPublicPackageLicenses(repoRoot, packages) {
	const authoritative = readAuthoritativeLicense(repoRoot);
	const packageLicenses = new Map();

	for (const pkg of packages) {
		const relativePath = `${pkg.directory}/${PACKAGE_LICENSE_FILENAME}`;
		const path = join(repoRoot, relativePath);
		if (!existsSync(path)) {
			throw new Error(`${pkg.name} is missing ${relativePath}; run npm run sync:licenses`);
		}
		const bytes = readFileSync(path);
		if (!bytes.equals(authoritative.bytes)) {
			throw new Error(`${relativePath} differs from ${AUTHORITATIVE_LICENSE_PATH}; run npm run sync:licenses`);
		}
		packageLicenses.set(pkg.directory, {
			path: relativePath,
			sha256: authoritative.sha256,
			size: authoritative.size,
		});
	}

	return { authoritative, packageLicenses };
}

export function syncPublicPackageLicenses(repoRoot, packages) {
	const authoritative = readAuthoritativeLicense(repoRoot);
	for (const pkg of packages) {
		copyFileSync(join(repoRoot, authoritative.path), join(repoRoot, pkg.directory, PACKAGE_LICENSE_FILENAME));
	}
	return assertPublicPackageLicenses(repoRoot, packages);
}
