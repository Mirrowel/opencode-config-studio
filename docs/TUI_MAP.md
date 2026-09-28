# Config Studio + Agent Variants — TUI Map

> **GENERATED FILE — DO NOT EDIT.** Regenerate with `npm run tools:generate-tui-map`; `npm run test:tui-map` fails when this file drifts.

## Conventions

- Glyphs in row titles come from the compiled menus: `!` danger, `+` add, `*` current choice, `x` disabled, `●` status, `[i]` inspect/help.
- Keys: `/` type-to-filter (Config Studio menus), `i` item help, `f` pin (pinnable screens), `enter` select, `Esc` = Back one level.
- `→ \`Menu\`` opens that menu; `→ [view] \`Title\`` opens a read-only view; `→ (config layer picker)` is a staged-edit file chooser (not expanded).
- Row suffixes: `[prompt]` text input, `[confirm]` confirmation-gated, `[dialog]` renderer-backed dialog, `[pin]` section screen is pinnable.
- `(N)` = any count; `<agent>`, `<provider>`, `<model>`, `<variant>`, `<server-local>`, `<server-runtime>`, `<url>` replace fixture identifiers; no fixture values are quoted.
- `... (dynamic list: (N) more rows)` collapses auto-filled data rows; `... ((N) more rows)` marks a sampled long menu.
- State tags (`[integrated only]`, `[own-menu only]`, `[reload-pending only]`, `[no-reload-pending only]`, `[av-sidecar only]`) sit on section headers; rows carry only tags that differ from their section.
- Every menu ends with a Back/Cancel row; those rows are omitted.

## Part 0 — Where do I edit X?

| I want to change... | Menu path |
|---|---|
| Default / small model | `Config Studio` -> `Settings` -> `Models & agents` -> `Default model` |
| Default agent | `Config Studio` -> `Settings` -> `Models & agents` -> `Default agent` |
| Provider API key / base URL | `Config Studio` -> `Providers - edited first` -> `Provider <provider>` -> `API key env vars` |
| Provider entries (config) | `Config Studio` -> `Settings` -> `Providers` |
| Permissions (root) | `Config Studio` -> `Settings` -> `Tools & files` -> `Permissions` |
| MCP servers | `Config Studio` -> `Settings` -> `Tools & files` -> `MCP servers` |
| Theme / diff / cursor | `Config Studio` -> `TUI settings (tui.json)` -> `Theme` |
| Keybinds | `Config Studio` -> `TUI settings (tui.json)` |
| Agent hidden / disabled | `Config Studio` -> `Agents` -> `Agent <agent>` -> `Agent <agent> - Hidden` |
| AV task-list & calling / variants | `Config Studio` -> `Agents` -> `Agent <agent>` -> `<agent> - Agent Variants` |
| AV profiles / model presets | `Config Studio` -> `Agents` |
| AV task-id suggestions | `Config Studio` -> `Tools` |
| Subagent sessions | `Config Studio` -> `Tools` |
| Plugin management | `Config Studio` -> `Plugins` |
| Config reload / pending state | `Config Studio` -> `Advanced` |
| Model variants / default options | `Config Studio` -> `Providers - edited first` -> `Models (catalog) - <provider>` -> `<provider>/<model>` -> `Variants - <model>` |

## Part 1 — Config Studio (integrated layout, shared menus)

```
- `Config Studio`
  - `Providers - edited first`
    - `Models (catalog) - <provider>`
      - `<provider>/<model>`
        - `Variants - <model>`
          - `Variant <variant>`
            - `Capture request - <provider>/<model>`
              - `Compare default against which variant?`
        - `Default options - <model>`
          - `Copy which variant body?`
          - ↩ `Capture request - <provider>/<model>`
        - ↩ `Capture request - <provider>/<model>`
      - `Provider <provider>`
        - `SDK package`
        - `API key env vars`
        - `Model whitelist`
        - `Model blacklist`
        - `Connection options`
        - `Model entries (config) - <provider>`
      - ↩ `Model entries (config) - <provider>`
  - `Agents`
    - `Agent <agent>`
      - `Model - <agent>`
        - `Model for agent <agent>`
      - `Agent <agent> has no model set. Pick the model whose variants to list`
        - `Model variant - <agent> (on <provider>/<model>)`
      - `Agent <agent> permissions`
        - `Shorthand rule (every tool)`
      - `Agent <agent> - Mode`
      - `Agent <agent> - Hidden`
      - `Agent <agent> - Disabled`
      - `<agent> - Agent Variants` [integrated only]
    - `Agent <agent> (no Hidden, Disabled)` [integrated only] [no-reload-pending only] [av-sidecar only]
      - ↩ `Model - <agent>`
      - ↩ `Agent <agent> has no model set. Pick the model whose variants to list`
      - ↩ `Agent <agent> permissions`
      - ↩ `Agent <agent> - Mode`
      - ↩ `<agent> - Agent Variants`
  - `Disabled providers`
  - `Config reload pending` [reload-pending only]
    - ↩ `Config Studio`
  - `Settings`
    - `Models & agents`
      - `Default model`
        - `Default model (Pick from catalog)`
      - `Small model`
        - `Small model (Pick from catalog)`
      - `Default agent`
      - ↩ `Agents`
    - `Sharing & updates`
      - `Session sharing`
      - `Auto-update`
      - `Enterprise URL`
    - `Providers`
      - `Providers (Provider entries)`
      - ↩ `Disabled providers`
      - `Enabled providers (allowlist)`
    - `Tools & files`
      - `Shell`
      - `Instruction files`
      - `Skills`
        - `Paths`
        - `URLs`
      - `References`
      - `MCP servers`
        - `MCP <server-local> (local)`
          - `MCP <server-local> - tools (N)`
          - `Command`
            - `<command>`
          - `Environment`
        - `MCP <server-runtime> (remote, runtime)`
          - `MCP <server-runtime> - tools (N)`
      - `Slash commands`
      - `Formatter`
      - `LSP servers`
      - `File watcher`
        - `Ignore globs`
      - `Permissions`
        - ↩ `Shorthand rule (every tool)`
        - `edit rule`
          - `edit patterns (last match wins)`
    - `Session behavior`
      - `Image attachments`
        - `Image`
          - `Auto resize`
      - `Tool output limits`
      - `Compaction`
        - `Auto compaction`
        - `Prune`
      - `Snapshots`
    - `Server`
      - `Server (Port)`
        - `mDNS advertise`
        - `CORS origins`
    - `Developer`
      - `Plugins`
        - `@mirrowel/opencode-agent-variants@dev`
      - `Experimental flags`
        - `Disable paste summary`
        - `OpenTelemetry`
        - `Primary-only tools`
        - `Continue loop on deny`
    - `Deprecated`
      - `Autoshare`
      - ↩ `References`
      - `Mode agents (legacy)`
      - `Tools toggles (legacy)`
  - `TUI settings (tui.json)`
    - `Theme`
    - `Diff style`
    - `Mouse`
    - `Scroll acceleration`
      - `Enabled`
    - `Cursor`
      - `Style`
      - `Blinking`
    - `Attention`
      - ↩ `Enabled`
      - `Notifications`
      - `Sound`
      - `Custom sounds`
    - `Prompt box`
    - `Plugin enable toggles`
  - ↩ `Plugins`
  - `Tools`
  - `Config files (5 layers, weakest first)`
    - `global:config.json`
      - ↩ `global:config.json`
    - `project:./opencode.json`
      - ↩ `project:./opencode.json`
    - `global:opencode.jsonc`
      - ↩ `global:opencode.jsonc`
    - `opencode-dir:.opencode/opencode.json`
      - ↩ `opencode-dir:.opencode/opencode.json`
    - `opencode-dir:.opencode/opencode.jsonc`
      - ↩ `opencode-dir:.opencode/opencode.jsonc`
  - `Modules`
    - `Subagent Explorer`
      - ↩ `Modules`
      - `Subagent Explorer source`
        - ↩ `Subagent Explorer source`
    - `Agent Variants`
      - ↩ `Modules`
      - `Agent Variants source`
        - ↩ `Agent Variants source`
        - `Channel for @mirrowel/opencode-agent-variants@dev`
  - `Advanced`
    - ↩ `Advanced`
```

#### `Config Studio`
Path: `Config Studio`
Also via: `Config reload pending` -> `Cancel auto-reload`
- `Providers & models` — Open the model browser. → `Providers - edited first`
- `Agents` — Agent definitions and per-agent overrides. → `Agents`
- `Disabled providers` — Jump straight to Disabled providers. → `Disabled providers`
- `● Config reload pending - N session(s) running` → `Config reload pending` [reload-pending only]
- `Settings` → `Settings`
- `TUI settings` → `TUI settings (tui.json)`
- `Plugins` → `Plugins`
- `Tools` → `Tools`
- `Cleanup & migrations` → [view] `Cleanup`
- `Config files` — How OpenCode merges config files, weakest to strongest. → `Config files (5 layers, weakest first)`
- `Diagnostics` → [view] `Diagnostics`
- `How it works` → [view] `Config Studio`
- `Modules` → `Modules`
- `Advanced` → `Advanced`
- `Save & exit` — No changes are staged. [confirm]
- `Agent Variants` → `Agent Variants (own-menu)` [own-menu only]

#### `Providers - edited first`
Path: `Config Studio` -> `Providers - edited first`
- `<provider>` → `Models (catalog) - <provider>`
- `! New custom provider...`

#### `Models (catalog) - <provider>`
Path: `Config Studio` -> `Providers - edited first` -> `Models (catalog) - <provider>`
- `<model>` → `<provider>/<model>`
- `! Provider settings...` → `Provider <provider>`
- `+ Model entries (config)...` → `Model entries (config) - <provider>`

#### `<provider>/<model>`
Path: `Config Studio` -> `Providers - edited first` -> `Models (catalog) - <provider>` -> `<provider>/<model>`
- `Variants` — Named request overlays for the model. → `Variants - <model>`
- `Default options` → `Default options - <model>`
- `Capture real request` → `Capture request - <provider>/<model>`
- `Agent usage` — Agents that reference this model. → [view] `Agent usage - <model>`
- `Model info [i]` → [view] `<provider>/<model>`

#### `Variants - <model>`
Path: `Config Studio` -> `Providers - edited first` -> `Models (catalog) - <provider>` -> `<provider>/<model>` -> `Variants - <model>`
- `<variant>` → `Variant <variant>`
- `+ Add variant` — Named request overlays for the model.

#### `Variant <variant>`
Path: `Config Studio` -> `Providers - edited first` -> `Models (catalog) - <provider>` -> `<provider>/<model>` -> `Variants - <model>` -> `Variant <variant>`
- `Edit body (JSON)`
- `Disable variant` — Named request overlays for the model. → (config layer picker)
- `Delete from config` [confirm]
- `Copy body to default options` [confirm]
- `Capture with this variant` → `Capture request - <provider>/<model>`
- `Variant info [i]` → [view] `Variant <variant>`

#### `Capture request - <provider>/<model>`
Path: `Config Studio` -> `Providers - edited first` -> `Models (catalog) - <provider>` -> `<provider>/<model>` -> `Variants - <model>` -> `Variant <variant>` -> `Capture request - <provider>/<model>`
Also via: `<provider>/<model>` -> `Capture real request`; `Default options - <model>` -> `Capture default request`
- `Capture default (no variant)` [dialog]
- `Capture variant <variant>` [dialog]
- `A/B: default vs variant` → `Compare default against which variant?`

#### `Compare default against which variant?`
Path: `Config Studio` -> `Providers - edited first` -> `Models (catalog) - <provider>` -> `<provider>/<model>` -> `Variants - <model>` -> `Variant <variant>` -> `Capture request - <provider>/<model>` -> `Compare default against which variant?`
- `<variant>` [dialog]

#### `Default options - <model>`
Path: `Config Studio` -> `Providers - edited first` -> `Models (catalog) - <provider>` -> `<provider>/<model>` -> `Default options - <model>`
- `Edit options (JSON)`
- `Copy from variant` → `Copy which variant body?`
- `Clear options` [confirm]
- `View what default sends` → [view] `Default sends - <model>`
- `Capture default request` → `Capture request - <provider>/<model>`

#### `Copy which variant body?`
Path: `Config Studio` -> `Providers - edited first` -> `Models (catalog) - <provider>` -> `<provider>/<model>` -> `Default options - <model>` -> `Copy which variant body?`
- `<variant>` → (config layer picker)

#### `Provider <provider>`
Path: `Config Studio` -> `Providers - edited first` -> `Models (catalog) - <provider>` -> `Provider <provider>`
- `Display name` — Human-readable provider name shown in pickers. [prompt]
- `API base URL` [prompt]
- `SDK package` — AI SDK integration package. → `SDK package`
- `Provider id` [prompt]
- `API key env vars` → `API key env vars`
- `Model whitelist` — Only expose these exact model ids (exact string match, no globs). → `Model whitelist`
- `Model blacklist` — Hide these exact model ids (applied after the whitelist). → `Model blacklist`
- `Connection options` — SDK connection options (apiKey, baseURL, timeouts, ...). → `Connection options`
- `Models` — Model entries: full custom models and overrides of catalog models. → `Model entries (config) - <provider>`
- `! Remove whole section` [confirm]

#### `SDK package`
Path: `Config Studio` -> `Providers - edited first` -> `Models (catalog) - <provider>` -> `Provider <provider>` -> `SDK package`
- `OpenAI-compatible` — DEFAULT FALLBACK. → (config layer picker)
- `OpenAI Responses` — OpenAI proper or endpoints speaking /v1/responses. → (config layer picker)
- `Vertex AI (ADC)` → (config layer picker)
- `Bedrock Mantle` — OpenAI Responses-style models hosted on Bedrock Mantle. → (config layer picker)
- `GitLab Duo` — GitLab Duo Agent Platform. → (config layer picker)
- `Groq` — Groq ultra-fast inference endpoints; OpenAI-schema compatible. → (config layer picker)
- `Together AI` — Together AI hosted open-weight models. → (config layer picker)
- `Alibaba DashScope` — Qwen etc.; anthropic-style cacheControl. → (config layer picker)
- `Custom...` — AI SDK integration package.

#### `Connection options`
Path: `Config Studio` -> `Providers - edited first` -> `Models (catalog) - <provider>` -> `Provider <provider>` -> `Connection options`
- `API key` — Static API key. [prompt]
- `Base URL` — API endpoint base URL (overrides the catalog URL and provider.api). [prompt]
- `Enterprise URL` — Enterprise gateway endpoint. [prompt]
- `Cache key` — Prompt-cache key override. [prompt]
- `Timeout (ms)` — Overall request timeout. [prompt]
- `Header timeout (ms)` [prompt]
- `Chunk timeout (ms)` [prompt]
- `+ Add key`

#### `Agents`
Path: `Config Studio` -> `Agents`
Also via: `Models & agents` -> `Agents`
- `<agent>` — Agent definitions and per-agent overrides. → `Agent <agent>`, `Agent <agent> (no Hidden, Disabled)`
- `AV profiles (N)` [dialog] [integrated only]
- `Model presets (N)` [dialog] [integrated only]
- `+ New agent...`

#### `Agent <agent>`
Path: `Config Studio` -> `Agents` -> `Agent <agent>`
- `! Primary-only agent` → [view] `Primary-only agent`
- `Model` → `Model - <agent>`
- `Model variant` → `Agent <agent> has no model set. Pick the model whose variants to list`
- `Temperature` [prompt]
- `Top P` [prompt]
- `Prompt` [prompt]
- `Permissions` → `Agent <agent> permissions`
- `Options` [prompt]
- `Mode` → `Agent <agent> - Mode`
- `Hidden` → `Agent <agent> - Hidden`
- `Disabled` → `Agent <agent> - Disabled`
- `Max steps` [prompt]
- `Description` [prompt]
- `Color` [prompt]
- `Task-list & calling: normal` [dialog] [integrated only]
- `Agent Variants (N)` → `<agent> - Agent Variants` [integrated only]
- `AV parent patches` [dialog] [integrated only]

#### `Model - <agent>`
Path: `Config Studio` -> `Agents` -> `Agent <agent>` -> `Model - <agent>`
Also via: `Agent <agent> (no Hidden, Disabled)` -> `Model`
- `Pick model` → `Model for agent <agent>`
- `Remove model override` → (config layer picker)

#### `Model for agent <agent>`
Path: `Config Studio` -> `Agents` -> `Agent <agent>` -> `Model - <agent>` -> `Model for agent <agent>`
- `<model>` → (config layer picker)

#### `Agent <agent> has no model set. Pick the model whose variants to list`
Path: `Config Studio` -> `Agents` -> `Agent <agent>` -> `Agent <agent> has no model set. Pick the model whose variants to list`
Also via: `Agent <agent> (no Hidden, Disabled)` -> `Model variant`
- `<model>` → `Model variant - <agent> (on <provider>/<model>)`

#### `Model variant - <agent> (on <provider>/<model>)`
Path: `Config Studio` -> `Agents` -> `Agent <agent>` -> `Agent <agent> has no model set. Pick the model whose variants to list` -> `Model variant - <agent> (on <provider>/<model>)`
- `Default (no variant)` → (config layer picker)
- `<variant>` → (config layer picker)

#### `Agent <agent> permissions`
Path: `Config Studio` -> `Agents` -> `Agent <agent>` -> `Agent <agent> permissions`
Also via: `Agent <agent> (no Hidden, Disabled)` -> `Permissions`
- `Shorthand (all tools)` → `Shorthand rule (every tool)`
- `i How matching works` → [view] `Permission matching`
- ... (dynamic list: (N) more rows)

#### `Shorthand rule (every tool)`
Path: `Config Studio` -> `Agents` -> `Agent <agent>` -> `Agent <agent> permissions` -> `Shorthand rule (every tool)`
Also via: `Permissions` -> `Shorthand (all tools)`
- `(remove shorthand)`
- `ask` [confirm]
- `allow` [confirm]
- `deny` [confirm]

#### `<agent> - Agent Variants` [integrated only]
Path: `Config Studio` -> `Agents` -> `Agent <agent>` -> `<agent> - Agent Variants`
Also via: `Agent <agent> (no Hidden, Disabled)` -> `Agent Variants (N)`
- `Profile context: Global default`
- `Task-list & calling: normal`
- `Add variant` — Creates a new variant of this agent.
- `<variant>` [no-reload-pending only] [av-sidecar only]

#### `Agent <agent> (no Hidden, Disabled)` [integrated only] [no-reload-pending only] [av-sidecar only]
Path: `Config Studio` -> `Agents` -> `Agent <agent> (no Hidden, Disabled)`
- `! Primary-only agent` → [view] `Primary-only agent`
- `Model` → `Model - <agent>`
- `Model variant` → `Agent <agent> has no model set. Pick the model whose variants to list`
- `Temperature` [prompt]
- `Top P` [prompt]
- `Prompt` [prompt]
- `Permissions` → `Agent <agent> permissions`
- `Options` [prompt]
- `Mode` → `Agent <agent> - Mode`
- `Max steps` [prompt]
- `Description` [prompt]
- `Color` [prompt]
- `Task-list & calling: normal` [dialog]
- `Agent Variants (N)` → `<agent> - Agent Variants`
- `AV parent patches` [dialog]

#### `Disabled providers` [pin]
Path: `Config Studio` -> `Disabled providers`
Also via: `Providers` -> `Disabled providers`
- `+ <provider>` → (config layer picker)
- `+ Add entry`
- ... (dynamic list: (N) more rows)

#### `Config reload pending` [reload-pending only]
Path: `Config Studio` -> `Config reload pending`
- `─ could not verify running sessions ──────────────────────`
- `Reload NOW - interrupts N running session(s)` [confirm]
- `Cancel auto-reload` → `Config Studio`

#### `Settings`
Path: `Config Studio` -> `Settings`
- `Models & agents` — Settings group "Models & agents". → `Models & agents`
- `Sharing & updates` — Settings group "Sharing & updates". → `Sharing & updates`
- `Providers` — Settings group "Providers". → `Providers`
- `Tools & files` — Settings group "Tools & files". → `Tools & files`
- `Session behavior` — Settings group "Session behavior". → `Session behavior`
- `Server` — Settings group "Server". → `Server`
- `Developer` — Settings group "Developer". → `Developer`
- `Deprecated` — Settings group "Deprecated". → `Deprecated`

#### `Models & agents` [pin]
Path: `Config Studio` -> `Settings` -> `Models & agents`
- `Default model` — Root default model as provider/model. → `Default model`
- `Small model` — Cheap model for background work: titles, summaries, compaction. → `Small model`
- `Default agent` — Agent used for new sessions. → `Default agent`
- `Subagent depth` [prompt]
- `Agents` → `Agents`

#### `Default model`
Path: `Config Studio` -> `Settings` -> `Models & agents` -> `Default model`
- `Pick from catalog` → `Default model (Pick from catalog)`
- `Enter manually`
- `Remove` → (config layer picker)

#### `Default model (Pick from catalog)`
Path: `Config Studio` -> `Settings` -> `Models & agents` -> `Default model` -> `Default model (Pick from catalog)`
- `<model>` → (config layer picker)

#### `Small model`
Path: `Config Studio` -> `Settings` -> `Models & agents` -> `Small model`
- `Pick from catalog` → `Small model (Pick from catalog)`
- `Enter manually`
- `Remove` → (config layer picker)

#### `Small model (Pick from catalog)`
Path: `Config Studio` -> `Settings` -> `Models & agents` -> `Small model` -> `Small model (Pick from catalog)`
- `<model>` → (config layer picker)

#### `Default agent`
Path: `Config Studio` -> `Settings` -> `Models & agents` -> `Default agent`
- `<agent>` → (config layer picker)
- `(not set - remove)` → (config layer picker)

#### `Sharing & updates` [pin]
Path: `Config Studio` -> `Settings` -> `Sharing & updates`
- `Session sharing` — manual: share on demand. → `Session sharing`
- `Auto-update` — true: silently install patch updates. → `Auto-update`
- `Username` — Display name for sharing and the server's basic auth. [prompt]
- `Enterprise URL` — Enterprise share-service endpoint (default https://opncd.ai). → `Enterprise URL`

#### `Enterprise URL`
Path: `Config Studio` -> `Settings` -> `Sharing & updates` -> `Enterprise URL`
- `URL` — Enterprise share service base URL. [prompt]

#### `Providers` [pin]
Path: `Config Studio` -> `Settings` -> `Providers`
- `Provider entries` → `Providers (Provider entries)`
- `Disabled providers` — Provider ids to hide from the model picker and provider list. → `Disabled providers`
- `Enabled providers (allowlist)` → `Enabled providers (allowlist)`

#### `Providers (Provider entries)` [pin]
Path: `Config Studio` -> `Settings` -> `Providers` -> `Providers (Provider entries)`
- `<provider>` → (config layer picker)
- `+ Add provider`
- ... (dynamic list: (N) more rows)

#### `Enabled providers (allowlist)` [pin]
Path: `Config Studio` -> `Settings` -> `Providers` -> `Enabled providers (allowlist)`
- `+ <provider>` → (config layer picker)
- `+ Add entry`
- ... (dynamic list: (N) more rows)

#### `Tools & files` [pin]
Path: `Config Studio` -> `Settings` -> `Tools & files`
- `Shell` — Default shell for the terminal, !`cmd` templates, and the bash tool. → `Shell`
- `Instruction files` — Extra instruction globs/paths/URLs merged into every system prompt. → `Instruction files`
- `Skills` — Extra skill folders and URLs beyond the built-in discovery. → `Skills`
- `References` → `References`
- `MCP servers` — Model Context Protocol servers (local stdio commands or remote HTTP). → `MCP servers`
- `Slash commands` → `Slash commands`
- `Formatter` → `Formatter`
- `LSP servers` → `LSP servers`
- `File watcher` — Edit-snapshot watcher configuration. → `File watcher`
- `Permissions` — Per-tool permission rules (ask/allow/deny with wildcard patterns). → `Permissions`

#### `Shell`
Path: `Config Studio` -> `Settings` -> `Tools & files` -> `Shell`
- `pwsh` — PowerShell 7+ (Windows default first choice). → (config layer picker)
- ... (dynamic list: (N) more rows)

#### `Skills` [pin]
Path: `Config Studio` -> `Settings` -> `Tools & files` -> `Skills`
- `Paths` — Local folders containing skills. → `Paths`
- `URLs` — Remote skill registries. → `URLs`

#### `MCP servers` [pin]
Path: `Config Studio` -> `Settings` -> `Tools & files` -> `MCP servers`
- `<server-local>` — MCP server "<server-local>" Local stdio server: command + args array. → `MCP <server-local> (local)`
- `<server-runtime>` — MCP server "<server-runtime>" Remote HTTP server. → `MCP <server-runtime> (remote, runtime)`
- `Re-fetch tool lists`
- `+ Add local server`
- `+ Add remote server`

#### `MCP <server-local> (local)`
Path: `Config Studio` -> `Settings` -> `Tools & files` -> `MCP servers` -> `MCP <server-local> (local)`
- `Disable server` → (config layer picker)
- `Status: (unavailable)` → [view] `MCP <server-local> - status`
- `Tools (-)` → `MCP <server-local> - tools (N)`
- `Command` — Executable plus arguments, one array element per token (e.g. → `Command`
- `Working directory` — Spawn cwd (resolved against the workspace). [prompt]
- `Environment` → `Environment`
- `Timeout (ms)` — Connect + request timeout for this server. [prompt]
- `Remove server` [confirm]

#### `MCP <server-local> - tools (N)`
Path: `Config Studio` -> `Settings` -> `Tools & files` -> `MCP servers` -> `MCP <server-local> (local)` -> `MCP <server-local> - tools (N)`
- `(probe failed)` — Direct protocol probe failed: spawn <command> ENOENT
- `Re-fetch tool list`

#### `Command`
Path: `Config Studio` -> `Settings` -> `Tools & files` -> `MCP servers` -> `MCP <server-local> (local)` -> `Command`
- `<command>` → `<command>`
- `+ Add entry`

#### `<command>`
Path: `Config Studio` -> `Settings` -> `Tools & files` -> `MCP servers` -> `MCP <server-local> (local)` -> `Command` -> `<command>`
- `Edit`
- `Remove` → (config layer picker)
- `Move up`
- `Move down`

#### `Environment`
Path: `Config Studio` -> `Settings` -> `Tools & files` -> `MCP servers` -> `MCP <server-local> (local)` -> `Environment`
- `Edit as JSON` [prompt]
- `Remove` → (config layer picker)

#### `MCP <server-runtime> (remote, runtime)`
Path: `Config Studio` -> `Settings` -> `Tools & files` -> `MCP servers` -> `MCP <server-runtime> (remote, runtime)`
- `Status: (unavailable)` → [view] `MCP <server-runtime> - status`
- `Tools (-)` — Tools registered by MCP server "<server-runtime>". → `MCP <server-runtime> - tools (N)`
- `URL: <url>`

#### `MCP <server-runtime> - tools (N)`
Path: `Config Studio` -> `Settings` -> `Tools & files` -> `MCP servers` -> `MCP <server-runtime> (remote, runtime)` -> `MCP <server-runtime> - tools (N)`
- `(probe failed)` — Direct protocol probe failed: fetch failed
- `Re-fetch tool list`

#### `Formatter` [pin]
Path: `Config Studio` -> `Settings` -> `Tools & files` -> `Formatter`
- `true` → (config layer picker)
- `false` → (config layer picker)
- `Edit as JSON` [prompt]
- `Remove` → (config layer picker)

#### `LSP servers` [pin]
Path: `Config Studio` -> `Settings` -> `Tools & files` -> `LSP servers`
- `true` → (config layer picker)
- `false` → (config layer picker)
- `Edit as JSON` [prompt]
- `Remove` → (config layer picker)

#### `File watcher`
Path: `Config Studio` -> `Settings` -> `Tools & files` -> `File watcher`
- `Ignore globs` — Globs excluded from edit tracking. → `Ignore globs`

#### `Permissions` [pin]
Path: `Config Studio` -> `Settings` -> `Tools & files` -> `Permissions`
- `Shorthand (all tools)` → `Shorthand rule (every tool)`
- `edit` — Action for the whole tool, or per-pattern rules. → `edit rule`
- `i How matching works` → [view] `Permission matching`
- ... (dynamic list: (N) more rows)

#### `edit rule`
Path: `Config Studio` -> `Settings` -> `Tools & files` -> `Permissions` -> `edit rule`
- `ask` → (config layer picker)
- `allow` → (config layer picker)
- `deny` → (config layer picker)
- `Pattern rules...` → `edit patterns (last match wins)`

#### `edit patterns (last match wins)`
Path: `Config Studio` -> `Settings` -> `Tools & files` -> `Permissions` -> `edit rule` -> `edit patterns (last match wins)`
- `+ Add pattern`
- `Save` → (config layer picker)

#### `Session behavior` [pin]
Path: `Config Studio` -> `Settings` -> `Session behavior`
- `Image attachments` — Image attachment processing limits. → `Image attachments`
- `Tool output limits` → `Tool output limits`
- `Compaction` — Automatic context compaction behavior. → `Compaction`
- `Snapshots` — Track file snapshots for undo/revert (default true). → `Snapshots`

#### `Image attachments`
Path: `Config Studio` -> `Settings` -> `Session behavior` -> `Image attachments`
- `Image` — Image resize / size limits. → `Image`

#### `Image`
Path: `Config Studio` -> `Settings` -> `Session behavior` -> `Image attachments` -> `Image`
- `Auto resize` — Resize large images before sending (default true). → `Auto resize`
- `Max width` — Resize target width in pixels. [prompt]
- `Max height` — Resize target height in pixels. [prompt]
- `Max base64 bytes` [prompt]

#### `Tool output limits`
Path: `Config Studio` -> `Settings` -> `Session behavior` -> `Tool output limits`
- `Max lines` — Truncate tool outputs longer than this (default 2000). [prompt]
- `Max bytes` — Truncate tool outputs beyond this size (default 51200). [prompt]

#### `Compaction`
Path: `Config Studio` -> `Settings` -> `Session behavior` -> `Compaction`
- `Auto compaction` — Compact automatically when context overflows (default true). → `Auto compaction`
- `Prune` — Drop old tool outputs instead of summarizing (default false). → `Prune`
- `Tail turns` [prompt]
- `Preserve recent tokens` [prompt]
- `Reserved tokens` — Tokens reserved as headroom when auto-compaction triggers. [prompt]

#### `Server` [pin]
Path: `Config Studio` -> `Settings` -> `Server`
- `Server` — opencode serve / web host settings. → `Server (Port)`

#### `Server (Port)` [pin]
Path: `Config Studio` -> `Settings` -> `Server` -> `Server (Port)`
- `Port` — TCP port for opencode serve. [prompt]
- `Hostname` — Bind hostname for the server. [prompt]
- `mDNS advertise` — Advertise the server over local network mDNS. → `mDNS advertise`
- `mDNS domain` — mDNS hostname advertised. [prompt]
- `CORS origins` — Allowed CORS origin patterns for the HTTP API. → `CORS origins`

#### `Developer` [pin]
Path: `Config Studio` -> `Settings` -> `Developer`
- `Plugins` — External plugin packages (npm specs or file:// paths). → `Plugins`
- `Experimental flags` — Feature flags - these can change or disappear between releases. → `Experimental flags`

#### `Plugins`
Path: `Config Studio` -> `Settings` -> `Developer` -> `Plugins`
Also via: `Config Studio` -> `Plugins`
- `@mirrowel/opencode-agent-variants@dev` → `@mirrowel/opencode-agent-variants@dev`
- `+ Add plugin`

#### `@mirrowel/opencode-agent-variants@dev`
Path: `Config Studio` -> `Settings` -> `Developer` -> `Plugins` -> `@mirrowel/opencode-agent-variants@dev`
- `Remove` [confirm]

#### `Experimental flags`
Path: `Config Studio` -> `Settings` -> `Developer` -> `Experimental flags`
- `Disable paste summary` → `Disable paste summary`
- `OpenTelemetry` — Emit OTel spans for AI SDK calls. → `OpenTelemetry`
- `Primary-only tools` → `Primary-only tools`
- `Continue loop on deny` → `Continue loop on deny`
- `MCP timeout (ms)` [prompt]

#### `Deprecated` [pin]
Path: `Config Studio` -> `Settings` -> `Deprecated`
- `Autoshare [deprecated]` — Legacy sharing switch. → `Autoshare`
- `Reference (legacy) [deprecated]` → `References`
- `Mode agents (legacy) [deprecated]` → `Mode agents (legacy)`
- `Tools toggles (legacy) [deprecated]` → `Tools toggles (legacy)`
- `Layout [dead]` — Legacy layout selector. [confirm]
- `Log level [dead]` [confirm]

#### `Mode agents (legacy)`
Path: `Config Studio` -> `Settings` -> `Deprecated` -> `Mode agents (legacy)`
- `Edit as JSON` [prompt]
- `Remove` → (config layer picker)

#### `Tools toggles (legacy)`
Path: `Config Studio` -> `Settings` -> `Deprecated` -> `Tools toggles (legacy)`
- `Edit as JSON` [prompt]
- `Remove` → (config layer picker)

#### `TUI settings (tui.json)`
Path: `Config Studio` -> `TUI settings (tui.json)`
- `Target file` → (config layer picker)
- `Theme` — Theme name (33 bundled + any custom theme discovered at runtime). → `Theme`
- `Diff style` — How diffs render in the diff viewer. → `Diff style`
- `Mouse` — Mouse support (scroll, click). → `Mouse`
- `Leader timeout (ms)` [prompt]
- `Scroll speed` — Scroll lines per wheel event (number >= 0.001, or a string preset). [prompt]
- `Scroll acceleration` — Accelerate scrolling during continuous wheel events. → `Scroll acceleration`
- `Cursor` — Terminal cursor appearance. → `Cursor`
- `Attention` — Notifications and sound when the agent finishes or needs input. → `Attention`
- `Prompt box` — Prompt input sizing. → `Prompt box`
- `Keybinds`
- `Plugin enable toggles` → `Plugin enable toggles`
- `! Restart note` → [view] `RESTART REQUIRED`

#### `Theme`
Path: `Config Studio` -> `TUI settings (tui.json)` -> `Theme`
- `(not set - remove)` → (config layer picker)
- ... (dynamic list: (N) more rows)

#### `Scroll acceleration`
Path: `Config Studio` -> `TUI settings (tui.json)` -> `Scroll acceleration`
- `Enabled` — Enable scroll acceleration. → `Enabled`

#### `Cursor`
Path: `Config Studio` -> `TUI settings (tui.json)` -> `Cursor`
- `Style` — Cursor shape. → `Style`
- `Blinking` — Blink the cursor. → `Blinking`

#### `Attention`
Path: `Config Studio` -> `TUI settings (tui.json)` -> `Attention`
- `Enabled` — Master switch (default false). → `Enabled`
- `Notifications` — OS notifications. → `Notifications`
- `Sound` — Play sounds. → `Sound`
- `Volume` — 0.0 - 1.0. [prompt]
- `Sound pack` — Named sound pack. [prompt]
- `Custom sounds` — Per-event sound file paths (relative to the config file). → `Custom sounds`

#### `Custom sounds`
Path: `Config Studio` -> `TUI settings (tui.json)` -> `Attention` -> `Custom sounds`
- `default` — Fallback sound path. [prompt]
- `+ Add key`
- ... (dynamic list: (N) more rows)

#### `Prompt box`
Path: `Config Studio` -> `TUI settings (tui.json)` -> `Prompt box`
- `Max height` — Maximum prompt box height in rows. [prompt]
- `Max width` — Maximum width in columns, or "auto". [prompt]

#### `Plugin enable toggles`
Path: `Config Studio` -> `TUI settings (tui.json)` -> `Plugin enable toggles`
- `Edit as JSON` [prompt]
- `Remove` → (config layer picker)

#### `Tools`
Path: `Config Studio` -> `Tools`
- `Subagent sessions` [dialog]
- `Task id suggestions (typo 3, list 10)` [dialog]

#### `Config files (5 layers, weakest first)`
Path: `Config Studio` -> `Config files (5 layers, weakest first)`
- `global:config.json` → `global:config.json`
- `project:./opencode.json` → `project:./opencode.json`
- `global:opencode.jsonc` → `global:opencode.jsonc`
- `opencode-dir:.opencode/opencode.json` → `opencode-dir:.opencode/opencode.json`
- `opencode-dir:.opencode/opencode.jsonc` → `opencode-dir:.opencode/opencode.jsonc`
- `+ Create a missing config file` → (config layer picker)
- `Backups` [dialog]

#### `global:config.json`
Path: `Config Studio` -> `Config files (5 layers, weakest first)` -> `global:config.json`
- `Inspect file [i]` → [view] `global:config.json`
- `Set as write target` → `global:config.json`
- `Raw content` — Shows the raw file content. → [view] `<tmp>/config.json`

#### `project:./opencode.json`
Path: `Config Studio` -> `Config files (5 layers, weakest first)` -> `project:./opencode.json`
- `Inspect file [i]` → [view] `project:./opencode.json`
- `Set as write target` → `project:./opencode.json`
- `Raw content` — Shows the raw file content. → [view] `<tmp>/opencode.json`

#### `global:opencode.jsonc`
Path: `Config Studio` -> `Config files (5 layers, weakest first)` -> `global:opencode.jsonc`
- `Inspect file [i]` → [view] `global:opencode.jsonc`
- `Set as write target` → `global:opencode.jsonc`
- `Raw content` — Shows the raw file content. → [view] `<tmp>/opencode.jsonc`

#### `opencode-dir:.opencode/opencode.json`
Path: `Config Studio` -> `Config files (5 layers, weakest first)` -> `opencode-dir:.opencode/opencode.json`
- `Inspect file [i]` → [view] `opencode-dir:.opencode/opencode.json`
- `Set as write target` → `opencode-dir:.opencode/opencode.json`
- `Raw content` — Shows the raw file content. → [view] `<tmp>/.opencode/opencode.json`

#### `opencode-dir:.opencode/opencode.jsonc`
Path: `Config Studio` -> `Config files (5 layers, weakest first)` -> `opencode-dir:.opencode/opencode.jsonc`
- `Inspect file [i]` → [view] `opencode-dir:.opencode/opencode.jsonc`
- `Set as write target` → `opencode-dir:.opencode/opencode.jsonc`
- `Raw content` — Shows the raw file content. → [view] `<tmp>/.opencode/opencode.jsonc`

#### `Modules`
Path: `Config Studio` -> `Modules`
Also via: `Subagent Explorer` -> `Toggle enabled`; `Agent Variants` -> `Toggle enabled`
- `Subagent Explorer` → `Subagent Explorer`
- `Agent Variants` — Model variants of subagents: aliases, routing, presets, inheritance. → `Agent Variants`

#### `Subagent Explorer`
Path: `Config Studio` -> `Modules` -> `Subagent Explorer`
- `Toggle enabled` → `Modules`
- `Open native explorer` [dialog]
- `Source & channel` → `Subagent Explorer source`

#### `Subagent Explorer source`
Path: `Config Studio` -> `Modules` -> `Subagent Explorer` -> `Subagent Explorer source`
- `Use standalone install` → `Subagent Explorer source`
- `* Use embedded copy` → `Subagent Explorer source`
- `Set standalone channel/version` [dialog]
- `Add standalone plugin entry` → (config layer picker)

#### `Agent Variants`
Path: `Config Studio` -> `Modules` -> `Agent Variants`
- `Toggle enabled` → `Modules`
- `Toggle Own menu`
- `Source & channel` → `Agent Variants source`

#### `Agent Variants source`
Path: `Config Studio` -> `Modules` -> `Agent Variants` -> `Agent Variants source`
- `Use standalone install` → `Agent Variants source`
- `* Use embedded copy` → `Agent Variants source`
- `Set standalone channel/version` → `Channel for @mirrowel/opencode-agent-variants@dev`
- `Add standalone plugin entry` → (config layer picker)

#### `Channel for @mirrowel/opencode-agent-variants@dev`
Path: `Config Studio` -> `Modules` -> `Agent Variants` -> `Agent Variants source` -> `Channel for @mirrowel/opencode-agent-variants@dev`
- `latest (stable)` → (config layer picker)
- `dev (prerelease)`
- `Exact version...`

#### `Advanced`
Path: `Config Studio` -> `Advanced`
- `Dialog size picker: large, 50%` [dialog]
- `Reload config now` [confirm]
- `AV debug mode: <state>`
- `AV prompt route markers: <state>`
- `AV view debug log` [dialog]
- `AV clear debug log` [dialog]
- `AV sidecar backups` [dialog]
- `AV parent picker filter: <state>` → `Advanced`

#### State screens

Menus that only pick a state value:

- `Agent <agent> - Mode`: `(not set - remove)`, `subagent`, `primary`, `all`
- `Agent <agent> - Hidden`: `(not set - remove)`, `true`, `false`
- `Agent <agent> - Disabled`: `(not set - remove)`, `true`, `false`
- `Session sharing`: `(not set - remove)`, `manual`, `auto`, `disabled`
- `Auto-update`: `(not set - remove)`, `true`, `false`, `notify`
- `Auto resize`: `(not set - remove)`, `true`, `false`
- `Auto compaction`: `(not set - remove)`, `true`, `false`
- `Prune`: `(not set - remove)`, `true`, `false`
- `Snapshots`: `(not set - remove)`, `true`, `false`
- `mDNS advertise`: `(not set - remove)`, `true`, `false`
- `Disable paste summary`: `(not set - remove)`, `true`, `false`
- `OpenTelemetry`: `(not set - remove)`, `true`, `false`
- `Continue loop on deny`: `(not set - remove)`, `true`, `false`
- `Autoshare`: `(not set - remove)`, `true`, `false`
- `Diff style`: `(not set - remove)`, `auto`, `stacked`
- `Mouse`: `(not set - remove)`, `true`, `false`
- `Enabled`: `(not set - remove)`, `true`, `false`
- `Style`: `(not set - remove)`, `block`, `underline`, `line`, `default`
- `Blinking`: `(not set - remove)`, `true`, `false`
- `Notifications`: `(not set - remove)`, `true`, `false`
- `Sound`: `(not set - remove)`, `true`, `false`

#### List editors

Menus that only add entries:

- `API key env vars`: `+ Add entry`
- `Model whitelist`: `+ Add entry`
- `Model blacklist`: `+ Add entry`
- `Model entries (config) - <provider>`: `+ Add model`
- `Instruction files`: `+ Add entry`
- `Paths`: `+ Add entry`
- `URLs`: `+ Add entry`
- `References`: `+ Add reference`
- `Slash commands`: `+ Add command`
- `Ignore globs`: `+ Add entry`
- `CORS origins`: `+ Add entry`
- `Primary-only tools`: `+ Add entry`

## Part 2 — Config Studio (own-menu layout additions)

```
- `Config Studio` (shared main menu - see Part 1)
  - `Agent Variants (own-menu)` [own-menu only]
```

#### `Agent Variants (own-menu)` [own-menu only]
Path: `Config Studio` -> `Agent Variants (own-menu)`
- `Profile context: Global default` [dialog]
- `Add variant` — Creates a new variant under a parent agent. [dialog]
- `Edit variant`
- `Toggle disable`
- `Delete variant`
- `Edit parent fields` [dialog]
- `Model presets (N)` [dialog]

## Part 3 — Agent Variants standalone wizard (root: `Agent Variants`)

Status: walk attempted. The installed `@mirrowel/opencode-agent-variants` bundle exposes `mainMenu` and no probe seam (`__setMenuProbe`: absent); every wizard menu renders through the host dialog layer, so the walker records the entry row but not the menu rows.

- Root title from `lensTitle("Agent Variants", undefined)`: `Agent Variants`
- Attempt: 1 host dialog mount attempt(s); outcome `__probe_renderer_unavailable__`
- Exported wizard functions (28): `THEME_COLORS`, `addVariantFor`, `agentMode`, `agentModes`, `applyWizardUiSettings`, `clearDebugLog`, `configBackupsMenu`, `deleteVariantFor`, `editParentFields`, `editVariantFor`, `generatedAliasSet`, `lensTitle`, `mainMenu`, `manageModelPresets`, `manageProfiles`, `newWizardSettings`, `parentColor`, `parentModePicker`, `pickParentAgent`, `profileSwitcher`, `promptForField`, `showFieldList`, `taskValidationScreen`, `toggleEntryFor`, `variantCount`, `viewDebugLog`, `warnStructuralInProfile`, `wizardInfoText`

### Renderer-backed leaf flows

Rows whose follow-up windows are rendered by the agent-variants wizard (`wizard`) or the subagent-explorer (`explorer`) and are not probe-routable; the map stops at the entry row. Studio-rendered dialogs are marked `[dialog]` in the sections instead.

- `AV clear debug log` (wizard) — in 1 menu(s), e.g. `Advanced`
- `AV parent patches` (wizard) — in 2 menu(s), e.g. `Agent <agent>`, `Agent <agent> (no Hidden, Disabled)`
- `AV profiles (N)` (wizard) — in 1 menu(s), e.g. `Agents`
- `AV sidecar backups` (wizard) — in 1 menu(s), e.g. `Advanced`
- `AV view debug log` (wizard) — in 1 menu(s), e.g. `Advanced`
- `Add variant` (wizard) — in 1 menu(s), e.g. `Agent Variants (own-menu)`
- `Edit parent fields` (wizard) — in 1 menu(s), e.g. `Agent Variants (own-menu)`
- `Model presets (N)` (wizard) — in 2 menu(s), e.g. `Agent Variants (own-menu)`, `Agents`
- `Open native explorer` (explorer) — in 1 menu(s), e.g. `Subagent Explorer`
- `Profile context: Global default` (wizard) — in 1 menu(s), e.g. `Agent Variants (own-menu)`
- `Subagent sessions` (explorer) — in 1 menu(s), e.g. `Tools`
- `Task id suggestions (typo 3, list 10)` (wizard) — in 1 menu(s), e.g. `Tools`
- `Task-list & calling: normal` (wizard) — in 2 menu(s), e.g. `Agent <agent>`, `Agent <agent> (no Hidden, Disabled)`

## Walker limits

- `integrated/reload-pending`: 537 run(s), 134 menu(s), 536 edge(s)
- `integrated/idle`: 519 run(s), 132 menu(s), 518 edge(s)
- `own-menu/reload-pending`: 535 run(s), 134 menu(s), 534 edge(s)
- `own-menu/idle`: 516 run(s), 132 menu(s), 515 edge(s)
- `integrated/idle-av-sidecar`: 539 run(s), 134 menu(s), 538 edge(s)
- Studio-rendered dialogs (marked `[dialog]` in the sections): `<variant>`, `Backups`, `Capture default (no variant)`, `Capture variant <variant>`, `Dialog size picker: large, 50%`, `Set standalone channel/version`

Known walker gaps: rows that open a text prompt first (e.g. `Keybinds` search, `+ Add plugin`, `+ New agent...`, `Exact version...`) stop at the prompt; confirm-gated flows (save/review summaries, destructive confirms) answer "no" and re-present the menu. Their follow-up windows are not walked.

Future work: adding a `__setMenuProbe` seam to `@mirrowel/opencode-agent-variants` would let this walker map the standalone wizard's internal menus instead of stopping at its entry rows.
