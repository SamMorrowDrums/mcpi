# Releasing mcpi

All public packages use lockstep versions. The next stable release should be **0.85.0**, not 0.84.3, because the public package identity, executable name, configuration paths, and environment-variable names include breaking changes.

## Public package DAG

The release tooling validates and processes exactly these packages, serially, in this order:

| Order | Package | Public package dependencies |
|---:|---|---|
| 1 | `@sammorrowdrums/mcpi-telemetry` | None |
| 2 | `@sammorrowdrums/mcpi-protocol` | None |
| 3 | `@sammorrowdrums/mcpi-tui` | None |
| 4 | `@sammorrowdrums/mcpi-ai` | telemetry |
| 5 | `@sammorrowdrums/mcpi-client` | protocol |
| 6 | `@sammorrowdrums/mcpi-agent-core` | telemetry, ai |
| 7 | `@sammorrowdrums/mcpi-server` | protocol, ai |
| 8 | `@sammorrowdrums/mcpi-session-backend-sqlite-node` | ai, agent-core |
| 9 | `@sammorrowdrums/mcpi` | protocol, tui, ai, client, agent-core |

The repository root, `@sammorrowdrums/mcpi-evals`, the generated installer lock package, and extension examples are private and are never selected.

Inspect the release manifest without building or contacting npm. The manifest records the authoritative root `LICENSE` SHA-256 and the package-local license path for every public package, and fails if any copy drifts:

```bash
npm run release:manifest
```

From a clean, already-built tree, validate every tarball without running package lifecycle scripts. Dry-run validation requires exactly one `LICENSE` entry with the authoritative byte length:

```bash
npm run release:pack -- --dry-run
```

Pack all nine tarballs to an empty directory outside the repository. Actual packing extracts each `package/LICENSE` entry and compares it byte-for-byte with the authoritative license:

```bash
npm run release:pack -- --out /tmp/mcpi-packages
```

If the root license changes, regenerate and verify all nine tracked copies before packing:

```bash
npm run sync:licenses
npm run check:licenses
```

## First registration bootstrap

npm trusted publishing can only be configured after a package exists. Bootstrap registration is deliberately separate from the normal GitHub Actions release. It is local-only, requires an interactive npm login plus an explicit confirmation flag, rejects `NPM_TOKEN` and `NODE_AUTH_TOKEN`, and always publishes under the `bootstrap` dist-tag. It cannot move `latest`.

Use a disposable clean worktree to prepare a prerelease version such as `0.85.0-bootstrap.0`. Do not use the stable `0.85.0` version for bootstrap because npm versions are immutable and the OIDC release must publish that stable version later.

```bash
npm version 0.85.0-bootstrap.0 --workspaces --no-git-tag-version --no-workspaces-update
node scripts/sync-versions.js
npm install --package-lock-only --ignore-scripts
npm ci --ignore-scripts
npm run generate:models
npm run build:offline
npm run shrinkwrap:coding-agent
npm run install-lock:coding-agent
npm run publish:bootstrap -- --dry-run
npm login
npm run publish:bootstrap -- --confirm-human-auth
```

The bootstrap command validates every tarball before the first publish and skips exact versions already present, so the same command recovers a partial bootstrap publication.

After registration, configure a GitHub Actions trusted publisher for each of the nine packages in npm:

| Setting | Value |
|---|---|
| Organization or user | `sammorrowdrums` |
| Repository | `mcpi` |
| Workflow filename | `build-binaries.yml` |
| Environment | `npm-publish` |

Do not add an npm token to GitHub. The publish job uses GitHub OIDC with `id-token: write`.

## Normal release

Before releasing, update every public package's `[Unreleased]` changelog section and run the local release smoke test documented in `AGENTS.md`. The release script refuses to run unless the worktree is clean, the current branch is local `main`, its upstream is `origin/main`, and its HEAD equals the freshly fetched remote tip.

For the recommended first stable release:

```bash
MCPI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor
```

The script validates, versions, tests, commits, and tags locally, then atomically pushes `HEAD` to `refs/heads/main` with the release tag. The tag starts `build-binaries.yml`.

`build-binaries.yml` is the sole npm publisher. Its `publish-npm` job is the only job using the `npm-publish` environment, so one approval authorizes all nine serial package publishes. The job checks that every public package version matches the release tag and that both the requested source ref and checked-out HEAD resolve to the tagged commit. It uses a pinned npm 11 CLI and OIDC provenance; it does not read `NPM_TOKEN`.

Normal release tags must be stable `vX.Y.Z` tags. Prerelease registration uses the local `bootstrap` workflow above and never publishes under `latest`.

## Partial-publish recovery

npm package versions are immutable. If publication stops after only some packages:

1. Fix the workflow or transient registry problem without changing the tagged commit.
2. Rerun `build-binaries.yml` for the same tag. For a manual recovery run, set `tag` to the existing release tag and leave `source_ref` empty, or provide a ref that resolves to exactly the same tagged commit.
3. Approve the single `npm-publish` job again.

The publisher validates all nine tarballs, skips exact versions already on npm, and resumes the missing packages in DAG order. A source ref that differs from the reviewed tag commit fails before publication. Do not create a replacement tag or rerun the local release script for the same version.
