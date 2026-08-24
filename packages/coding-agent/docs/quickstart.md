# Quickstart

This page gets you from install to a useful first mcpi session.

## Install

mcpi is distributed as an npm package:

```bash
npm install -g --ignore-scripts @sammorrowdrums/mcpi
```

`--ignore-scripts` disables dependency lifecycle scripts during install. mcpi does not require install scripts for normal npm installs.

### Uninstall

Use the package manager that installed mcpi. The curl installer uses npm globally, so curl and npm installs are removed with npm:

```bash
# curl installer or npm install -g
npm uninstall -g @sammorrowdrums/mcpi

# pnpm
pnpm remove -g @sammorrowdrums/mcpi

# Yarn
yarn global remove @sammorrowdrums/mcpi

# Bun
bun uninstall -g @sammorrowdrums/mcpi
```

Uninstalling mcpi leaves settings and credentials in `$XDG_CONFIG_HOME/mcpi` (fallback `~/.config/mcpi`; `%APPDATA%\mcpi` on Windows), sessions in `$XDG_STATE_HOME/mcpi` (fallback `~/.local/state/mcpi`; `%LOCALAPPDATA%\mcpi` on Windows), and disposable package/cache data in `$XDG_CACHE_HOME/mcpi` (fallback `~/.cache/mcpi`; `%LOCALAPPDATA%\mcpi` on Windows).

Then start mcpi in the project directory you want it to work on:

```bash
cd /path/to/project
mcpi
```

## Authenticate

mcpi can use subscription providers through `/login`, or API-key providers through environment variables or the auth file.

### Option 1: subscription login

Start mcpi and run:

```text
/login
```

Then select a provider. Built-in subscription logins include Claude Pro/Max, ChatGPT Plus/Pro (Codex), and GitHub Copilot.

### Option 2: API key

Set an API key before launching mcpi:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
mcpi
```

You can also run `/login` and select an API-key provider to store the key in `$XDG_CONFIG_HOME/mcpi/auth.json` (fallback `~/.config/mcpi/auth.json`; `%APPDATA%\mcpi\auth.json` on Windows).

See [Providers](providers.md) for all supported providers, environment variables, and cloud-provider setup.

## First session

Once mcpi starts, type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

By default, mcpi gives the model four tools:

- `read` - read files
- `write` - create or overwrite files
- `edit` - patch files
- `bash` - run shell commands

Additional built-in read-only tools (`grep`, `find`, `ls`) are available through tool options. mcpi runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Give mcpi project instructions

mcpi loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

mcpi loads:

- `$XDG_CONFIG_HOME/mcpi/AGENTS.md` for global instructions (fallback `~/.config/mcpi/AGENTS.md`; `%APPDATA%\mcpi\AGENTS.md` on Windows)
- `AGENTS.md` or `CLAUDE.md` from parent directories and the current directory

If a directory contains `AGENTS.override.md`, mcpi loads it instead of `AGENTS.md` or `CLAUDE.md` from that directory.

Restart mcpi, or run `/reload`, after changing context files.

## Common things to try

### Reference files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
mcpi @README.md "Summarize this"
mcpi @src/app.ts @src/app.test.ts "Review these together"
```

Images or text can be pasted with Ctrl+V (Alt+V on Windows); images can also be dragged into supported terminals.

### Run shell commands

In interactive mode:

```text
!npm run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to the model context.

### Switch models

Use `/model` or Ctrl+L to choose a model. Use Shift+Tab to cycle thinking level. Use Ctrl+P / Shift+Ctrl+P to cycle through scoped models.

### Continue later

Sessions are saved automatically:

```bash
mcpi -c                  # Continue most recent session
mcpi -r                  # Browse previous sessions
mcpi --name "my task"    # Set session display name at startup
mcpi --session <path|id> # Open a specific session
```

Inside mcpi, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone` to manage sessions.

### Non-interactive mode

For one-shot prompts:

```bash
mcpi -p "Summarize this codebase"
cat README.md | mcpi -p "Summarize this text"
mcpi -p @screenshot.png "What's in this image?"
```

Use `--mode json` for JSON event output or `--mode rpc` for process integration.

## Next steps

- [Using mcpi](usage.md) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Providers](providers.md) - authentication and model setup.
- [Settings](settings.md) - global and project configuration.
- [Keybindings](keybindings.md) - shortcuts and customization.
- [mcpi Packages](packages.md) - install shared extensions, skills, prompts, and themes.

Platform notes: [Windows](windows.md), [Termux](termux.md), [tmux](tmux.md), [Terminal setup](terminal-setup.md), [Shell aliases](shell-aliases.md).
