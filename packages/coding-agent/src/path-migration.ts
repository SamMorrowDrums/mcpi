import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	APP_NAME,
	CONFIG_DIR_NAME,
	ENV_AGENT_DIR,
	getAgentDir,
	getCacheDir,
	getSessionsDir,
	getStateDir,
} from "./config.ts";

export interface LegacyPathCheckOptions {
	cwd: string;
	homeDir?: string;
	configDir?: string;
	stateDir?: string;
	cacheDir?: string;
	sessionDir?: string;
	env?: NodeJS.ProcessEnv;
	pathExists?: (path: string) => boolean;
}

export function getLegacyPathMigrationError(options: LegacyPathCheckOptions): Error | undefined {
	const cwd = resolve(options.cwd);
	const homeDir = options.homeDir ?? homedir();
	const env = options.env ?? process.env;
	const pathExists = options.pathExists ?? existsSync;
	const configDir = options.configDir ?? getAgentDir();
	const stateDir = options.stateDir ?? getStateDir();
	const cacheDir = options.cacheDir ?? getCacheDir();
	const sessionDir = options.sessionDir ?? getSessionsDir();
	const legacyProjectDir = join(cwd, ".pi");
	const projectDir = join(cwd, CONFIG_DIR_NAME);
	const legacyUserDir = join(homeDir, ".pi", "agent");
	const issues: string[] = [];

	if (pathExists(legacyProjectDir) && !pathExists(projectDir)) {
		issues.push(`Project resources: move "${legacyProjectDir}" to "${projectDir}".`);
	}

	if (!env[ENV_AGENT_DIR]?.trim() && pathExists(legacyUserDir)) {
		const actions: string[] = [];
		if (!pathExists(configDir)) {
			actions.push(`Move settings, credentials, and user resources to "${configDir}".`);
		}
		if (!pathExists(stateDir)) {
			actions.push(`Move logs and session JSONL files to "${stateDir}" (sessions belong in "${sessionDir}").`);
		} else if (!pathExists(sessionDir)) {
			actions.push(`Move session JSONL files to "${sessionDir}".`);
		}
		if (!pathExists(cacheDir)) {
			actions.push(`Recreate disposable package, binary, and catalog caches under "${cacheDir}".`);
		}
		if (actions.length > 0) {
			issues.push([`User data: mcpi does not read "${legacyUserDir}".`, ...actions].join("\n"));
		}
	}

	if (issues.length === 0) return undefined;

	return new Error(
		[
			`${APP_NAME} no longer reads legacy pi config paths.`,
			...issues,
			`No files were moved automatically. Complete the migration or set ${ENV_AGENT_DIR} to an already-migrated directory, then rerun ${APP_NAME}.`,
		].join("\n"),
	);
}

export function assertNoLegacyPaths(cwd: string): void {
	const error = getLegacyPathMigrationError({ cwd });
	if (error) throw error;
}
