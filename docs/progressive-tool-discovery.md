# Progressive Tool Discovery via `deferred`

This fork adds experimental support for **progressive tool discovery** — tools can be registered with `deferred: true` so they are available for execution but hidden from the model until discovered through conversation content (e.g. via a skill system like [mcpi-ext](https://github.com/SamMorrowDrums/mcpi-ext)).

## How it works

When an extension registers a tool with `deferred: true`:

1. **Excluded from system prompt** — no `promptSnippet` or `promptGuidelines` rendered
2. **Stays in the tools array** — sent to the provider for grammar/dispatch
3. **Provider maps `deferred` to native deferral** — the tool is hidden from the model's view

The model discovers deferred tools through conversation content. For example, a skill system returns tool names in a `tool_result`, and the model matches those names to the deferred schemas.

## Provider support

### Anthropic (Claude)

Maps `deferred: true` to [`defer_loading: true`](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching) on the tool definition. The tool is included in the output grammar (model can call it) but excluded from the prompt prefix (model doesn't see it). No additional API features required — the model calls deferred tools after seeing their names in conversation content.

**Verified behavior** (Claude Opus 4.7):
- Tool with `defer_loading: true` is genuinely hidden — model says "I don't have that tool"
- After skill content names the tool, model calls it successfully
- Prompt cache is preserved — tools array and system prompt stay constant

### OpenAI Responses API (GPT-5.4+)

Maps `deferred: true` to `defer_loading: true` on the function definition. OpenAI **requires** `tool_search` to be present alongside deferred tools — this fork auto-injects `{"type": "tool_search"}` when deferred tools are detected.

The model automatically performs a server-side `tool_search_call` → `tool_search_output` flow to discover and load deferred tools on demand.

**Note:** It would be preferable if OpenAI supported `defer_loading` without requiring `tool_search`, matching Anthropic's behavior. The current requirement adds an implicit search step that may not align with skill-based discovery patterns.

**Verified behavior** (GPT-5.4):
- `defer_loading: true` + `tool_search` — model discovers and calls deferred tools
- `defer_loading: true` without `tool_search` — API rejects with 400 error

### Other providers

Providers without `defer_loading` support receive deferred tools as normal tools in the array. The model sees their schemas (token cost, but cached since the array is static). Execution gating must be handled by the extension via the `tool_call` hook.

## Extension API

### Registering deferred tools

```typescript
pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "Does something useful",
  deferred: true, // Hidden from model until discovered
  parameters: Type.Object({ ... }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // ...
  },
});
```

### `resolveTool` callback

When the model calls a tool not in `Context.tools` (e.g. because it was filtered by a provider that doesn't support `defer_loading`), the agent loop falls through to `resolveTool`:

```typescript
// Automatically wired in AgentSession — looks up the tool registry
agent.resolveTool = (name) => toolRegistry.get(name);
```

This provides a fallback dispatch path for deferred tools that were excluded from the provider's tools array by custom logic.

## Cache preservation

The entire point of `deferred` is prompt cache preservation:

- **Tools array is static** — deferred tools are always present, never added/removed
- **System prompt is static** — deferred tools excluded from prompt snippets
- **Provider deferral** — Anthropic excludes from prefix, OpenAI loads at end of context
- **No `setActiveTools()` churn** — the extension doesn't change the active tool set

Cache hierarchy (`tools → system → messages`) is never invalidated by tool discovery.

## Experimental status

This feature is experimental. Ideally, all model providers would support a `defer_loading` annotation that:
- Keeps the tool in the output grammar (model can call it)
- Excludes it from the prompt prefix (model doesn't see it until enabled)
- Allows explicit enabling via conversation content (e.g. `tool_reference` blocks)
- Preserves prompt cache

Anthropic's implementation is closest to this ideal. OpenAI's requires `tool_search` as a coupling that may not suit all use cases.
