import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tempDirs: string[] = [];

interface CliDirs {
	agentDir: string;
	projectConfigDir: string;
	projectDir: string;
	sessionDir: string;
	tempRoot: string;
}

interface CliResult {
	code: number | null;
	dirs: CliDirs;
	stderr: string;
	stdout: string;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "mcpi-help-extension-diagnostics-")));
	tempDirs.push(dir);
	return dir;
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeBrokenExtension(path: string, missingDependency: string): void {
	writeFileSync(path, `import ${JSON.stringify(missingDependency)};\nexport default function () {}\n`, "utf8");
}

function writeExtensionPackage(packageDir: string, packageName: string, missingDependency: string): string {
	mkdirSync(packageDir, { recursive: true });
	const extensionPath = join(packageDir, "extension.js");
	writeJson(join(packageDir, "package.json"), {
		name: packageName,
		version: "1.0.0",
		type: "module",
		pi: { extensions: ["extension.js"] },
	});
	writeBrokenExtension(extensionPath, missingDependency);
	return extensionPath;
}

async function runCli(
	args: string[] | ((dirs: CliDirs) => string[]),
	setup?: (dirs: CliDirs) => void,
): Promise<CliResult> {
	const tempRoot = createTempDir();
	const dirs: CliDirs = {
		tempRoot,
		agentDir: join(tempRoot, "agent"),
		projectDir: join(tempRoot, "project"),
		projectConfigDir: join(tempRoot, "project", ".mcpi"),
		sessionDir: join(tempRoot, "sessions"),
	};
	mkdirSync(dirs.agentDir, { recursive: true });
	mkdirSync(dirs.projectConfigDir, { recursive: true });
	setup?.(dirs);
	const resolvedArgs = typeof args === "function" ? args(dirs) : args;

	return await new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [cliPath, ...resolvedArgs], {
			cwd: dirs.projectDir,
			env: {
				...process.env,
				HOME: tempRoot,
				NO_COLOR: "1",
				MCPI_OFFLINE: "1",
				MCPI_SKIP_VERSION_CHECK: "1",
				[ENV_AGENT_DIR]: dirs.agentDir,
				[ENV_SESSION_DIR]: dirs.sessionDir,
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolvePromise({ code, dirs, stderr, stdout });
		});
	});
}

describe("extension diagnostics in --help", () => {
	it("reports an explicit broken.mjs extension and exits nonzero while retaining help", async () => {
		const missingDependency = "mcpi-help-missing-explicit-runtime-dependency";
		const result = await runCli(
			(dirs) => ["--extension", join(dirs.projectDir, "broken.mjs"), "--help"],
			(dirs) => {
				writeBrokenExtension(join(dirs.projectDir, "broken.mjs"), missingDependency);
			},
		);
		const extensionPath = join(result.dirs.projectDir, "broken.mjs");

		expect(result.code).toBe(1);
		expect(result.stdout).toContain("Usage:");
		expect(result.stderr).toContain(`Failed to load extension "${extensionPath}"`);
		expect(result.stderr).toContain(missingDependency);
		expect(result.stderr).toContain("--no-extensions");
	});

	it("reports a broken user managed package extension and exits nonzero", async () => {
		const packageName = "mcpi-help-broken-managed-package";
		const missingDependency = "mcpi-help-missing-managed-runtime-dependency";
		const result = await runCli(["--help"], (dirs) => {
			writeJson(join(dirs.agentDir, "settings.json"), {
				packages: [`npm:${packageName}@1.0.0`],
			});
			writeExtensionPackage(join(dirs.agentDir, "npm", "node_modules", packageName), packageName, missingDependency);
		});
		const extensionPath = join(result.dirs.agentDir, "npm", "node_modules", packageName, "extension.js");

		expect(result.code).toBe(1);
		expect(result.stdout).toContain("Usage:");
		expect(result.stderr).toContain(`Failed to load extension "${extensionPath}"`);
		expect(result.stderr).toContain(missingDependency);
		expect(result.stderr).toContain("--no-extensions");
	});

	it("reports a broken trusted project-local package extension and exits nonzero", async () => {
		const packageName = "mcpi-help-broken-project-package";
		const missingDependency = "mcpi-help-missing-project-runtime-dependency";
		const result = await runCli(["--approve", "--help"], (dirs) => {
			writeJson(join(dirs.projectConfigDir, "settings.json"), {
				packages: [`./${packageName}`],
			});
			writeExtensionPackage(join(dirs.projectConfigDir, packageName), packageName, missingDependency);
		});
		const extensionPath = join(result.dirs.projectConfigDir, packageName, "extension.js");

		expect(result.code).toBe(1);
		expect(result.stdout).toContain("Usage:");
		expect(result.stderr).toContain(`Failed to load extension "${extensionPath}"`);
		expect(result.stderr).toContain(missingDependency);
		expect(result.stderr).toContain("--no-extensions");
	});

	it("shows flags from valid explicit extensions and exits successfully", async () => {
		const result = await runCli(
			(dirs) => ["--extension", join(dirs.projectDir, "valid.mjs"), "--help"],
			(dirs) => {
				writeFileSync(
					join(dirs.projectDir, "valid.mjs"),
					[
						"export default function (pi) {",
						'  pi.registerFlag("valid-help-flag", {',
						'    description: "Visible in help",',
						'    type: "boolean",',
						"  });",
						"}",
						"",
					].join("\n"),
					"utf8",
				);
			},
		);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Usage:");
		expect(result.stdout).toContain("--valid-help-flag");
		expect(result.stderr).not.toContain("Failed to load extension");
	});

	it("keeps normal help successful", async () => {
		const result = await runCli(["--help"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Usage:");
		expect(result.stderr).not.toContain("Error:");
	});

	it("uses --no-extensions to recover from a broken managed package", async () => {
		const packageName = "mcpi-help-disabled-managed-package";
		const missingDependency = "mcpi-help-disabled-missing-runtime-dependency";
		const result = await runCli(["--no-extensions", "--help"], (dirs) => {
			writeJson(join(dirs.agentDir, "settings.json"), {
				packages: [`npm:${packageName}@1.0.0`],
			});
			writeExtensionPackage(join(dirs.agentDir, "npm", "node_modules", packageName), packageName, missingDependency);
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Usage:");
		expect(result.stderr).not.toContain(missingDependency);
		expect(result.stderr).not.toContain("Failed to load extension");
	});

	it("prints nonfatal startup warnings without failing help", async () => {
		const result = await runCli(["--help"], (dirs) => {
			writeFileSync(join(dirs.agentDir, "settings.json"), "{ invalid json", "utf8");
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Usage:");
		expect(result.stderr).toContain("Warning:");
		expect(result.stderr).toContain("global settings");
	});
});
