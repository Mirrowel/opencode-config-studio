# OpenCode Settings Reference

> Verified against OpenCode source code @ 2026-08-18. File references use `packages/...` paths relative to the OpenCode repo root.
>
> This is the canonical artifact for Config Studio's field-help system. When OpenCode behavior changes, update this file first, then `src/keymeta.ts` and `src/docs.ts`.

## Config file layout

| File | Scope |
|---|---|
| `~/.config/opencode/config.json`, `opencode.json`, `opencode.jsonc` | Global (all three merge in this order) |
| `OPENCODE_CONFIG` env file | Between global and project |
| `opencode.json[c]` walking up cwd→worktree root | Project (deepest wins) |
| `.opencode/opencode.json[c]` dirs (global + up-tree) | Strongest project family |
| `OPENCODE_CONFIG_CONTENT` env, org console, managed (`/etc/opencode`, MDM plist) | Non-file layers (override; not editable here) |

Merge: deep-merge later-wins, **except `instructions`** which concatenates + dedupes across all layers. Unknown root keys are silently dropped (`onExcessProperty: "ignore"`).

**Hot-reload:** there is no config file watcher. The merged config is memoized per directory; it is re-read only when instances are disposed and rebuilt (config PATCH API, TUI SIGUSR2/reload RPC, or restart). Practically: keys consumed by per-request readers pick changes up after the studio's Save & exit reload; structural registries (agents, LSP, MCP, providers, plugins) need a restart.

---

## Root keys (`opencode.json`)

Schema: `packages/core/src/v1/config/config.ts` (ConfigV1.Info).

### Models & agents

| Key | Type | Default | Timing | Notes |
|---|---|---|---|---|
| `model` | `provider/model` | most-recent used, else picker priority (`gpt-5 > claude-sonnet-4 > big-pickle > gemini-3-pro`, provider.ts:2017-2026) | live | Split on FIRST `/`. Unknown → ModelNotFoundError. |
| `small_model` | `provider/model` | plugin hook, else newest of family `gemini-flash`/`gpt-nano`/`claude-haiku` (provider.ts:1909-1976) | live | Titles, summaries, project-copy. |
| `default_agent` | string | first visible non-subagent (= `build`) | reload | Must exist, not subagent, not hidden — else throws (agent.ts:328-339). |
| `subagent_depth` | int ≥ 0 | `1` (tool/task.ts:111) | live | 0 disables task tool; N = max nesting. |
| `agent` | map | built-ins: `build`, `plan` (primary); `general`, `explore` (subagent); `compaction`, `title`, `summary` (primary+hidden) | reload | See Agent fields below. Markdown agents `.opencode/{agent,agents}/**/*.md` override same-name entries (merged after config). |

### Agent fields (`agent.<name>` / markdown frontmatter)

Schema: `packages/core/src/v1/config/agent.ts:12-41`. **Unknown keys fold into `options`** (`:62-81`).

| Field | Type | Notes |
|---|---|---|
| `model` | `provider/model` | Per-agent model. |
| `variant` | string | `provider/model#variant` selection; only used when the agent has its own model. |
| `temperature` / `top_p` | number | Standard sampling params. |
| `prompt` | string | Full system-prompt override (markdown body = prompt). |
| `mode` | `subagent` \| `primary` \| `all` | `subagent` = task-tool only (cannot be default_agent, hidden from top-level lists); `primary` = top-level only; `all` = both. Default for JSON custom agents: `all` (agent.ts:274-280). |
| `hidden` | boolean | Hides from pickers/autocomplete; only meaningful for subagents. |
| `steps` | PositiveInt | Max agentic iterations before forced text-only reply (`agent.steps ?? Infinity`, prompt.ts:1178-1179). `maxSteps` is a deprecated alias. |
| `disable` | boolean | Deletes the agent entirely (built-ins too, agent.ts:268-271). |
| `permission` | rules | Agent-level permission; deep-merged over root rules. |
| `description` / `color` / `options` | — | Task-list description; theme color; request options. |

### Sharing & updates

| Key | Type | Default | Notes |
|---|---|---|---|
| `share` | `manual` \| `auto` \| `disabled` | `manual` | `auto`: every root session shared in background (share/session.ts:39-46). `disabled`: share() throws. Env `OPENCODE_DISABLE_SHARE` kills the sync backend. Target: org console ?? `enterprise.url` ?? `https://opncd.ai`. |
| `autoupdate` | `true` \| `false` \| `notify` | `true` | `true`+patch+known install → installs; `notify` or non-patch → event only; `false`/env `OPENCODE_DISABLE_AUTOUPDATE` → never checks (cli/upgrade.ts). |
| `username` | string | OS username (config.ts:566-573) | Telemetry identity + display. NOT the HTTP basic-auth user (that's `OPENCODE_SERVER_USERNAME`). |
| `enterprise` | `{url}` | `https://opncd.ai` | Share-service base when no org account. |

### Providers

| Key | Type | Notes |
|---|---|---|
| `disabled_providers` | string[] | Exact provider ids removed (applied after allowlist). |
| `enabled_providers` | string[] | Allowlist applied first; a provider in BOTH lists is excluded (provider.ts:1418-1422). Also filters `opencode auth login` picker and HTTP `/provider`. |
| `provider` | map | Full provider entries — see Provider fields below. |

### Tools & files

| Key | Type | Default | Notes |
|---|---|---|---|
| `shell` | string | platform fallback (win32: pwsh→powershell→git-bash→COMSPEC; macOS: zsh; else bash→sh) | Preferred shell for terminal + `!`cmd`` templates + bash tool. **fish and nu are blacklisted for the bash tool** (core/src/shell.ts:16-18). Unresolvable value → fallback. |
| `instructions` | string[] | — | **Concatenates across layers.** Entries: http(s) URL (5s timeout), glob (relative walks up dir→worktree), absolute path, `~/`. Injected as "Instructions from: <path>". Adds to AGENTS.md/CLAUDE.md. |
| `skills` | `{paths, urls}` | — | paths: `**/SKILL.md` scan (relative → instance dir; missing → warning). urls: fetch `<url>/index.json` → cache. Auto-discovery independent: `{skill,skills}/**` + `~/.claude/skills`, `~/.agents/skills`. |
| `references` | map | — | name → `{repository, branch?, description?, hidden?}` (git; cloned to cache, auto allowed as external_directory) or `{path, description?, hidden?}` (local; relative to declaring config file's dir). String entries: local iff starts with `.` `/` `~`. `description` announces in system prompt; `hidden` hides from @ picker. Alias name must have no `/`, whitespace, backtick, comma. |
| `mcp` | map | — | name → local `{type:"local", command[], cwd?, environment?, enabled?, timeout?}` or remote `{type:"remote", url, headers?, oauth?, enabled?, timeout?}`. Entries without `type` are dropped ("Ignoring MCP config entry without type"). `{enabled:false}` overlays stay configured but never connect. Restart to apply. |
| `command` | map | — | name → `{template (required), description?, agent?, model?, variant?, subtask?}`. Placeholders: `$1..$N` (highest gets rest) and `$ARGUMENTS`; else args appended after blank line. `` !`cmd` `` shell-inlined. `@file` mentions. Subagent-mode agent → always subtask; `subtask:true` forces detached run. Markdown `{command,commands}/**/*.md` merge too. Built-ins: `init`, `review`. |
| `permission` | rules | per-tool ask | Shorthand `"ask"|"allow"|"deny"` = `{*}`; per-tool string or `{pattern: action}` maps. `write`/`edit`/`patch` fold into `edit`. Legacy `tools{}` converts; real permission wins. Env `OPENCODE_PERMISSION` JSON merges last. Precedence: built-ins < root < agent < session approvals. Last matching rule wins; `*` `?` wildcards; deny `*` hides tool from model. |
| `formatter` | bool \| map | all built-ins with auto-detection | map: `{disabled?, command[] ($FILE), environment, extensions[]}`; custom formatter must supply `command` or never enables. `ruff`+`uv` are one backend — disabling either removes both. Built-ins: gofmt, mix, prettier, oxfmt, biome, zig, clang-format, ktlint, ruff, air, uv, rubocop, standardrb, htmlbeautifier, dart, ocamlformat, terraform, latexindent, gleam, shfmt, nixfmt, rustfmt, pint, ormolu, cljfmt, dfmt. |
| `lsp` | bool \| map | unset → all LSP disabled | map: builtin name → `{disabled}` or custom → `{command[] (required), extensions[], disabled?, env?, initialization?}`. **Custom servers MUST declare `extensions`** (validation error). Built-ins: deno, typescript, vue, eslint, oxlint, biome, gopls, ruby-lsp, ty, pyright, elixir-ls, zls, csharp, razor, fsharp, sourcekit-lsp, rust, clangd, svelte, astro, jdtls, kotlin-ls, yaml-ls, lua-ls, php intelephense, prisma, dart, ocaml-lsp, bash, terraform, texlab, dockerfile, gleam, clojure-lsp, nixd, tinymist, haskell-language-server, julials. Restart. |
| `watcher` | `{ignore}` | — | Parcel-watcher ignore globs for the worktree subscription (experimental filewatcher). |

### Session behavior

| Key | Type | Default | Notes |
|---|---|---|---|
| `attachment` | `{image{auto_resize, max_width, max_height, max_base64_bytes}}` | `true, 2000, 2000, 5242880` | Over-limit + auto_resize → iterative Lanczos3 downscale (PNG then JPEG 80/85/70/55/40); still over / auto_resize:false → SizeError rejects the attachment. |
| `tool_output` | `{max_lines, max_bytes}` | `2000, 51200` | Either limit exceeded → head/tail preview + "...N lines/bytes truncated..." + hint to delegate via Task/Grep; full text saved (7-day cleanup). |
| `compaction` | `{auto, prune, tail_turns, preserve_recent_tokens, reserved}` | `true, false, unlimited, clamp(25% usable, 2000..15000), min(20000, maxOutput)` | `auto:false` → NO auto-compaction; overflowing requests fail with the provider error (env `OPENCODE_DISABLE_AUTOCOMPACT`). `reserved` subtracts from input limit (bigger = earlier compaction). `tail_turns:0` = no verbatim tail. `prune` clears old tool outputs (≥20k tokens freed, newest 40k protected) as `[Old tool result content cleared]` (env `OPENCODE_DISABLE_PRUNE`). |
| `snapshot` | boolean | `true` | Shadow git repo for undo/revert (git projects only). `false` = no file-change undo. Untracked >2MB excluded. |

### Server & developer

| Key | Type | Default | Notes |
|---|---|---|---|
| `server` | `{port, hostname, mdns, mdnsDomain, cors}` | `0 (random), 127.0.0.1, false, opencode.local, []` | `mdns:true` + no hostname → binds `0.0.0.0`. cors = union of config + CLI. Restart. |
| `plugin` | array | — | `string \| [string, options]`. Specs: npm (`pkg@version`, bare → `@latest`), `file://`, relative (→ declaring config file's dir) or absolute paths. Dedup by package name / exact URL, later wins. `.opencode/{plugin,plugins}/*.{ts,js}` auto-discover. `engines.opencode` enforced. Restart. |
| `experimental` | flags | — | `disable_paste_summary` (default paste-summary ON), `openTelemetry` (OTel spans + `experimental_telemetry`), `primary_tools` (denied `*` in Task children), `continue_loop_on_deny` (default STOPS loop on deny; true continues), `mcp_timeout` (fallback when server has no `timeout`). |

### Deprecated / dead

| Key | Status | Replacement |
|---|---|---|
| `autoshare` | deprecated | `share: "auto"` |
| `reference` | deprecated | `references` (only read when `references` absent) |
| `mode` | deprecated | `agent` (+ `mode: "primary"`) |
| `tools` | deprecated | `permission` |
| `agent.tools` / `agent.maxSteps` | deprecated | `agent.permission` / `agent.steps` |
| `layout` | DEAD | always stretch; delete |
| `logLevel` | DEAD in files | runtime from `OPENCODE_LOG_LEVEL` / `--log-level`; delete |
| `theme`/`keybinds`/`tui` in opencode.json | stripped at load | auto-migrate to tui.json |

---

## Provider entries (`provider.<id>`)

Schema: `packages/core/src/v1/config/provider.ts:82-126`. Config deep-merges over the models.dev catalog per field (config wins per key; `options`/`headers` deep-merge; provider `source` becomes `"config"`, provider.ts:1452-1550).

| Field | Type | Notes |
|---|---|---|
| `name` | string | Display name. Fallback: catalog → provider key. |
| `id` | string | Rarely used; the map key is the authoritative id. |
| `api` | string | **Base URL** (not a protocol enum — the wire protocol is chosen solely by `npm`). Resolution: `options.baseURL` ?? `model.provider.api` ?? this ?? catalog. `${VAR}` env substitution supported. |
| `npm` | string | SDK package (table below). Fallback chain ends at `@ai-sdk/openai-compatible`. Per-model override via `models.<mid>.provider.npm`. |
| `env` | string[] | API-key env vars probed **in array order, first set wins** (provider.ts:1557). Determines autoload (no key + no auth ⇒ inactive). |
| `options` | object | Known keys below; anything else is forwarded verbatim to the SDK factory. |
| `whitelist` | string[] | **Exact** model-id membership (no globs); keeps only listed models. |
| `blacklist` | string[] | Exact-match removal applied after whitelist. |
| `models` | map | Model entries (below). |

### Provider `options`

| Key | Notes |
|---|---|
| `apiKey` | Wins over env vars and auth store. `{env:VAR}` / `{file:path}` substitution on raw config text (the recommended way to keep keys out of files). |
| `baseURL` | Overrides `api`/catalog URL. Passed verbatim (no trailing-slash normalization). |
| `timeout` | ms or `false`. Whole-request abort. |
| `headerTimeout` | ms or `false`. Time-to-response-headers. OpenAI default 300000. |
| `chunkTimeout` | ms. SSE inter-chunk watchdog. |
| `setCacheKey` | boolean; enables promptCacheKey emission. |
| `enterpriseUrl` | GitHub Enterprise URL for copilot auth. |
| (others) | SDK-specific: Azure `resourceName`/`useCompletionUrls`, Bedrock `region`/`profile`/`endpoint`, Vertex `project`/`location`. |

### SDK packages (`npm`)

Bundled (provider.ts:107-134); anything else published as an AI-SDK factory (export starting with `create`) is installed at runtime via Bun. `file://` URLs also accepted.

| Package | API family | When to pick |
|---|---|---|
| `@ai-sdk/openai-compatible` | OpenAI chat-completions | **Default fallback.** Any gateway/local server exposing the OpenAI chat schema (Ollama, vLLM, LM Studio, LiteLLM...). Needs `options.baseURL`. |
| `@ai-sdk/openai` | OpenAI **Responses** API | OpenAI proper or `/v1/responses` endpoints. |
| `@ai-sdk/anthropic` | Anthropic Messages | Claude; Anthropic-compatible endpoints. Interleaved-thinking + fine-grained-tool-streaming beta headers; auto prompt caching. |
| `@ai-sdk/azure` | Azure OpenAI (Responses; chat via `useCompletionUrls`) | Azure-hosted OpenAI. Needs `resourceName`/`AZURE_RESOURCE_NAME` or `baseURL`. |
| `@ai-sdk/google` | Gemini (API key) | Google AI Studio. |
| `@ai-sdk/google-vertex` | Vertex AI (ADC) | GCP default credentials. Needs `project`/env. |
| `@ai-sdk/google-vertex/anthropic` | Anthropic on Vertex | Claude on GCP. |
| `@ai-sdk/amazon-bedrock` | Bedrock InvokeModel (SigV4) | Bedrock with IAM. Options `region` (default us-east-1), `profile`, `endpoint`. Cross-region prefixes auto-applied. |
| `@ai-sdk/amazon-bedrock/mantle` | Bedrock Mantle (Responses) | Responses-style on Mantle. |
| `@ai-sdk/gateway` | Vercel AI Gateway | Model ids `provider/model`. |
| `@openrouter/ai-sdk-provider` | OpenRouter | Sends opencode referer headers. |
| `@ai-sdk/github-copilot` | Copilot passthrough | OAuth device flow; `enterpriseUrl` for GHES. |
| `gitlab-ai-provider` | GitLab Duo | `GITLAB_TOKEN` or OAuth. |
| `@ai-sdk/xai` | xAI Grok (Responses) | grok.com. |
| `@ai-sdk/mistral` | Mistral | Tool-call-id scrubbing fix. |
| `@ai-sdk/groq` | Groq | — |
| `@ai-sdk/deepinfra` | DeepInfra | prompt_cache_key. |
| `@ai-sdk/cerebras` | Cerebras | 3rd-party integration header. |
| `@ai-sdk/cohere` | Cohere | Reasoning via thinking toggle only. |
| `@ai-sdk/togetherai` | Together | — |
| `@ai-sdk/perplexity` | Perplexity Sonar | No reasoning variants. |
| `@ai-sdk/vercel` | Vercel marketplace | Referer headers. |
| `@ai-sdk/alibaba` | DashScope | Qwen; anthropic-style cacheControl. |
| `venice-ai-sdk-provider` | Venice | disableThinking small-model default. |
| `@jerome-benoit/sap-ai-provider-v2` | SAP AI Core | Reasoning wrapped in `modelParams`. |
| `ai-gateway-provider` | Cloudflare AI Gateway | Ids `provider/model`. |

---

## Model entries (`provider.<id>.models.<mid>`)

Schema: `packages/core/src/v1/config/provider.ts:13-80`; parsed at provider.ts:1463-1547.

| Field | Type | Notes |
|---|---|---|
| `name` | string | Display name. |
| `id` | string | **Upstream API model id override** — the map key is the opencode-facing id; the SDK is called with `model.api.id` (= this ?? catalog ?? key). |
| `family` | string | Grouping; drives small-model priority + reasoning heuristics. |
| `release_date` | `YYYY-MM-DD` | No format enforcement, but lexicographic comparisons gate OpenAI effort variants (`>= "2025-11-13"` etc.) — wrong format silently mis-gates. |
| `attachment` | boolean | false = no images/files. Claiming support the API lacks → upstream errors; omitting → attachments replaced by error text parts. |
| `reasoning` | boolean | Gates ALL reasoning variants; false ⇒ empty variant map. |
| `temperature` | boolean | false = temperature param omitted entirely. |
| `tool_call` | boolean (default **true**) | Tool/function calling. |
| `interleaved` | boolean \| string \| `{field}` | String/`{field:"reasoning_content"}` replays assistant reasoning on multi-turn (DeepSeek-style). |
| `status` | `active` \| `alpha` \| `beta` \| `deprecated` | **deprecated ⇒ model deleted from the provider entirely**; alpha ⇒ deleted unless experimental flag; beta/active shown. |
| `limit` | `{context, input?, output}` | `context: 0` disables overflow checks. `usable = input - reserved` (or `context - maxOutput`). Reaching usable ⇒ auto-compaction (if enabled). `maxOutput = min(output, 32000)`. |
| `cost` | `{input, output, cache_read?, cache_write?, context_over_200k?}` | **Numbers** (Finite), USD per 1M tokens. `input: 0` = free marker. Reasoning billed at output rate. |
| `modalities` | `{input[]?, output[]?}` | Literals **`text` \| `audio` \| `image` \| `video` \| `pdf` only** — anything else fails validation. |
| `options` | record | Deep-merged over catalog; request-time: SDK defaults ← model.options ← agent.options ← variant. |
| `headers` | record | Per-model fetch headers (override provider headers). |
| `variants` | map | Merged over auto-computed reasoning variants; `{disabled: true}` removes. |
| `provider` | `{npm?, api?}` | Per-model SDK/URL override. |

---

## tui.json keys

Schema: `packages/tui/src/config/index.tsx:61-76`; layers global → `OPENCODE_TUI_CONFIG` → project → `.opencode` dirs. **All tui.json changes need a TUI restart.** Legacy `theme`/`keybinds`/`tui` keys in opencode.json auto-migrate here.

| Key | Type | Default | Notes |
|---|---|---|---|
| `theme` | string | `opencode` | 33 bundled + plugin-installed + custom `themes/*.json` in config dirs (walking up). Light/dark = terminal/KV driven (theme_switch_mode pins). `system` = generated from terminal palette. |
| `diff_style` | `auto` \| `stacked` | `auto` | auto = split when width allows, else unified; stacked = always unified. |
| `mouse` | boolean | `true` | false keeps native terminal selection/scrollback. |
| `leader_timeout` | int ms | `2000` | Pending `<leader>` wait. |
| `scroll_speed` | number ≥ 0.001 | `3` | Lines per tick. **Number only** (no string presets). Ignored when acceleration enabled. |
| `scroll_acceleration` | `{enabled}` | `false` | macOS-style momentum; takes precedence over scroll_speed. |
| `cursor` | `{style, blinking}` | `block, true` | style: block/underline/line/default. `default` preserves terminal shape (blinking has no effect). Absent key = untouched. |
| `attention` | struct | `enabled:false, notifications:true, sound:true, volume:0.4, sound_pack:"opencode.default"` | Event keys **exactly six**: default, question, permission, error, done, subagent_done. File paths resolve **relative to the declaring tui.json's directory**. Fallback: sounds[event] → active pack → builtin. |
| `prompt` | `{max_height, max_width}` | height `max(6, term/3)`, width `"auto"` = `max(75, 70% term)` | Number = fixed cap. |
| `keybinds` | map | — | See grammar below. Host loader drops unknown names with warning. |
| `plugin` | array | — | Same spec grammar as opencode.json plugins. |
| `plugin_enabled` | map | — | **Keyed by plugin id (exported `id` or package name), NOT spec.** Runtime toggles persist to KV and override config on startup. |

### Bundled themes (33)

aura, ayu, carbonfox, catppuccin-frappe, catppuccin-macchiato, catppuccin, cobalt2, cursor, dracula, everforest, flexoki, github, gruvbox, kanagawa, lucent-orng, material, matrix, mercury, monokai, nightowl, nord, one-dark, opencode, orng, osaka-jade, palenight, rosepine, solarized, synthwave84, tokyonight, vercel, vesper, zenburn (+ generated `system`).

### Keybind grammar

- Combos: `ctrl+x`, `shift+tab`, `alt+return`, `f1`-`f12`, letters (case-sensitive), `home/end/pageup/pagedown/left/right/up/down`.
- `<leader>` prefix = chord (default leader `ctrl+x`); escape cancels pending, backspace pops.
- **Comma = alternatives** (any triggers), NOT sequences: `"escape,q"`.
- `"none"` or `false` = unbind.
- Objects: `{name, ctrl?, shift?, meta?, super?, hyper?}` key-stroke; `{key, event?, preventDefault?, fallthrough?}` binding.
- Arrays for multiple bindings.
- Windows: `terminal_suspend` forced `none`; `input_undo` gains `ctrl+z`.
- Base-mode bindings suspend inside dialogs (mode stack); only session quick-switch/new/list + dialog keys stay live. Mode-less layers are the global escape hatch.

### Keybind commands (184)

**App**: app_exit (`ctrl+c,ctrl+d,<leader>q`), command_list (`ctrl+p`), app_debug, app_console, app_heap_snapshot, app_toggle_animations, app_toggle_file_context, app_toggle_diffwrap, app_toggle_paste_summary, app_toggle_session_directory_filter, help_show, docs_open.
**Diff viewer**: diff_open, diff_close (`escape,q`), diff_toggle (`enter,space`), diff_expand, diff_expand_all (`E`), diff_collapse, diff_switch_focus, diff_next_hunk (`]`), diff_previous_hunk (`[`), diff_next_file (`n`), diff_previous_file (`p`), diff_toggle_file_tree (`b`), diff_single_patch (`s`), diff_switch_source (`d`), diff_toggle_view (`v`), diff_help (`?`).
**Views**: editor_open (`<leader>e`), theme_list (`<leader>t`), theme_switch_mode, theme_mode_lock, sidebar_toggle (`<leader>b`), scrollbar_toggle, status_view (`<leader>s`), debug_view.
**Sessions**: session_export (`<leader>x`), session_copy, session_move, session_new (`<leader>n`), session_list (`<leader>l`), session_timeline (`<leader>g`), session_fork, session_rename (`ctrl+r`), session_delete (`ctrl+d`), session_share, session_unshare, session_interrupt (`escape`), session_background (`ctrl+b`), session_compact (`<leader>c`), session_toggle_timestamps, session_toggle_generic_tool_output, session_queued_prompts (`<leader>q`), session_child_first (`<leader>down`), session_child_cycle (`right`), session_child_cycle_reverse (`left`), session_parent (`up`), session_pin_toggle (`ctrl+f`), session_quick_switch_1..9 (`<leader>1..9`).
**Models & agents**: model_provider_list (`ctrl+a`), model_favorite_toggle (`ctrl+f`), model_list (`<leader>m`), model_cycle_recent (`f2`), model_cycle_recent_reverse (`shift+f2`), model_cycle_favorite, model_cycle_favorite_reverse, mcp_list, provider_connect, console_org_switch, agent_list (`<leader>a`), agent_cycle (`tab`), agent_cycle_reverse (`shift+tab`), variant_cycle (`ctrl+t`), variant_list, stash_delete (`ctrl+d`).
**Messages**: messages_page_up/down, messages_line_up/down, messages_half_page_up/down, messages_first/last, messages_next/previous/last_user, messages_copy (`<leader>y`), messages_undo (`<leader>u`), messages_redo (`<leader>r`), messages_toggle_conceal (`<leader>h`), tool_details, display_thinking.
**Prompt & input**: prompt_submit, prompt_editor_context_clear, prompt_skills, prompt_stash, prompt_stash_pop, prompt_stash_list, workspace_set, input_clear, input_paste, input_submit, input_newline, input_undo, input_redo, input_select_all, history_previous, history_next (+ full readline set: input_move_*, input_line_home/end, input_visual_line_*, input_buffer_home/end, selection variants, input_delete_line, input_delete_to_line_end/start, input_backspace, input_delete, input_word_forward/backward, input_select_word_*, input_delete_word_forward/backward).
**Dialogs**: dialog.select.prev/next/page_up/page_down/home/end/submit, dialog.prompt.submit, dialog.mcp.toggle, dialog.move_session.new/delete/refresh, dialog.plugins.install, plugins.toggle, prompt.autocomplete.prev/next/hide/select/complete, permission.prompt.fullscreen.
**Terminal & misc**: terminal_suspend (`ctrl+z`), terminal_title_toggle, tips_toggle (`<leader>h`), plugin_manager, plugin_install, leader (`ctrl+x`).
**Which-key**: which_key_toggle (`ctrl+alt+k`), which_key_layout_toggle, which_key_pending_toggle, which_key_group_previous/next, which_key_scroll_up/down, which_key_page_up/down, which_key_home/end.

---

## Mode stack (why keys "die" in dialogs)

A mode stack gates binding layers; `modal` is pushed whenever a dialog is open, suspending base-mode shortcuts. `question` and `autocomplete` modes capture their own keys. Plugins push arbitrary modes via `api.mode.push`. Mode-less layers work everywhere (session quick-switch, dialog keys).
