import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionInstall = "mcpi install npm:@sammorrowdrums/mcpi-ext";
const extensionQuickStart = "https://github.com/SamMorrowDrums/mcpi-ext#quick-start";

function read(path) {
	return readFileSync(join(repoRoot, path), "utf8");
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const packageManagedExtensionDocs = [
	"README.md",
	"packages/coding-agent/README.md",
	"packages/coding-agent/docs/extensions.md",
	"packages/coding-agent/docs/index.md",
	"packages/coding-agent/docs/packages.md",
	"packages/coding-agent/docs/quickstart.md",
	"packages/coding-agent/docs/usage.md",
];

test("core docs teach the package-managed mcpi-ext flow and defer MCP configuration", () => {
	for (const path of packageManagedExtensionDocs) {
		const document = read(path);
		assert.match(document, new RegExp(escapeRegExp(extensionInstall)), path);
		assert.match(document, /\bmcpi list\b/, path);
		assert.match(document, /\bmcpi config\b/, path);
		assert.match(document, new RegExp(escapeRegExp(extensionQuickStart)), path);
	}

	const combined = packageManagedExtensionDocs.map(read).join("\n");
	assert.doesNotMatch(combined, /mcpi install npm:@sammorrowdrums\/mcpi-ext@\S+/);
	assert.doesNotMatch(combined, /npm root -g.*mcpi-ext/);
	assert.doesNotMatch(combined, /--mcp-config/);
	assert.doesNotMatch(combined, /export\s+GITHUB_PERSONAL_ACCESS_TOKEN/);
	assert.doesNotMatch(combined, /\$\{GITHUB_PERSONAL_ACCESS_TOKEN\}/);
	assert.doesNotMatch(combined, /ghcr\.io\/github\/github-mcp-server:skill-discovery/);
	assert.doesNotMatch(combined, /io\.modelcontextprotocol\/skills/);
});

test("active user docs do not direct readers to retired upstream instructions", () => {
	const docsDirectory = join(repoRoot, "packages/coding-agent/docs");
	const paths = [
		"README.md",
		"packages/coding-agent/README.md",
		...readdirSync(docsDirectory, { recursive: true })
			.filter((path) => typeof path === "string" && path.endsWith(".md"))
			.map((path) => `packages/coding-agent/docs/${path}`),
	];
	const combined = paths.map(read).join("\n");

	for (const staleReference of [
		/https:\/\/pi\.dev(?:\/|\b)/,
		/https:\/\/rfc\.earendil\.com/,
		/https:\/\/github\.com\/earendil-works\/pi(?:[)/#]|\b)/,
		/https:\/\/github\.com\/earendil-works\/pi-chat(?:[)/#]|\b)/,
		/https:\/\/github\.com\/badlogic\/pi-skills(?:[)/#]|\b)/,
		/https:\/\/mariozechner\.at\/posts\/2025-11-02-what-if-you-dont-need-mcp/,
		/https:\/\/discord\.com\/channels\/1456806362351669492\/1457744485428629628/,
	]) {
		assert.doesNotMatch(combined, staleReference);
	}
});

test("published docs cover current paths, migration, login, and Claude Opus 5", () => {
	const environment = read("packages/coding-agent/docs/environment-variables.md");
	const settings = read("packages/coding-agent/docs/settings.md");
	const providerDocs = [
		read("packages/coding-agent/README.md"),
		read("packages/coding-agent/docs/providers.md"),
		read("packages/coding-agent/docs/quickstart.md"),
	].join("\n");

	assert.match(environment, /^## Migrating legacy `\.pi` data$/m);
	assert.match(environment, /\| `<project>\/\.pi\/` \| `<project>\/\.mcpi\/` \|/);
	assert.match(environment, /\| `PI_CODING_AGENT_DIR` \| `MCPI_CODING_AGENT_DIR` \|/);
	assert.match(environment, /\$XDG_CONFIG_HOME\/mcpi/);
	assert.match(environment, /\$XDG_STATE_HOME\/mcpi/);
	assert.match(environment, /\$XDG_CACHE_HOME\/mcpi/);

	assert.match(settings, /"packages": \["npm:mcpi-skills", "npm:@org\/my-extension"\]/);
	assert.doesNotMatch(settings, /"packages": \["mcpi-skills"/);

	assert.match(providerDocs, /\/login/);
	assert.match(providerDocs, /mcpi auth check --provider <provider>/);
	assert.match(providerDocs, /anthropic\/claude-opus-5/);
	assert.match(providerDocs, /github-copilot\/claude-opus-5/);
});

test("npm and standalone release assets carry the corrected README and docs", () => {
	const packageJson = JSON.parse(read("packages/coding-agent/package.json"));
	assert.ok(packageJson.files.includes("docs"));
	assert.match(packageJson.scripts["copy-binary-assets"], /cp README\.md dist\//);
	assert.match(packageJson.scripts["copy-binary-assets"], /cp -r docs dist\//);
});
