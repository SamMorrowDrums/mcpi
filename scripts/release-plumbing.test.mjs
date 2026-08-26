import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BOOTSTRAP_DIST_TAG, validateBootstrapInvocation } from "./bootstrap-publish.mjs";
import { isPackageRegistered } from "./npm-package-utils.mjs";
import { getPublishArguments, publishPackages } from "./publish.mjs";
import {
	PUBLIC_PACKAGE_ORDER,
	getPublicWorkspacePackages,
	validatePublicPackageOrder,
} from "./release-packages.mjs";
import { validateReleaseContext } from "./release-guard.mjs";
import { validateReleaseRefState } from "./release-ref-safety.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedNames = [
	"@sammorrowdrums/mcpi-telemetry",
	"@sammorrowdrums/mcpi-protocol",
	"@sammorrowdrums/mcpi-tui",
	"@sammorrowdrums/mcpi-ai",
	"@sammorrowdrums/mcpi-client",
	"@sammorrowdrums/mcpi-agent-core",
	"@sammorrowdrums/mcpi-server",
	"@sammorrowdrums/mcpi-session-backend-sqlite-node",
	"@sammorrowdrums/mcpi",
];

function readJson(path) {
	return JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
}

test("build-binaries is the sole npm publisher and approval gate", () => {
	const workflowDirectory = join(repoRoot, ".github/workflows");
	const workflows = readdirSync(workflowDirectory)
		.filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
		.map((file) => ({
			file,
			text: readFileSync(join(workflowDirectory, file), "utf8"),
		}));
	const combinedWorkflowText = workflows.map(({ text }) => text).join("\n");
	const publishEntrypoints = workflows.filter(({ text }) => text.includes("node scripts/publish.mjs"));
	const approvalJobs = workflows.filter(({ text }) => /^\s+environment: npm-publish$/m.test(text));

	assert.equal(combinedWorkflowText.match(/node scripts\/publish\.mjs/g)?.length, 1);
	assert.equal(combinedWorkflowText.match(/^\s+environment: npm-publish$/gm)?.length, 1);
	assert.deepEqual(
		publishEntrypoints.map(({ file }) => file),
		["build-binaries.yml"],
	);
	assert.deepEqual(
		approvalJobs.map(({ file }) => file),
		["build-binaries.yml"],
	);
	assert.match(publishEntrypoints[0].text, /id-token: write/);
	assert.match(publishEntrypoints[0].text, /npm install -g npm@11\.16\.0 --ignore-scripts/);
	assert.match(
		publishEntrypoints[0].text,
		/SOURCE_REF: \$\{\{ github\.event_name == 'push' && github\.sha \|\|/,
	);
	assert.match(publishEntrypoints[0].text, /ref: \$\{\{ needs\.build\.outputs\.release-sha \}\}/);
	assert.match(publishEntrypoints[0].text, /--source-ref "\$\{RELEASE_SHA\}"/);
	assert.doesNotMatch(combinedWorkflowText, /\bNPM_TOKEN\b/);
	assert.doesNotMatch(readFileSync(join(workflowDirectory, "release.yml"), "utf8"), /\bnpm publish\b|publish\.mjs/);
});

test("selects exactly nine public packages in dependency order", () => {
	const packages = getPublicWorkspacePackages(repoRoot);
	assert.deepEqual(
		PUBLIC_PACKAGE_ORDER.map(({ name }) => name),
		expectedNames,
	);
	assert.deepEqual(
		packages.map(({ name }) => name),
		expectedNames,
	);

	for (const path of [
		"package.json",
		"packages/evals/package.json",
		"packages/coding-agent/install-lock/package.json",
		"packages/coding-agent/examples/extensions/with-deps/package.json",
		"packages/coding-agent/examples/extensions/custom-provider-anthropic/package.json",
		"packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/package.json",
		"packages/coding-agent/examples/extensions/sandbox/package.json",
		"packages/coding-agent/examples/extensions/gondolin/package.json",
	]) {
		assert.equal(readJson(path).private, true, `${path} must stay private`);
	}
});

test("public changelogs match the development or release-tag state", () => {
	const releaseVersion = process.env.RELEASE_TAG?.match(/^v(\d+\.\d+\.\d+)$/)?.[1];
	for (const { directory, name } of getPublicWorkspacePackages(repoRoot)) {
		const changelog = readFileSync(join(repoRoot, directory, "CHANGELOG.md"), "utf8");
		const unreleasedSections = changelog.match(/^## \[Unreleased\]$/gm)?.length ?? 0;
		if (releaseVersion) {
			assert.equal(unreleasedSections, 0, name);
			assert.ok(
				changelog.split("\n").some((line) => line.startsWith(`## [${releaseVersion}] - `)),
				`${name} must contain a ${releaseVersion} release section`,
			);
		} else {
			assert.equal(unreleasedSections, 1, name);
		}
	}
});

test("rejects a publish order that places a dependency later", () => {
	assert.throws(
		() =>
			validatePublicPackageOrder([
				{ dependencies: { second: "^1.0.0" }, name: "first", version: "1.0.0" },
				{ dependencies: {}, name: "second", version: "1.0.0" },
			]),
		/first appears before dependency second/,
	);
});

test("validates every package before an idempotent serial rerun", () => {
	const packages = getPublicWorkspacePackages(repoRoot);
	const events = [];
	const alreadyPublished = new Set([packages[0].name, packages[3].name]);

	publishPackages({
		packages,
		queryPublished: (name) => alreadyPublished.has(name),
		validatePackage: (pkg) => events.push(`validate:${pkg.name}`),
		publishPackage: (pkg) => events.push(`publish:${pkg.name}`),
	});

	assert.deepEqual(
		events.slice(0, packages.length),
		packages.map((pkg) => `validate:${pkg.name}`),
	);
	assert.deepEqual(
		events.slice(packages.length),
		packages.filter((pkg) => !alreadyPublished.has(pkg.name)).map((pkg) => `publish:${pkg.name}`),
	);
});

test("does not publish when pre-pack validation fails", () => {
	const packages = getPublicWorkspacePackages(repoRoot);
	let publishCount = 0;
	assert.throws(
		() =>
			publishPackages({
				packages,
				queryPublished: () => false,
				validatePackage: (pkg) => {
					if (pkg.name === packages[2].name) throw new Error("bad tarball");
				},
				publishPackage: () => publishCount++,
			}),
		/Package validation failed.*bad tarball/,
	);
	assert.equal(publishCount, 0);
});

test("normal publication cannot move latest to a prerelease", () => {
	const packages = getPublicWorkspacePackages(repoRoot).map((pkg) => ({
		...pkg,
		version: "0.85.0-bootstrap.0",
	}));
	assert.throws(
		() =>
			publishPackages({
				packages,
				queryPublished: () => false,
				validatePackage: () => {},
				publishPackage: () => {},
			}),
		/Refusing to publish prerelease version .* under the latest dist-tag/,
	);
});

test("release guard requires tag versions and source commits to match", () => {
	const packages = getPublicWorkspacePackages(repoRoot);
	const sha = "1b2228088e5dd889619fd850114d2827dcffc766";
	assert.equal(
		validateReleaseContext({
			headSha: sha,
			packages,
			sourceSha: sha,
			tag: `v${packages[0].version}`,
			tagSha: sha,
		}),
		packages[0].version,
	);
	assert.throws(
		() =>
			validateReleaseContext({
				headSha: sha,
				packages,
				sourceSha: sha,
				tag: "v9.9.9",
				tagSha: sha,
			}),
		/does not match every public package/,
	);
	assert.throws(
		() =>
			validateReleaseContext({
				headSha: sha,
				packages,
				sourceSha: "2222222222222222222222222222222222222222",
				tag: `v${packages[0].version}`,
				tagSha: sha,
			}),
		/Source ref resolves/,
	);
	assert.throws(
		() =>
			validateReleaseContext({
				headSha: sha,
				packages,
				sourceSha: sha,
				tag: `v${packages[0].version}-rc.1`,
				tagSha: sha,
			}),
		/Stable release tag must be vX\.Y\.Z/,
	);
});

test("bootstrap publication is fixed to a non-latest tag and explicit human auth", () => {
	assert.equal(BOOTSTRAP_DIST_TAG, "bootstrap");
	assert.deepEqual(getPublishArguments({ distTag: BOOTSTRAP_DIST_TAG, provenance: false }), [
		"publish",
		"--access",
		"public",
		"--tag",
		"bootstrap",
		"--ignore-scripts",
	]);
	assert.throws(
		() => validateBootstrapInvocation({ confirmed: true, env: {}, version: "0.85.0" }),
		/requires a prerelease version/,
	);
	assert.throws(
		() => validateBootstrapInvocation({ confirmed: false, env: {}, version: "0.85.0-bootstrap.0" }),
		/requires --confirm-human-auth/,
	);
	assert.throws(
		() =>
			validateBootstrapInvocation({
				confirmed: true,
				env: { NPM_TOKEN: "secret" },
				version: "0.85.0-bootstrap.0",
			}),
		/requires an interactive npm login/,
	);
	assert.doesNotThrow(() =>
		validateBootstrapInvocation({ confirmed: true, env: {}, version: "0.85.0-bootstrap.0" }),
	);
});

test("normal release registration accepts packages with only bootstrap versions", () => {
	let queryArgs;
	const registered = isPackageRegistered("@sammorrowdrums/mcpi-server", (_command, args) => {
		queryArgs = args;
		return { status: 0, stderr: "", stdout: '["0.85.0-bootstrap.0"]' };
	});
	assert.equal(registered, true);
	assert.deepEqual(queryArgs, [
		"view",
		"@sammorrowdrums/mcpi-server@bootstrap",
		"version",
		"--json",
	]);
});

test("normal release registration falls back to the latest dist-tag", () => {
	const queries = [];
	const registered = isPackageRegistered("@sammorrowdrums/mcpi-ai", (_command, args) => {
		queries.push(args[1]);
		if (args[1].endsWith("@bootstrap")) {
			return { status: 1, stderr: "npm error code ETARGET\nNo matching version found", stdout: "" };
		}
		return { status: 0, stderr: "", stdout: '"0.84.2"' };
	});
	assert.equal(registered, true);
	assert.deepEqual(queries, [
		"@sammorrowdrums/mcpi-ai@bootstrap",
		"@sammorrowdrums/mcpi-ai@latest",
	]);
});

test("release ref safety only accepts the reviewed origin main tip", () => {
	const sha = "1b2228088e5dd889619fd850114d2827dcffc766";
	assert.doesNotThrow(() =>
		validateReleaseRefState({
			branch: "main",
			headSha: sha,
			localMainSha: sha,
			remoteMainSha: sha,
			upstream: "origin/main",
		}),
	);
	assert.throws(
		() =>
			validateReleaseRefState({
				branch: "release",
				headSha: sha,
				localMainSha: sha,
				remoteMainSha: sha,
				upstream: "origin/main",
			}),
		/Releases must run from local branch main/,
	);
	assert.throws(
		() =>
			validateReleaseRefState({
				branch: "main",
				headSha: sha,
				localMainSha: sha,
				remoteMainSha: "3333333333333333333333333333333333333333",
				upstream: "origin/main",
			}),
		/does not match fetched origin\/main/,
	);
});

test("release script pushes HEAD and the tag atomically", () => {
	const releaseScript = readFileSync(join(repoRoot, "scripts/release.mjs"), "utf8");
	const testScript = readFileSync(join(repoRoot, "test.sh"), "utf8");
	assert.match(releaseScript, /assertReleaseRefSafety\(\)/);
	assert.match(releaseScript, /RELEASE_TAG: `v\$\{version\}`/);
	assert.match(testScript, /CI GITHUB_ACTIONS RELEASE_TAG/);
	assert.match(releaseScript, /git push --atomic origin HEAD:refs\/heads\/main refs\/tags\/v/);
	assert.doesNotMatch(releaseScript, /git push origin main/);
});
