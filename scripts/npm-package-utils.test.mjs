import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packPackage } from "./npm-package-utils.mjs";

test("package verification checks LICENSE metadata and exact tarball bytes", (t) => {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "mcpi-pack-license-test-"));
	t.after(() => rmSync(fixtureRoot, { force: true, recursive: true }));
	const packageDirectory = join(fixtureRoot, "package");
	const destination = join(fixtureRoot, "tarballs");
	const license = Buffer.from("authoritative license\n");
	mkdirSync(join(packageDirectory, "dist"), { recursive: true });
	mkdirSync(destination);
	writeFileSync(join(packageDirectory, "dist/index.js"), "export {};\n");
	writeFileSync(join(packageDirectory, "LICENSE"), license);
	writeFileSync(
		join(packageDirectory, "package.json"),
		`${JSON.stringify(
			{
				name: "@test/license-pack",
				version: "1.0.0",
				files: ["dist", "LICENSE"],
			},
			null,
			"\t",
		)}\n`,
	);
	const pkg = {
		directory: packageDirectory,
		license: {
			path: "package/LICENSE",
			sha256: createHash("sha256").update(license).digest("hex"),
			size: license.length,
		},
		name: "@test/license-pack",
	};

	const dryRun = packPackage(pkg, { dryRun: true });
	assert.ok(dryRun.files.some(({ path }) => path === "LICENSE"));
	const packed = packPackage(pkg, { destination });
	assert.ok(existsSync(join(destination, packed.filename)));

	writeFileSync(join(packageDirectory, "LICENSE"), "drifted\n");
	assert.throws(
		() => packPackage(pkg, { dryRun: true }),
		/LICENSE does not match the authoritative release license metadata/,
	);
});
