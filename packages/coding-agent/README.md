<p align="center">
  <a href="https://www.npmjs.com/package/@sammorrowdrums/mcpi"><img alt="npm" src="https://img.shields.io/npm/v/@sammorrowdrums/mcpi?style=flat-square" /></a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](../../CONTRIBUTING.md).

---

mcpi is a minimal terminal coding harness, forked from [earendil-works/pi](https://github.com/earendil-works/pi). Adapt it to your workflows, not the other way around, without having to fork and modify its internals. Extend it with TypeScript [Extensions](#extensions), [Skills](#skills), [Prompt Templates](#prompt-templates), and [Themes](#themes). Put your extensions, skills, prompt templates, and themes in [mcpi packages](#mcpi-packages) and share them with others via npm or git.

mcpi ships with powerful defaults but skips features like sub agents and plan mode. Instead, you can ask it to build what you want or install a third-party mcpi package that matches your workflow.

mcpi runs in four modes: interactive, print or JSON, RPC for process integration, and an SDK for embedding in your own apps.

## Table of Contents

- [Quick Start](#quick-start)
- [Providers & Models](#providers--models)
- [Interactive Mode](#interactive-mode)
  - [Editor](#editor)
  - [Commands](#commands)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Message Queue](#message-queue)
- [Sessions](#sessions)
  - [Branching](#branching)
  - [Compaction](#compaction)
- [Settings](#settings)
- [Context Files](#context-files)
- [Customization](#customization)
  - [Prompt Templates](#prompt-templates)
  - [Skills](#skills)
  - [Extensions](#extensions)
  - [Themes](#themes)
  - [mcpi Packages](#mcpi-packages)
- [Programmatic Usage](#programmatic-usage)
- [Philosophy](#philosophy)
- [CLI Reference](#cli-reference)

---

## Quick Start

```bash
npm install -g --ignore-scripts @sammorrowdrums/mcpi
```

`--ignore-scripts` disables dependency lifecycle scripts during install. mcpi does not require install scripts for normal npm installs.

Standalone binaries are published on the
[mcpi releases page](https://github.com/SamMorrowDrums/mcpi/releases).

Authenticate with an API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
mcpi
```

Or use your existing subscription:

```bash
mcpi
/login  # Then select provider
```

Then just talk to mcpi. By default, mcpi gives the model four tools: `read`, `write`, `edit`, and `bash`. The model uses these to fulfill your requests. Add capabilities via [skills](#skills), [prompt templates](#prompt-templates), [extensions](#extensions), or [mcpi packages](#mcpi-packages).

**Platform notes:** [Windows](docs/windows.md) | [Termux (Android)](docs/termux.md) | [tmux](docs/tmux.md) | [Terminal setup](docs/terminal-setup.md) | [Shell aliases](docs/shell-aliases.md)

---

## Providers & Models

For each built-in provider, mcpi maintains a list of tool-capable models. Configured provider catalogs refresh automatically; run `mcpi update --models` to force an immediate refresh. Authenticate via subscription (`/login`) or API key, then select any model from that provider via `/model` (or Ctrl+L).

**Subscriptions:**
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro (Codex)
- GitHub Copilot

**API keys:**
- Anthropic
- Ant Ling
- OpenAI
- Azure OpenAI
- DeepSeek
- NVIDIA NIM
- Google Gemini
- Google Vertex
- Amazon Bedrock
- Mistral
- Groq
- Cerebras
- Cloudflare AI Gateway
- Cloudflare Workers AI
- xAI
- OpenRouter
- Vercel AI Gateway
- ZAI Coding Plan (Global)
- ZAI Coding Plan (China)
- OpenCode Zen
- OpenCode Go
- Hugging Face
- Fireworks
- Together AI
- Baseten
- Kimi For Coding
- MiniMax
- Xiaomi MiMo
- Xiaomi MiMo Token Plan (China)
- Xiaomi MiMo Token Plan (Amsterdam)
- Xiaomi MiMo Token Plan (Singapore)

mcpi also supports the llama.cpp router server. Configure it with `/login llama.cpp`, manage downloads and loaded models with `/llama`, then select a loaded model with `/model`. See [docs/llama-cpp.md](docs/llama-cpp.md) for setup and usage.

See [docs/providers.md](docs/providers.md) for other provider setup instructions.

**Custom providers & models:** Add providers via `$XDG_CONFIG_HOME/mcpi/models.json` (default `~/.config/mcpi/models.json`) if they speak a supported API (OpenAI, Anthropic, Google). For custom APIs or OAuth, use extensions. See [docs/models.md](docs/models.md) and [docs/custom-provider.md](docs/custom-provider.md).

---

## Interactive Mode

<p align="center"><img src="docs/images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface from top to bottom:

- **Startup header** - Shows shortcuts (`/hotkeys` for all), loaded AGENTS.md files, prompt templates, skills, and extensions
- **Messages** - Your messages, assistant responses, tool calls and results, notifications, errors, and extension UI
- **Editor** - Where you type; border color indicates thinking level
- **Footer** - Working directory, session name, total token/cache usage (`↑` input, `↓` output, `R` cache read, `W` cache write, `CH` latest cache hit rate), cost, context usage, current model. Totals include assistant responses, usage reported by tools, and summary generation.

The editor can be temporarily replaced by other UI, like built-in `/settings` or custom UI from extensions (e.g., a Q&A tool that lets the user answer model questions in a structured format). [Extensions](#extensions) can also replace the editor, add widgets above/below it, a status line, custom footer, or overlays.

### Editor

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Tab to complete paths |
| Multi-line | Shift+Enter (or Ctrl+Enter on Windows Terminal) |
| External editor | Ctrl+G opens `externalEditor`, `$VISUAL`, `$EDITOR`, Notepad on Windows, or `nano` elsewhere |
| Clipboard | Ctrl+V to paste an image or text (Alt+V on Windows), or drag images onto terminal |
| Bash commands | `!command` runs and sends output to LLM, `!!command` runs without sending |

Standard editing keybindings for delete word, undo, etc. See [docs/keybindings.md](docs/keybindings.md).

### Commands

Type `/` in the editor to trigger commands. [Extensions](#extensions) can register custom commands, [skills](#skills) are available as `/skill:name`, and [prompt templates](#prompt-templates) expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | Manage provider credentials |
| [`/llama`](docs/llama-cpp.md) | Download, load, and unload llama.cpp router models |
| `/model` | Switch models |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/resume` | Pick from previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set session display name |
| `/session` | Show session info (file, ID, messages, tokens, cost) |
| `/tree` | Jump to any point in the session and continue from there |
| `/trust` | Save project trust decision for future sessions (restart required) |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Manually compact context, optional custom instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML or JSONL file |
| `/import <file>` | Import and resume a session from a JSONL file |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/reload` | Reload keybindings, extensions, skills, prompts, themes, and context files |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/quit` | Quit mcpi |

### Keyboard Shortcuts

See `/hotkeys` for the full list. Customize via `$XDG_CONFIG_HOME/mcpi/keybindings.json` (default `~/.config/mcpi/keybindings.json`). See [docs/keybindings.md](docs/keybindings.md).

**Commonly used:**

| Key | Action |
|-----|--------|
| Ctrl+C | Clear editor |
| Ctrl+C twice | Quit |
| Escape | Cancel/abort |
| Escape twice | Open `/tree` |
| Ctrl+L | Open model selector |
| Ctrl+P / Shift+Ctrl+P | Cycle scoped models forward/backward |
| Shift+Tab | Cycle thinking level |
| Ctrl+O | Collapse/expand tool output |
| Ctrl+T | Collapse/expand thinking blocks |
| Ctrl+X | Copy the last assistant message |

### Message Queue

Submit messages while the agent is working:

- **Enter** queues a *steering* message, delivered after the current assistant turn finishes executing its tool calls
- **Alt+Enter** queues a *follow-up* message, delivered only after the agent finishes all work
- **Escape** aborts and restores queued messages to editor
- **Alt+Up** retrieves queued messages back to editor

On Windows Terminal, `Alt+Enter` is fullscreen by default. Remap it in [docs/terminal-setup.md](docs/terminal-setup.md) so mcpi can receive the follow-up shortcut.

Configure delivery in [settings](docs/settings.md): `steeringMode` and `followUpMode` can be `"one-at-a-time"` (default, waits for response) or `"all"` (delivers all queued at once). `transport` selects provider transport preference (`"sse"`, `"websocket"`, or `"auto"`) for providers that support multiple transports.

---

## Sessions

Sessions are stored as JSONL files with a tree structure. Each entry has an `id` and `parentId`, enabling in-place branching without creating new files. See [docs/session-format.md](docs/session-format.md) for file format.

### Management

Sessions auto-save to `$XDG_STATE_HOME/mcpi/sessions/` (default `~/.local/state/mcpi/sessions/`) organized by working directory.

```bash
mcpi -c                  # Continue most recent session
mcpi -r                  # Browse and select from past sessions
mcpi --no-session        # Ephemeral mode (don't save)
mcpi --name "my task"    # Set session display name at startup
mcpi --session <path|id> # Use specific session file or ID
mcpi --fork <path|id>    # Fork specific session file or ID into a new session
```

Use `/session` in interactive mode to see the current session ID before reusing it with `--session <id>` or `--fork <id>`.

### Branching

**`/tree`** - Navigate the session tree in-place. Select any previous point, continue from there, and switch between branches. All history preserved in a single file.

<p align="center"><img src="docs/images/tree-view.png" alt="Tree View" width="600"></p>

- Search by typing, fold/unfold and jump between branches with Ctrl+←/Ctrl+→ or Alt+←/Alt+→, page with ←/→
- Filter modes (Ctrl+O): default → no-tools → user-only → labeled-only → all
- Press Ctrl+X to copy the selected message
- Press Shift+L to label entries as bookmarks and Shift+T to toggle label timestamps

**`/fork`** - Create a new session file from a previous user message on the active branch. Opens a selector, copies the active path up to that point, and places the selected prompt in the editor for modification.

**`/clone`** - Duplicate the current active branch into a new session file at the current position. The new session keeps the full active-path history and opens with an empty editor.

**`--fork <path|id>`** - Fork an existing session file or partial session UUID directly from the CLI. This copies the full source session into a new session file in the current project.

### Compaction

Long sessions can exhaust context windows. Compaction summarizes older messages while keeping recent ones.

**Manual:** `/compact` or `/compact <custom instructions>`

**Automatic:** Enabled by default. Triggers on context overflow (recovers and retries) or when approaching the limit (proactive). Configure via `/settings` or `settings.json`.

Compaction is lossy. The full history remains in the JSONL file; use `/tree` to revisit. Customize compaction behavior via [extensions](#extensions). See [docs/compaction.md](docs/compaction.md) for internals.

---

## Settings

Use `/settings` to modify common options, or edit JSON files directly:

| Location | Scope |
|----------|-------|
| `$XDG_CONFIG_HOME/mcpi/settings.json` (default `~/.config/mcpi/settings.json`) | Global (all projects) |
| `.mcpi/settings.json` | Project (overrides global) |

See [docs/settings.md](docs/settings.md) for all options.

### Project Trust

On interactive startup, mcpi asks before trusting a project folder that contains project-local settings, resources, or project `.agents/skills` and has no saved decision for the folder or a parent folder in `$XDG_CONFIG_HOME/mcpi/trust.json`. Trusting a project allows mcpi to load `.mcpi/settings.json` and `.mcpi` resources, install missing project packages, and execute project extensions.

Before the trust decision, mcpi loads only context files, user/global extensions, and CLI `-e` extensions so they can handle the `project_trust` event. Project-local extensions, project package-managed extensions, and project settings are loaded only after the project is trusted. This split also applies when switching to a session from a different cwd whose trust has not been resolved in the current process.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

If no extension or saved decision applies, `defaultProjectTrust` controls the fallback behavior. Set it to `"ask"`, `"always"`, or `"never"` in `$XDG_CONFIG_HOME/mcpi/settings.json`, or change it with `/settings`.

`mcpi config` and package commands use the same project trust flow, except `mcpi update` never prompts. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them.

Use `/trust` in interactive mode to save a project trust decision for future sessions, including trust for the immediate parent folder. It writes `$XDG_CONFIG_HOME/mcpi/trust.json` only; the current session is not reloaded, so restart mcpi for changes to take effect.

### Telemetry and update checks

- **Update check:** fetches the [mcpi releases feed](https://api.github.com/repos/SamMorrowDrums/mcpi/releases/latest) to check whether a newer version exists. Disable it with `MCPI_SKIP_VERSION_CHECK=1`.
- **Install/update telemetry:** mcpi sends none. The `enableInstallTelemetry` setting now only controls optional provider attribution headers for OpenRouter, Cloudflare, and direct NVIDIA NIM requests. Opt out by setting `enableInstallTelemetry` to `false` in `settings.json`, or by setting `MCPI_TELEMETRY=0`. This does not disable update checks.

Use `--offline` or `MCPI_OFFLINE=1` to disable all startup network operations described here, including update checks and package update checks.

---

## Context Files

mcpi loads `AGENTS.md` (or `CLAUDE.md`) at startup from:
- `$XDG_CONFIG_HOME/mcpi/AGENTS.md` (global)
- Parent directories (walking up from cwd)
- Current directory

If a directory contains `AGENTS.override.md`, mcpi loads it instead of `AGENTS.md` or `CLAUDE.md` from that directory. Context files from other directories are still concatenated.

Use for project instructions (`AGENTS.md`/`CLAUDE.md`), conventions, common commands. All matching files are concatenated.

Disable context file loading with `--no-context-files` (or `-nc`).

### System Prompt

Replace the default system prompt with `.mcpi/SYSTEM.md` (project) or `$XDG_CONFIG_HOME/mcpi/SYSTEM.md` (global). Append without replacing via `APPEND_SYSTEM.md`.

---

## Customization

### Prompt Templates

Reusable prompts as Markdown files. Type `/name` to expand.

```markdown
<!-- ~/.config/mcpi/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

Place in `$XDG_CONFIG_HOME/mcpi/prompts/`, `.mcpi/prompts/`, or an [mcpi package](#mcpi-packages) to share with others. See [docs/prompt-templates.md](docs/prompt-templates.md).

### Skills

On-demand capability packages following the [Agent Skills standard](https://agentskills.io). Invoke via `/skill:name` or let the agent load them automatically.

```markdown
<!-- ~/.config/mcpi/skills/my-skill/SKILL.md -->
# My Skill
Use this skill when the user asks about X.

## Steps
1. Do this
2. Then that
```

Place in `$XDG_CONFIG_HOME/mcpi/skills/`, `~/.agents/skills/`, `.mcpi/skills/`, or `.agents/skills/` (from `cwd` up through parent directories) or an [mcpi package](#mcpi-packages) to share with others. See [docs/skills.md](docs/skills.md).

### Extensions

<p align="center"><img src="docs/images/doom-extension.png" alt="Doom Extension" width="600"></p>

TypeScript modules that extend mcpi with custom tools, commands, keyboard shortcuts, event handlers, and UI components.

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "deploy", ... });
  pi.registerCommand("stats", { ... });
  pi.on("tool_call", async (event, ctx) => { ... });
}
```

The default export can also be `async`. mcpi waits for async extension factories before startup continues, which is useful for one-time initialization such as fetching remote model lists before calling `pi.registerProvider()`. The extension callback name and `pi.*` methods are retained as the stable extension API.

**What's possible:**
- Custom tools (or replace built-in tools entirely)
- Sub-agents and plan mode
- Custom compaction and summarization
- Permission gates and path protection
- Custom editors and UI components
- Status lines, headers, footers
- Git checkpointing and auto-commit
- SSH and sandbox execution
- MCP server integration
- Make mcpi look like Claude Code
- Games while waiting (yes, Doom runs)
- ...anything you can dream up

Place in `$XDG_CONFIG_HOME/mcpi/extensions/`, `.mcpi/extensions/`, or an [mcpi package](#mcpi-packages) to share with others. See [docs/extensions.md](docs/extensions.md) and [examples/extensions/](examples/extensions/).

### Themes

Built-in: `dark`, `light`. Themes hot-reload: modify the active theme file and mcpi immediately applies changes.

Place in `$XDG_CONFIG_HOME/mcpi/themes/`, `.mcpi/themes/`, or an [mcpi package](#mcpi-packages) to share with others. See [docs/themes.md](docs/themes.md).

### mcpi Packages

Bundle and share extensions, skills, prompts, and themes via npm or git. Find packages on [npmjs.com](https://www.npmjs.com/search?q=keywords%3Amcpi-package) or [Discord](https://discord.com/channels/1456806362351669492/1457744485428629628).

> **Security:** mcpi packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
mcpi install npm:@foo/mcpi-tools
mcpi install npm:@foo/mcpi-tools@1.2.3      # pinned version
mcpi install git:github.com/user/repo
mcpi install git:github.com/user/repo@v1  # tag or commit
mcpi install git:git@github.com:user/repo
mcpi install git:git@github.com:user/repo@v1  # tag or commit
mcpi install https://github.com/user/repo
mcpi install https://github.com/user/repo@v1      # tag or commit
mcpi install ssh://git@github.com/user/repo
mcpi install ssh://git@github.com/user/repo@v1    # tag or commit
mcpi remove npm:@foo/mcpi-tools
mcpi uninstall npm:@foo/mcpi-tools          # alias for remove
mcpi list
mcpi update                                 # update mcpi only
mcpi update --all                           # update mcpi and packages
mcpi update --extensions                    # update packages only
mcpi update --models                        # refresh model catalogs only
mcpi update --self                          # update mcpi only
mcpi update --self --force                  # reinstall mcpi even if current
mcpi update npm:@foo/mcpi-tools             # update one package
mcpi config                                 # enable/disable extensions, skills, prompts, themes
```

Packages install to `$XDG_CACHE_HOME/mcpi/git/` (git) or `$XDG_CACHE_HOME/mcpi/npm/` (npm), defaulting to `~/.cache/mcpi/`. Use `-l` for project-local installs (`.mcpi/git/`, `.mcpi/npm/`). Git `@ref` values are pinned tags or commits; pinned packages are skipped by `mcpi update --extensions` and `mcpi update --all`, so use `mcpi install git:host/user/repo@new-ref` to move an existing package to a new ref. Git packages install dependencies with `npm install --omit=dev` by default, so runtime deps must be listed under `dependencies`; when `npmCommand` is configured, git packages use plain `install` for compatibility with wrappers. If you use a Node version manager and want package installs to reuse a stable npm context, set `npmCommand` in `settings.json`, for example `["mise", "exec", "node@20", "--", "npm"]`.

Create a package by adding a `pi` key to `package.json`. This field name is retained as a stable extension-package compatibility API:

```json
{
  "name": "my-mcpi-package",
  "keywords": ["mcpi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Without a `pi` manifest, mcpi auto-discovers from conventional directories (`extensions/`, `skills/`, `prompts/`, `themes/`).

See [docs/packages.md](docs/packages.md).

---

## Programmatic Usage

### SDK

```typescript
import { createAgentSession, ModelRuntime, SessionManager } from "@sammorrowdrums/mcpi";

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});

await session.prompt("What files are in the current directory?");
```

For advanced multi-session runtime replacement, use `createAgentSessionRuntime()` and `AgentSessionRuntime`.

See [docs/sdk.md](docs/sdk.md) and [examples/sdk/](examples/sdk/).

### RPC Mode

For non-Node.js integrations, use RPC mode over stdin/stdout:

```bash
mcpi --mode rpc
```

RPC mode uses strict LF-delimited JSONL framing. Clients must split records on `\n` only. Do not use generic line readers like Node `readline`, which also split on Unicode separators inside JSON payloads.

See [docs/rpc.md](docs/rpc.md) for the protocol.

---

## Philosophy

mcpi is aggressively extensible so it doesn't have to dictate your workflow. Features that other tools bake in can be built with [extensions](#extensions), [skills](#skills), or installed from third-party [mcpi packages](#mcpi-packages). This keeps the core minimal while letting you shape mcpi to fit how you work.

**No MCP.** Build CLI tools with READMEs (see [Skills](#skills)), or build an extension that adds MCP support. [Why?](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)

**No sub-agents.** There are many ways to do this. Spawn mcpi instances via tmux, build your own with [extensions](#extensions), or install a package that does it your way.

**No permission popups.** Run in a container, or build your own confirmation flow with [extensions](#extensions) inline with your environment and security requirements.

**No plan mode.** Write plans to files, or build it with [extensions](#extensions), or install a package.

**No built-in to-dos.** They confuse models. Use a TODO.md file, or build your own with [extensions](#extensions).

**No background bash.** Use tmux. Full observability, direct interaction.

Read the [upstream pi blog post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) for the original rationale.

---

## CLI Reference

```bash
mcpi [options] [@files...] [messages...]
```

### Package Commands

```bash
mcpi install <source> [-l]     # Install package, -l for project-local
mcpi remove <source> [-l]      # Remove package
mcpi uninstall <source> [-l]   # Alias for remove
mcpi update [source|self]      # Update mcpi only, or one package source
mcpi update --all              # Update mcpi and packages
mcpi update --extensions       # Update packages only
mcpi update --models           # Refresh model catalogs only
mcpi update --self             # Update mcpi only
mcpi update --self --force     # Reinstall mcpi even if current
mcpi update --extension <src>  # Update one package
mcpi list                      # List installed packages
mcpi config                    # Enable/disable package resources
```

`mcpi config` and project package commands accept `--approve`/`--no-approve` to trust or ignore project-local settings for one command. `mcpi update` never prompts for project trust.

### Modes

| Flag | Description |
|------|-------------|
| (default) | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines (see [docs/json.md](docs/json.md)) |
| `--mode rpc` | RPC mode for process integration (see [docs/rpc.md](docs/rpc.md)) |
| `--export <in> [out]` | Export session to HTML |

In print mode, mcpi also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | mcpi -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider (anthropic, openai, google, etc.) |
| `--model <pattern>` | Model pattern or ID (supports `provider/id` and optional `:<thinking>`) |
| `--api-key <key>` | API key (overrides env vars) |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue most recent session |
| `-r`, `--resume` | Browse and select session |
| `--session <path\|id>` | Use specific session file or partial UUID |
| `--fork <path\|id>` | Fork specific session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode (don't save) |
| `--name <name>`, `-n <name>` | Set session display name at startup |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific tool names across built-in, extension, and custom tools |
| `--exclude-tools <list>`, `-xt <list>` | Disable specific tool names across built-in, extension, and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools by default but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable all tools by default |

Available built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load extension from path, npm, or git (repeatable) |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load skill (repeatable) |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load prompt template (repeatable) |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load theme (repeatable) |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable AGENTS.md and CLAUDE.md context file discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings.json (e.g., `--no-extensions -e ./my-ext.ts`).

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt (context files and skills still appended) |
| `--append-system-prompt <text>` | Append to system prompt |
| `--tui-mode <mode>` | TUI mode: `regular` (default) or experimental `fullscreen` |
| `--use-theme <name[/name]>` | Set the initial interactive theme for this run without changing settings |
| `--verbose` | Force verbose startup |
| `-a`, `--approve` | Trust project-local files for this run |
| `-na`, `--no-approve` | Ignore project-local files for this run |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include in the message:

```bash
mcpi @prompt.md "Answer this"
mcpi -p @screenshot.png "What's in this image?"
mcpi @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
mcpi "List all .ts files in src/"

# Non-interactive
mcpi -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | mcpi -p "Summarize this text"

# Named one-shot session
mcpi --name "release audit" -p "Audit this repository"

# Different model
mcpi --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix (no --provider needed)
mcpi --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
mcpi --model sonnet:high "Solve this complex problem"

# Limit model cycling
mcpi --models "claude-*,gpt-4o"

# Read-only mode
mcpi --tools read,grep,find,ls -p "Review the code"

# Disable one extension or built-in tool while keeping the rest available
mcpi --exclude-tools ask_question

# High thinking level
mcpi --thinking high "Solve this complex problem"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `AI_AGENT` | Set to `mcpi` by the CLI and RPC entry points so generic tooling can attribute child processes to mcpi |
| `MCPI_CODING_AGENT` | Set to `true` by the CLI and RPC entry points so child processes can detect that they run inside mcpi |
| `MCPI_CODING_AGENT_DIR` | Override config, state, and cache roots with one directory |
| `MCPI_CODING_AGENT_SESSION_DIR` | Override session storage directory (overridden by `--session-dir`) |
| `MCPI_PACKAGE_DIR` | Override package directory (useful for Nix/Guix where store paths tokenize poorly) |
| `MCPI_OFFLINE` | Disable startup network operations, including update checks and package update checks |
| `MCPI_SKIP_VERSION_CHECK` | Skip the version update check at startup. This prevents the GitHub releases latest-version request |
| `MCPI_TELEMETRY` | Override provider attribution headers. Use `1`/`true`/`yes` to enable or `0`/`false`/`no` to disable. This does not disable update checks |
| `MCPI_CATALOG_URL` | Opt in to a remote model catalog overlay; unset means the release's bundled catalog is used |
| `MCPI_SHARE_VIEWER_URL` | Base URL of the transcript viewer used by `/share`; unset means `/share` reports no viewer link |
| `MCPI_CACHE_RETENTION` | Set to `long` for extended prompt cache (Anthropic: 1h, OpenAI: 24h) |
| `VISUAL`, `EDITOR` | Fallback external editor for Ctrl+G when `externalEditor` is unset; defaults to Notepad on Windows and `nano` elsewhere |

Commands run by the LLM-callable bash tool also receive current session metadata:

| Variable | Description |
|----------|-------------|
| `MCPI_SESSION_ID` | Current session ID |
| `MCPI_SESSION_FILE` | Absolute session JSONL path; unset for ephemeral sessions |
| `MCPI_PROVIDER` | Currently selected model provider |
| `MCPI_MODEL` | Currently selected model ID |
| `MCPI_REASONING_LEVEL` | Current effective reasoning level |

These values are resolved when each command starts. See [Environment Variables](docs/environment-variables.md#bash-tool-session-environment) for semantics, examples, and custom-tool opt-out.

---

## Contributing & Development

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines and [docs/development.md](docs/development.md) for setup, forking, and debugging.

## License

MIT

## See Also

- [@sammorrowdrums/mcpi-ai](https://www.npmjs.com/package/@sammorrowdrums/mcpi-ai): Core LLM toolkit
- [@sammorrowdrums/mcpi-agent-core](https://www.npmjs.com/package/@sammorrowdrums/mcpi-agent-core): Agent framework
- [@sammorrowdrums/mcpi-tui](https://www.npmjs.com/package/@sammorrowdrums/mcpi-tui): Terminal UI components
