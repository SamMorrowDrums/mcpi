<p align="center">
  <a href="https://www.npmjs.com/package/@sammorrowdrums/mcpi"><img alt="npm" src="https://img.shields.io/npm/v/@sammorrowdrums/mcpi?style=flat-square" /></a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

# mcpi

An agent harness and self-extensible coding agent.

mcpi is a fork of [earendil-works/pi](https://github.com/earendil-works/pi), tracking
upstream's version numbering. Upstream's website is [pi.dev](https://pi.dev) and its
documentation at [pi.dev/docs/latest](https://pi.dev/docs/latest) still describes most
behaviour accurately; where this fork differs, the documentation in this repository wins.

## Configuration and data

mcpi separates global data by purpose:

| Data | Linux and macOS | Windows |
|------|-----------------|---------|
| Config (settings, auth, models, trust, user resources) | `$XDG_CONFIG_HOME/mcpi`, fallback `~/.config/mcpi` | `%APPDATA%\mcpi` |
| State (sessions and logs) | `$XDG_STATE_HOME/mcpi`, fallback `~/.local/state/mcpi` | `%LOCALAPPDATA%\mcpi` |
| Cache (packages, binaries, catalogs) | `$XDG_CACHE_HOME/mcpi`, fallback `~/.cache/mcpi` | `%LOCALAPPDATA%\mcpi` |

Project resources live in `.mcpi/`. `MCPI_CODING_AGENT_DIR` explicitly replaces all three global roots with one directory.

The public command, paths, and environment variables use the `mcpi`/`MCPI_*` identity. The extension API parameter and identifier `pi`, `pi.setEnv()`/`pi.unsetEnv()`, the extension package manifest `pi` field, internal upstream API/protocol symbols, Radius, `@mariozechner/clipboard`, and upstream attribution/licensing deliberately retain their established names.

* **[@sammorrowdrums/mcpi](packages/coding-agent)**: Interactive coding agent CLI
* **[@sammorrowdrums/mcpi-agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@sammorrowdrums/mcpi-ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

## All Packages

| Package | Description |
|---------|-------------|
| **[@sammorrowdrums/mcpi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@sammorrowdrums/mcpi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@sammorrowdrums/mcpi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@sammorrowdrums/mcpi](packages/coding-agent)** | Interactive coding agent CLI |
| **[@sammorrowdrums/mcpi-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

mcpi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox mcpi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `mcpi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `mcpi` process in a local container for simple isolation.
- **OpenShell**: run the whole `mcpi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for upstream pi can be found in its [RFCs](https://rfc.earendil.com/keyword/pi/).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./mcpi-test.sh       # Run mcpi from sources (can be run from any directory)
```

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "mcpi-${VERSION}-source.tar.gz"
cd "mcpi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The source archive includes the generated provider model data used for the release. `--offline-model-data` builds with that snapshot instead of refreshing it from live provider catalogs. The script still installs dependencies, builds the monorepo, compiles the Bun executable, and stages its runtime assets. Package maintainers who provide dependencies separately can pass `--skip-install --skip-deps`.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `MCPI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `mcpi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## License

MIT
