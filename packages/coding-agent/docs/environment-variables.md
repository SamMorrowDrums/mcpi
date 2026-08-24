# Environment Variables

mcpi uses environment variables in three ways:

- Variables such as `MCPI_OFFLINE` configure the mcpi process.
- mcpi sets process markers so child processes can identify mcpi as the launching agent.
- Commands run by the LLM-callable bash tool receive `MCPI_*` variables describing the current session.

Provider API-key variables are documented separately in [Providers](providers.md#environment-variables-or-auth-file).

## Default Directories

mcpi separates configuration, persistent state, and disposable cache data:

| Data | Linux and macOS | Windows |
|------|-----------------|---------|
| Config: settings, auth, models, trust, and user resources | `$XDG_CONFIG_HOME/mcpi`, fallback `~/.config/mcpi` | `%APPDATA%\mcpi` |
| State: sessions and logs | `$XDG_STATE_HOME/mcpi`, fallback `~/.local/state/mcpi` | `%LOCALAPPDATA%\mcpi` |
| Cache: packages, binaries, and model catalogs | `$XDG_CACHE_HOME/mcpi`, fallback `~/.cache/mcpi` | `%LOCALAPPDATA%\mcpi` |

Sessions are stored under the state directory's `sessions/` subdirectory. `MCPI_CODING_AGENT_DIR` is an explicit single-root override: when set, mcpi uses that one directory for config, state, and cache data.

## Breaking Migration from Upstream pi

mcpi does not read old `PI_*` variables or legacy pi paths, and it does not copy or move old data automatically. Migrate durable files explicitly before starting mcpi. If mcpi finds legacy data while the corresponding mcpi destination is absent, startup stops with the exact source and destination paths.

| Legacy path | mcpi destination |
|-------------|------------------|
| `<project>/.pi/` | `<project>/.mcpi/` |
| `~/.pi/agent/` settings, auth, models, trust data, extensions, skills, prompts, and themes | Config directory from the table above |
| `~/.pi/agent/sessions/` | `<state directory>/sessions/` |
| `~/.pi/agent/` debug and TUI logs | State directory |
| `~/.pi/agent/npm/`, `bin/`, temporary packages, and model catalog cache | Recreate under the cache directory |

Rename every product-owned variable. The old names are not aliases:

| Legacy | Replacement |
|--------|-------------|
| `PI_CODING_AGENT_DIR` | `MCPI_CODING_AGENT_DIR` |
| `PI_CODING_AGENT_SESSION_DIR` | `MCPI_CODING_AGENT_SESSION_DIR` |
| `PI_PACKAGE_DIR` | `MCPI_PACKAGE_DIR` |
| `PI_OFFLINE` | `MCPI_OFFLINE` |
| `PI_SKIP_VERSION_CHECK` | `MCPI_SKIP_VERSION_CHECK` |
| `PI_TELEMETRY` | `MCPI_TELEMETRY` |
| `PI_CACHE_RETENTION` | `MCPI_CACHE_RETENTION` |
| `PI_CATALOG_URL` | `MCPI_CATALOG_URL` |
| `PI_SHARE_VIEWER_URL` | `MCPI_SHARE_VIEWER_URL` |
| `PI_OAUTH_CALLBACK_HOST` | `MCPI_OAUTH_CALLBACK_HOST` |
| `PI_EXPERIMENTAL` | `MCPI_EXPERIMENTAL` |
| `PI_HARDWARE_CURSOR` | `MCPI_HARDWARE_CURSOR` |
| `PI_TUI_ESC_TIMEOUT` | `MCPI_TUI_ESC_TIMEOUT` |
| `PI_CLEAR_ON_SHRINK` | `MCPI_CLEAR_ON_SHRINK` |
| `PI_TUI_WRITE_LOG` | `MCPI_TUI_WRITE_LOG` |
| `PI_CODING_AGENT` | `MCPI_CODING_AGENT` |
| `PI_SESSION_ID` | `MCPI_SESSION_ID` |
| `PI_SESSION_FILE` | `MCPI_SESSION_FILE` |
| `PI_PROVIDER` | `MCPI_PROVIDER` |
| `PI_MODEL` | `MCPI_MODEL` |
| `PI_REASONING_LEVEL` | `MCPI_REASONING_LEVEL` |
| `PI_NO_LOCAL_LLM` | `MCPI_NO_LOCAL_LLM` |
| `PI_STARTUP_BENCHMARK` | `MCPI_STARTUP_BENCHMARK` |
| `PI_TIMING` | `MCPI_TIMING` |
| `PI_DEBUG_REDRAW` | `MCPI_DEBUG_REDRAW` |
| `PI_TUI_DEBUG` | `MCPI_TUI_DEBUG` |
| `PI_EVAL_ARTIFACT_DIR` | `MCPI_EVAL_ARTIFACT_DIR` |
| `PI_TUI_WIN32_TOOLCHAIN` | `MCPI_TUI_WIN32_TOOLCHAIN` |
| `PI_ALLOW_LOCKFILE_CHANGE` | `MCPI_ALLOW_LOCKFILE_CHANGE` |
| `PI_AUTH_JSON` | `MCPI_AUTH_JSON` |
| `PI_AUTH_UPDATE_TOKEN` | `MCPI_AUTH_UPDATE_TOKEN` |
| `PI_GIST_TOKEN` | `MCPI_GIST_TOKEN` |
| `AI_AGENT=pi` | `AI_AGENT=mcpi` |

The extension callback identifier remains `pi`, including `pi.setEnv()`, `pi.unsetEnv()`, and `pi.exec()`. Those methods accept arbitrary user-chosen environment keys and do not rewrite them. The extension package manifest field also remains `pi`; these are API compatibility names, not product environment aliases.

## Process Markers

The CLI and RPC entry points set two process markers:

- `AI_AGENT=mcpi` is a generic marker that lets tooling identify mcpi as the agent that launched the process.
- `MCPI_CODING_AGENT=true` is mcpi-specific and lets child processes detect that they run inside mcpi.

Child processes inherit both markers. They are not session-specific and are not set automatically when mcpi is embedded through the SDK.

## Bash Tool Session Environment

Commands run by the bash tool receive the current mcpi session state:

| Variable | Description |
|----------|-------------|
| `MCPI_SESSION_ID` | Current session ID |
| `MCPI_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
| `MCPI_PROVIDER` | Currently selected model provider |
| `MCPI_MODEL` | Currently selected model ID |
| `MCPI_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

The values are resolved when each command starts. Switching models or changing the reasoning level therefore affects the next bash command without restarting mcpi. `MCPI_PROVIDER` and `MCPI_MODEL` identify the selected mcpi model, not a different upstream model that a router may choose internally.

When asked which model or provider is running, inspect these variables instead of inferring the answer from the system prompt:

```bash
printf '%s/%s\n' "$MCPI_PROVIDER" "$MCPI_MODEL"
printf 'reasoning=%s session=%s\n' "$MCPI_REASONING_LEVEL" "$MCPI_SESSION_ID"
```

The session file can be inspected directly when the session is persistent:

```bash
if [ -n "$MCPI_SESSION_FILE" ]; then
  tail -n 1 "$MCPI_SESSION_FILE"
fi
```

These variables are injected into the LLM-callable bash tool. They are not injected into user-entered `!` or `!!` commands.

### Extension-Set Session Variables

Extensions can add variables to every subprocess mcpi spawns for the session with
[`pi.setEnv()`](extensions.md#session-environment). Those values apply to both the bash tool and
`pi.exec()`, and are never written to mcpi's own `process.env`. The extension API identifier `pi` is retained deliberately.

### Custom Bash Tools

Bash tools created with `createBashTool()` expose the session environment by default when registered with mcpi. Injection happens before `spawnHook`, so a hook receives the variables in `ctx.env`:

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

Disable session metadata independently of the spawn hook:

```typescript
const bashTool = createBashTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

When disabled, mcpi removes inherited values for these variables so nested mcpi processes do not expose stale parent-session metadata.

## mcpi Process Configuration

These variables are read by mcpi itself:

| Variable | Description |
|----------|-------------|
| `MCPI_CODING_AGENT_DIR` | Explicit single-root override for config, state, and cache |
| `MCPI_CODING_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir` |
| `MCPI_PACKAGE_DIR` | Override the package directory, useful for Nix/Guix store paths |
| `MCPI_OFFLINE` | Disable startup network operations, including update checks and package updates |
| `MCPI_SKIP_VERSION_CHECK` | Disable the GitHub releases latest-version request |
| `MCPI_TELEMETRY` | Override provider attribution headers: `1`/`true`/`yes` or `0`/`false`/`no` |
| `MCPI_CACHE_RETENTION` | Set to `long` for extended provider prompt caching where supported |
| `MCPI_CATALOG_URL` | Opt in to a remote model catalog overlay; unset uses the release's bundled catalog |
| `MCPI_SHARE_VIEWER_URL` | Base URL of the transcript viewer used by `/share` |
| `MCPI_OAUTH_CALLBACK_HOST` | Override the OAuth callback listener host; defaults to `127.0.0.1` |
| `MCPI_EXPERIMENTAL` | Set to `1` to enable experimental features |
| `MCPI_HARDWARE_CURSOR` | Set to `1` to show the hardware cursor; see [Terminal setup](terminal-setup.md) |
| `MCPI_TUI_ESC_TIMEOUT` | Milliseconds to wait after a lone ESC; defaults to `100` over SSH and `10` otherwise |
| `MCPI_CLEAR_ON_SHRINK` | Set to `1` to clear unused terminal rows when rendered content shrinks |
| `MCPI_TUI_WRITE_LOG` | File or directory for the raw ANSI stream written by the TUI |
| `VISUAL`, `EDITOR` | External editor fallback when `externalEditor` is unset |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests |

## Development and diagnostics

These variables are intended for repository tests, profiling, or low-level TUI diagnostics rather than normal mcpi configuration:

| Variable | Purpose |
|----------|---------|
| `MCPI_NO_LOCAL_LLM` | Skip tests that require a local LLM |
| `MCPI_STARTUP_BENCHMARK` | Enable the interactive startup benchmark used by `scripts/profile-coding-agent-node.mjs` |
| `MCPI_TIMING` | Set to `1` to print startup timing instrumentation |
| `MCPI_DEBUG_REDRAW` | Set to `1` to record full-redraw reasons in the state log directory |
| `MCPI_TUI_DEBUG` | Set to `1` to write verbose per-render TUI debug dumps |
| `MCPI_EVAL_ARTIFACT_DIR` | Override the private eval harness artifact directory |
| `MCPI_TUI_WIN32_TOOLCHAIN` | Select `msvc` or `mingw` for the native Windows TUI build |
| `MCPI_ALLOW_LOCKFILE_CHANGE` | Allow the repository commit guard to accept a staged root lockfile |

The repository's issue-analysis workflow uses `MCPI_AUTH_JSON`, `MCPI_AUTH_UPDATE_TOKEN`, and `MCPI_GIST_TOKEN` as GitHub Actions secrets. They are workflow credentials, not normal local mcpi configuration.

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and cloud-provider configuration are listed in [Providers](providers.md#environment-variables-or-auth-file).
