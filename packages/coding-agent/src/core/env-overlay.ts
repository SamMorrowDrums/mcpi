/**
 * Session-scoped environment overlays for spawned subprocesses.
 *
 * Extensions call `pi.setEnv()` / `pi.unsetEnv()` to build an overlay that is
 * applied to every subprocess the session spawns, without ever mutating
 * `process.env` (which would leak into unrelated sessions sharing the process).
 */

/**
 * A set of environment mutations to apply on top of a base environment.
 *
 * A string value sets the variable; `null` removes it, which allows masking a
 * variable inherited from the parent process.
 */
export type EnvOverlay = Iterable<readonly [string, string | null]>;

/**
 * Apply an overlay to a base environment, returning a new object.
 *
 * The base is never mutated.
 */
export function applyEnvOverlay(base: NodeJS.ProcessEnv, overlay: EnvOverlay): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	for (const [key, value] of overlay) {
		if (value === null) {
			delete env[key];
		} else {
			env[key] = value;
		}
	}
	return env;
}
