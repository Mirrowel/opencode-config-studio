/**
 * Static metadata for every root-level opencode.json key, tui.json key, and
 * the nested object shapes the studio edits. Pure data + pure helpers - the
 * TUI renders from this, diagnostics scans it, and the cleanup screen builds
 * migration plans from it.
 *
 * Sources: packages/core/src/v1/config/config.ts (ConfigV1.Info) and
 * packages/tui/src/config/index.tsx (TuiConfig.Info), cross-checked against
 * https://opencode.ai/config.json.
 */

export type EffectTiming = "live" | "reload" | "restart"

export type FieldKind =
  | "boolean"
  | "string"
  | "number"
  | "enum"
  | "model"
  | "agent"
  | "stringList"
  | "json"
  | "boolOrJson"
  | "object"
  | "permission"
  | "mcp"
  | "commandMap"
  | "referenceMap"
  | "providerMap"
  | "agentMap"
  | "pluginList"

export interface ObjectFieldSpec {
  key: string
  title: string
  kind: FieldKind
  /** Enum options (kind: enum). */
  options?: string[]
  /** Placeholder shown in prompts. */
  placeholder?: string
  /** Minimum for numbers. */
  min?: number
  /** Effect timing badge. */
  timing?: EffectTiming
  doc: string
  /** Nested fields (kind: object). */
  fields?: ObjectFieldSpec[]
  /** Allow additional free-form keys beyond `fields` (kind: object). */
  allowExtraKeys?: boolean
  /** Label for the extra-keys editor. */
  extraKeysLabel?: string
  default?: unknown
}

export interface RootKeyMeta {
  key: string
  title: string
  group: string
  kind: FieldKind
  options?: string[]
  placeholder?: string
  min?: number
  timing: EffectTiming
  doc: string
  /** Deprecated: human note about the replacement. */
  deprecated?: string
  /** Dead: accepted but has no effect in this file. */
  dead?: boolean
  /** Merges by concatenation across layers instead of last-wins. */
  concat?: boolean
  fields?: ObjectFieldSpec[]
  /** Allow additional free-form keys beyond `fields` (kind: object). */
  allowExtraKeys?: boolean
  /** Label for the extra-keys editor. */
  extraKeysLabel?: string
  default?: unknown
}

// ---------------------------------------------------------------------------
// Root keys
// ---------------------------------------------------------------------------

export const ROOT_KEY_GROUPS = [
  "Models & agents",
  "Sharing & updates",
  "Providers",
  "Tools & files",
  "Session behavior",
  "Server",
  "Developer",
  "Deprecated",
] as const

const RESTART_BADGE = "Requires restart."

export const ROOT_KEYS: RootKeyMeta[] = [
  {
    key: "model",
    title: "Default model",
    group: "Models & agents",
    kind: "model",
    timing: "live",
    doc: "Root default model as provider/model. Applies when an agent has no model of its own.",
  },
  {
    key: "small_model",
    title: "Small model",
    group: "Models & agents",
    kind: "model",
    timing: "live",
    doc: "Cheap model for background work: titles, summaries, compaction.",
  },
  {
    key: "default_agent",
    title: "Default agent",
    group: "Models & agents",
    kind: "agent",
    timing: "reload",
    doc: "Agent used for new sessions. Must be a primary (non-subagent, non-hidden) agent. Falls back to build.",
  },
  {
    key: "subagent_depth",
    title: "Subagent depth",
    group: "Models & agents",
    kind: "number",
    min: 0,
    placeholder: "1",
    timing: "live",
    doc: "Maximum subagent nesting depth (0 disables the task tool entirely, 1 is the default).",
    default: 1,
  },
  {
    key: "share",
    title: "Session sharing",
    group: "Sharing & updates",
    kind: "enum",
    options: ["manual", "auto", "disabled"],
    timing: "live",
    doc: "manual: share on demand. auto: share every new root session in the background. disabled: hide sharing entirely.",
    default: "manual",
  },
  {
    key: "autoupdate",
    title: "Auto-update",
    group: "Sharing & updates",
    kind: "enum",
    options: ["true", "false", "notify"],
    placeholder: "true",
    timing: "live",
    doc: "true: silently install patch updates. notify: only announce them. false: never check.",
    default: true,
  },
  {
    key: "username",
    title: "Username",
    group: "Sharing & updates",
    kind: "string",
    placeholder: "(OS username)",
    timing: "live",
    doc: "Display name for sharing and the server's basic auth. Defaults to your OS username.",
  },
  {
    key: "enterprise",
    title: "Enterprise URL",
    group: "Sharing & updates",
    kind: "object",
    timing: "live",
    doc: "Enterprise share-service endpoint (default https://opncd.ai).",
    fields: [
      { key: "url", title: "URL", kind: "string", doc: "Enterprise share service base URL." },
    ],
  },
  {
    key: "agent",
    title: "Agents",
    group: "Models & agents",
    kind: "agentMap",
    timing: "reload",
    doc: "Per-agent overrides: model, variant, temperature, top_p, prompt, permissions, mode, hidden, steps, options, color. Also edited (with more tooling) from the Agents screen.",
  },
  {
    key: "provider",
    title: "Provider entries",
    group: "Providers",
    kind: "providerMap",
    timing: "reload",
    doc: "Custom providers and catalog overrides: api base, npm SDK package, connection options (baseURL, apiKey, timeouts), model whitelist/blacklist, and full model entries (limits, cost, modalities, status).",
  },
  {
    key: "disabled_providers",
    title: "Disabled providers",
    group: "Providers",
    kind: "stringList",
    timing: "live",
    doc: "Provider ids to hide from the model picker and provider list.",
  },
  {
    key: "enabled_providers",
    title: "Enabled providers (allowlist)",
    group: "Providers",
    kind: "stringList",
    timing: "live",
    doc: "When set, ONLY these providers load. Mutually exclusive with disabled_providers - setting both is a config smell.",
  },
  {
    key: "shell",
    title: "Shell",
    group: "Tools & files",
    kind: "string",
    placeholder: "(auto)",
    timing: "live",
    doc: "Default shell executable for the terminal and the bash tool.",
  },
  {
    key: "instructions",
    title: "Instruction files",
    group: "Tools & files",
    kind: "stringList",
    timing: "reload",
    concat: true,
    doc: "Extra instruction globs/paths/URLs merged into every system prompt. Unlike every other key, entries from all config layers are concatenated (global + project), not replaced. Relative globs match in every ancestor directory.",
  },
  {
    key: "skills",
    title: "Skills",
    group: "Tools & files",
    kind: "object",
    timing: "reload",
    doc: "Extra skill folders and URLs beyond the built-in discovery.",
    fields: [
      { key: "paths", title: "Paths", kind: "stringList", doc: "Local folders containing skills." },
      { key: "urls", title: "URLs", kind: "stringList", doc: "Remote skill registries." },
    ],
  },
  {
    key: "references",
    title: "References",
    group: "Tools & files",
    kind: "referenceMap",
    timing: "reload",
    doc: "Named external context: git repositories or local directories the agent can be pointed at.",
  },
  {
    key: "mcp",
    title: "MCP servers",
    group: "Tools & files",
    kind: "mcp",
    timing: "reload",
    doc: "Model Context Protocol servers (local stdio commands or remote HTTP). Tool names are exposed prefixed with the server name.",
  },
  {
    key: "command",
    title: "Slash commands",
    group: "Tools & files",
    kind: "commandMap",
    timing: "reload",
    doc: "Custom slash commands with a {prompt}-template body; can target a specific agent/model/variant.",
  },
  {
    key: "formatter",
    title: "Formatter",
    group: "Tools & files",
    kind: "boolOrJson",
    timing: "live",
    doc: "true/false to toggle all formatters, or a map of formatter overrides: { disabled, command[], environment, extensions[] }.",
  },
  {
    key: "lsp",
    title: "LSP servers",
    group: "Tools & files",
    kind: "boolOrJson",
    timing: "restart",
    doc: "true/false to toggle all language servers, or per-server overrides: { command[], extensions[], disabled, env, initialization }. Custom (non-builtin) servers MUST declare extensions.",
  },
  {
    key: "watcher",
    title: "File watcher",
    group: "Tools & files",
    kind: "object",
    timing: "reload",
    doc: "Edit-snapshot watcher configuration.",
    fields: [
      { key: "ignore", title: "Ignore globs", kind: "stringList", doc: "Globs excluded from edit tracking." },
    ],
  },
  {
    key: "attachment",
    title: "Image attachments",
    group: "Session behavior",
    kind: "object",
    timing: "live",
    doc: "Image attachment processing limits.",
    fields: [
      {
        key: "image",
        title: "Image",
        kind: "object",
        doc: "Image resize / size limits.",
        fields: [
          { key: "auto_resize", title: "Auto resize", kind: "boolean", doc: "Resize large images before sending (default true).", default: true },
          { key: "max_width", title: "Max width", kind: "number", min: 1, placeholder: "2000", doc: "Resize target width in pixels.", default: 2000 },
          { key: "max_height", title: "Max height", kind: "number", min: 1, placeholder: "2000", doc: "Resize target height in pixels.", default: 2000 },
          { key: "max_base64_bytes", title: "Max base64 bytes", kind: "number", min: 1, placeholder: "5242880", doc: "Reject images larger than this many base64 bytes (5 MiB default).", default: 5242880 },
        ],
      },
    ],
  },
  {
    key: "tool_output",
    title: "Tool output limits",
    group: "Session behavior",
    kind: "object",
    timing: "live",
    doc: "Truncation thresholds for tool outputs shown to the model.",
    fields: [
      { key: "max_lines", title: "Max lines", kind: "number", min: 1, placeholder: "2000", doc: "Truncate tool outputs longer than this (default 2000).", default: 2000 },
      { key: "max_bytes", title: "Max bytes", kind: "number", min: 1, placeholder: "51200", doc: "Truncate tool outputs beyond this size (default 51200).", default: 51200 },
    ],
  },
  {
    key: "compaction",
    title: "Compaction",
    group: "Session behavior",
    kind: "object",
    timing: "live",
    doc: "Automatic context compaction behavior.",
    fields: [
      { key: "auto", title: "Auto compaction", kind: "boolean", doc: "Compact automatically when context overflows (default true). Env OPENCODE_DISABLE_AUTOCOMPACT overrides.", default: true },
      { key: "prune", title: "Prune", kind: "boolean", doc: "Drop old tool outputs instead of summarizing (default false). Env OPENCODE_DISABLE_PRUNE overrides.", default: false },
      { key: "tail_turns", title: "Tail turns", kind: "number", min: 0, placeholder: "(off)", doc: "Keep this many trailing turns verbatim during compaction." },
      { key: "preserve_recent_tokens", title: "Preserve recent tokens", kind: "number", min: 0, placeholder: "(off)", doc: "Token budget kept for recent turns during compaction." },
      { key: "reserved", title: "Reserved tokens", kind: "number", min: 0, placeholder: "(off)", doc: "Tokens reserved as headroom when auto-compaction triggers." },
    ],
  },
  {
    key: "snapshot",
    title: "Snapshots",
    group: "Session behavior",
    kind: "enum",
    options: ["true", "false"],
    placeholder: "true",
    timing: "live",
    doc: "Track file snapshots for undo/revert (default true).",
    default: true,
  },
  {
    key: "permission",
    title: "Permissions",
    group: "Tools & files",
    kind: "permission",
    timing: "reload",
    doc: "Per-tool permission rules (ask/allow/deny with wildcard patterns). Root rules apply everywhere; agent-level rules override them.",
  },
  {
    key: "server",
    title: "Server",
    group: "Server",
    kind: "object",
    timing: "restart",
    doc: "opencode serve / web host settings. " + RESTART_BADGE,
    fields: [
      { key: "port", title: "Port", kind: "number", min: 1, placeholder: "(random)", doc: "TCP port for opencode serve." },
      { key: "hostname", title: "Hostname", kind: "string", placeholder: "(all interfaces)", doc: "Bind hostname for the server." },
      { key: "mdns", title: "mDNS advertise", kind: "boolean", doc: "Advertise the server over local network mDNS." },
      { key: "mdnsDomain", title: "mDNS domain", kind: "string", placeholder: "opencode.local", doc: "mDNS hostname advertised.", default: "opencode.local" },
      { key: "cors", title: "CORS origins", kind: "stringList", doc: "Allowed CORS origin patterns for the HTTP API." },
    ],
  },
  {
    key: "plugin",
    title: "Plugins",
    group: "Developer",
    kind: "pluginList",
    timing: "restart",
    doc: "External plugin packages (npm specs or file:// paths). " + RESTART_BADGE,
  },
  {
    key: "experimental",
    title: "Experimental flags",
    group: "Developer",
    kind: "object",
    timing: "live",
    doc: "Feature flags - these can change or disappear between releases.",
    fields: [
      { key: "disable_paste_summary", title: "Disable paste summary", kind: "boolean", doc: "Default the paste-summary toggle to off in the TUI." },
      { key: "openTelemetry", title: "OpenTelemetry", kind: "boolean", doc: "Emit OTel spans for AI SDK calls." },
      { key: "primary_tools", title: "Primary-only tools", kind: "stringList", doc: "Tools restricted to primary (non-subagent) agents in the task tool." },
      { key: "continue_loop_on_deny", title: "Continue loop on deny", kind: "boolean", doc: "Agent loop continues after a denied tool call (default: stop)." },
      { key: "mcp_timeout", title: "MCP timeout (ms)", kind: "number", min: 1, placeholder: "(per-server default)", doc: "Fallback request timeout for MCP tool calls; per-server timeout wins." },
    ],
    allowExtraKeys: true,
    extraKeysLabel: "Other flags",
  },
  // --- deprecated ---
  {
    key: "autoshare",
    title: "Autoshare",
    group: "Deprecated",
    kind: "enum",
    options: ["true", "false"],
    timing: "live",
    deprecated: "Use share: \"auto\" instead. autoshare: true is rewritten to share: \"auto\" at load.",
    doc: "Legacy sharing switch.",
  },
  {
    key: "reference",
    title: "Reference (legacy)",
    group: "Deprecated",
    kind: "referenceMap",
    timing: "reload",
    deprecated: "Use references instead. reference is only read when references is absent.",
    doc: "Legacy alias of references.",
  },
  {
    key: "mode",
    title: "Mode agents (legacy)",
    group: "Deprecated",
    kind: "json",
    timing: "reload",
    deprecated: "Use agent instead. mode entries become agent entries with mode: \"primary\" at load.",
    doc: "Legacy per-mode agent overrides.",
  },
  {
    key: "tools",
    title: "Tools toggles (legacy)",
    group: "Deprecated",
    kind: "json",
    timing: "reload",
    deprecated: "Use permission instead. { tool: bool } maps to permission rules; real permission wins on conflict.",
    doc: "Legacy per-tool on/off switches.",
  },
  {
    key: "layout",
    title: "Layout",
    group: "Deprecated",
    kind: "enum",
    options: ["auto", "stretch"],
    timing: "restart",
    dead: true,
    deprecated: "Dead key - layout is always stretch. Safe to delete.",
    doc: "Legacy layout selector.",
  },
  {
    key: "logLevel",
    title: "Log level",
    group: "Deprecated",
    kind: "enum",
    options: ["DEBUG", "INFO", "WARN", "ERROR"],
    timing: "restart",
    dead: true,
    deprecated: "Dead in config files - the runtime level comes from OPENCODE_LOG_LEVEL or --log-level. Safe to delete.",
    doc: "Legacy log-level selector.",
  },
]

/** Keys that live in tui.json, not opencode.json. */
export const TUI_ONLY_KEYS = ["theme", "keybinds", "tui"] as const

export function rootKey(key: string): RootKeyMeta | undefined {
  return ROOT_KEYS.find((meta) => meta.key === key)
}

// ---------------------------------------------------------------------------
// tui.json keys
// ---------------------------------------------------------------------------

export interface TuiKeyMeta {
  key: string
  title: string
  kind: FieldKind
  options?: string[]
  placeholder?: string
  min?: number
  doc: string
  fields?: ObjectFieldSpec[]
  /** Allow additional free-form keys beyond `fields` (kind: object). */
  allowExtraKeys?: boolean
  /** Label for the extra-keys editor. */
  extraKeysLabel?: string
  default?: unknown
}

export const BUNDLED_THEMES = [
  "aura", "ayu", "carbonfox", "catppuccin-frappe", "catppuccin-latte", "catppuccin-mocha",
  "cobalt2", "cursor", "dracula", "everforest", "flexoki", "github", "gruvbox", "kanagawa",
  "lucent-orng", "material", "matrix", "mercury", "monokai", "nightowl", "nord", "one-dark",
  "opencode", "orng", "osaka-jade", "palenight", "rosepine", "solarized", "synthwave84",
  "tokyonight", "vercel", "vesper", "zenburn",
]

export const TUI_KEYS: TuiKeyMeta[] = [
  {
    key: "theme",
    title: "Theme",
    kind: "enum",
    options: BUNDLED_THEMES,
    placeholder: "opencode",
    doc: "Theme name (33 bundled + any custom theme discovered at runtime). Light/dark mode is terminal/kv-driven, not set here.",
    default: "opencode",
  },
  {
    key: "diff_style",
    title: "Diff style",
    kind: "enum",
    options: ["auto", "stacked"],
    placeholder: "auto",
    doc: "How diffs render in the diff viewer.",
    default: "auto",
  },
  {
    key: "mouse",
    title: "Mouse",
    kind: "enum",
    options: ["true", "false"],
    placeholder: "true",
    doc: "Mouse support (scroll, click).",
    default: true,
  },
  {
    key: "leader_timeout",
    title: "Leader timeout (ms)",
    kind: "number",
    min: 1,
    placeholder: "2000",
    doc: "How long the leader key (<ctrl+x> default) waits for the next key.",
    default: 2000,
  },
  {
    key: "scroll_speed",
    title: "Scroll speed",
    kind: "string",
    placeholder: "(built-in)",
    doc: "Scroll lines per wheel event (number >= 0.001, or a string preset).",
  },
  {
    key: "scroll_acceleration",
    title: "Scroll acceleration",
    kind: "object",
    doc: "Accelerate scrolling during continuous wheel events.",
    fields: [{ key: "enabled", title: "Enabled", kind: "boolean", doc: "Enable scroll acceleration." }],
  },
  {
    key: "cursor",
    title: "Cursor",
    kind: "object",
    doc: "Terminal cursor appearance.",
    fields: [
      { key: "style", title: "Style", kind: "enum", options: ["block", "underline", "line", "default"], placeholder: "block", doc: "Cursor shape.", default: "block" },
      { key: "blinking", title: "Blinking", kind: "boolean", doc: "Blink the cursor.", default: true },
    ],
  },
  {
    key: "attention",
    title: "Attention",
    kind: "object",
    doc: "Notifications and sound when the agent finishes or needs input.",
    fields: [
      { key: "enabled", title: "Enabled", kind: "boolean", doc: "Master switch (default false).", default: false },
      { key: "notifications", title: "Notifications", kind: "boolean", doc: "OS notifications.", default: true },
      { key: "sound", title: "Sound", kind: "boolean", doc: "Play sounds.", default: true },
      { key: "volume", title: "Volume", kind: "string", placeholder: "0.4", doc: "0.0 - 1.0.", default: 0.4 },
      { key: "sound_pack", title: "Sound pack", kind: "string", placeholder: "opencode.default", doc: "Named sound pack.", default: "opencode.default" },
      {
        key: "sounds",
        title: "Custom sounds",
        kind: "object",
        doc: "Per-event sound file paths (relative to the config file).",
        allowExtraKeys: true,
        extraKeysLabel: "Event sounds",
        fields: [
          { key: "default", title: "default", kind: "string", doc: "Fallback sound path." },
          { key: "question", title: "question", kind: "string", doc: "Sound when input is needed." },
          { key: "permission", title: "permission", kind: "string", doc: "Sound for permission prompts." },
          { key: "error", title: "error", kind: "string", doc: "Sound on errors." },
          { key: "done", title: "done", kind: "string", doc: "Sound when a run finishes." },
          { key: "subagent_done", title: "subagent_done", kind: "string", doc: "Sound when a subagent finishes." },
        ],
      },
    ],
  },
  {
    key: "prompt",
    title: "Prompt box",
    kind: "object",
    doc: "Prompt input sizing.",
    fields: [
      { key: "max_height", title: "Max height", kind: "number", min: 1, placeholder: "(auto)", doc: "Maximum prompt box height in rows." },
      { key: "max_width", title: "Max width", kind: "string", placeholder: "auto", doc: "Maximum width in columns, or \"auto\".", default: "auto" },
    ],
  },
  {
    key: "keybinds",
    title: "Keybinds",
    kind: "json",
    doc: "Key binding overrides for 184 named commands. Bindings are combo strings (\"ctrl+x,ctrl+d\"), \"none\"/false to unbind, or key-stroke objects. Unknown names are dropped. See the Keybinds browser.",
  },
  {
    key: "plugin_enabled",
    title: "Plugin enable toggles",
    kind: "json",
    doc: "Map of plugin spec/name to enabled boolean. Seeds the runtime enable/disable map (kv overrides on startup).",
  },
]

// ---------------------------------------------------------------------------
// Keybind command catalog (tui keybind.ts names)
// ---------------------------------------------------------------------------

export const KEYBIND_GROUPS: Record<string, string[]> = {
  "App": ["app_exit", "app_debug", "app_console", "app_heap_snapshot", "app_toggle_animations", "app_toggle_file_context", "app_toggle_diffwrap", "app_toggle_paste_summary", "app_toggle_session_directory_filter", "command_list", "help_show", "docs_open"],
  "Diff viewer": ["diff_open", "diff_close", "diff_toggle", "diff_expand", "diff_expand_all", "diff_collapse", "diff_switch_focus", "diff_next_hunk", "diff_previous_hunk", "diff_next_file", "diff_previous_file", "diff_toggle_file_tree", "diff_single_patch", "diff_switch_source", "diff_toggle_view", "diff_help"],
  "Editor & layout": ["editor_open", "theme_list", "theme_switch_mode", "theme_mode_lock", "sidebar_toggle", "scrollbar_toggle", "status_view", "debug_view"],
  "Sessions": ["session_export", "session_copy", "session_move", "session_new", "session_list", "session_timeline", "session_fork", "session_rename", "session_delete", "session_share", "session_unshare", "session_interrupt", "session_background", "session_compact", "session_toggle_timestamps", "session_toggle_generic_tool_output", "session_queued_prompts", "session_child_first", "session_child_cycle", "session_child_cycle_reverse", "session_parent", "session_pin_toggle", "session_quick_switch_1", "session_quick_switch_2", "session_quick_switch_3", "session_quick_switch_4", "session_quick_switch_5", "session_quick_switch_6", "session_quick_switch_7", "session_quick_switch_8", "session_quick_switch_9"],
  "Models & agents": ["model_provider_list", "model_favorite_toggle", "model_list", "model_cycle_recent", "model_cycle_recent_reverse", "model_cycle_favorite", "model_cycle_favorite_reverse", "mcp_list", "provider_connect", "console_org_switch", "agent_list", "agent_cycle", "agent_cycle_reverse", "variant_cycle", "variant_list", "stash_delete"],
  "Messages": ["messages_page_up", "messages_page_down", "messages_line_up", "messages_line_down", "messages_half_page_up", "messages_half_page_down", "messages_first", "messages_last", "messages_next", "messages_previous", "messages_last_user", "messages_copy", "messages_undo", "messages_redo", "messages_toggle_conceal", "tool_details", "display_thinking"],
  "Prompt & input": ["prompt_submit", "prompt_editor_context_clear", "prompt_skills", "prompt_stash", "prompt_stash_pop", "prompt_stash_list", "workspace_set", "input_clear", "input_paste", "input_submit", "input_newline", "input_undo", "input_redo", "input_select_all", "history_previous", "history_next"],
  "Dialogs": ["dialog.select.prev", "dialog.select.next", "dialog.select.page_up", "dialog.select.page_down", "dialog.select.home", "dialog.select.end", "dialog.select.submit", "dialog.prompt.submit", "dialog.mcp.toggle", "dialog.move_session.new", "dialog.move_session.delete", "dialog.move_session.refresh", "dialog.plugins.install", "plugins.toggle", "prompt.autocomplete.prev", "prompt.autocomplete.next", "prompt.autocomplete.hide", "prompt.autocomplete.select", "prompt.autocomplete.complete", "permission.prompt.fullscreen"],
  "Terminal & misc": ["terminal_suspend", "terminal_title_toggle", "tips_toggle", "plugin_manager", "plugin_install", "leader"],
  "Which-key": ["which_key_toggle", "which_key_layout_toggle", "which_key_pending_toggle", "which_key_group_previous", "which_key_group_next", "which_key_scroll_up", "which_key_scroll_down", "which_key_page_up", "which_key_page_down", "which_key_home", "which_key_end"],
}

export const ALL_KEYBIND_NAMES = Object.values(KEYBIND_GROUPS).flat()

// ---------------------------------------------------------------------------
// Provider + model schemas (full provider-array support)
// ---------------------------------------------------------------------------

export const PROVIDER_OPTIONS_FIELDS: ObjectFieldSpec[] = [
  { key: "apiKey", title: "API key", kind: "string", placeholder: "(env var if empty)", doc: "Static API key. Prefer env vars via the provider env list; this embeds the key in the config file." },
  { key: "baseURL", title: "Base URL", kind: "string", placeholder: "https://...", doc: "API endpoint base URL (overrides the SDK default)." },
  { key: "enterpriseUrl", title: "Enterprise URL", kind: "string", placeholder: "https://...", doc: "Enterprise gateway endpoint." },
  { key: "setCacheKey", title: "Cache key", kind: "string", doc: "Prompt-cache key override." },
  { key: "timeout", title: "Timeout (ms)", kind: "number", min: 1, placeholder: "(SDK default)", doc: "Overall request timeout. false disables." },
  { key: "headerTimeout", title: "Header timeout (ms)", kind: "number", min: 1, placeholder: "(SDK default)", doc: "Response-header timeout. false disables." },
  { key: "chunkTimeout", title: "Chunk timeout (ms)", kind: "number", min: 1, placeholder: "(SDK default)", doc: "Inter-chunk timeout for streams. false disables." },
]

export const PROVIDER_FIELDS: ObjectFieldSpec[] = [
  { key: "name", title: "Display name", kind: "string", doc: "Human-readable provider name shown in pickers." },
  { key: "api", title: "API base", kind: "string", placeholder: "e.g. openai-compatible", doc: "API family the provider speaks - selects the SDK integration (e.g. openai-compatible, anthropic)." },
  { key: "npm", title: "SDK package", kind: "string", placeholder: "e.g. @ai-sdk/openai-compatible", doc: "npm package implementing the API. Required for api bases that are not built in." },
  { key: "id", title: "Provider id", kind: "string", doc: "Explicit provider id override (defaults to the config key)." },
  { key: "env", title: "API key env vars", kind: "stringList", doc: "Environment variable names probed for the API key, in order." },
  { key: "whitelist", title: "Model whitelist", kind: "stringList", doc: "Only expose these model ids from the catalog for this provider." },
  { key: "blacklist", title: "Model blacklist", kind: "stringList", doc: "Hide these model ids for this provider." },
  { key: "options", title: "Connection options", kind: "object", doc: "SDK connection options (apiKey, baseURL, timeouts, ...).", fields: PROVIDER_OPTIONS_FIELDS, allowExtraKeys: true, extraKeysLabel: "Other options" },
  { key: "models", title: "Models", kind: "providerMap", doc: "Model entries: full custom models and overrides of catalog models." },
]

export const MODEL_STATUS_OPTIONS = ["active", "alpha", "beta", "deprecated"]

export const MODEL_FIELDS: ObjectFieldSpec[] = [
  { key: "name", title: "Display name", kind: "string", doc: "Model name shown in pickers." },
  { key: "id", title: "Model id", kind: "string", doc: "Explicit model id override (defaults to the config key)." },
  { key: "family", title: "Family", kind: "string", doc: "Model family id (e.g. glm, gpt)." },
  { key: "release_date", title: "Release date", kind: "string", placeholder: "YYYY-MM-DD", doc: "Release date for sort/upgrade decisions." },
  { key: "attachment", title: "Attachments", kind: "enum", options: ["true", "false"], placeholder: "(family default)", doc: "Whether the model accepts images/files." },
  { key: "reasoning", title: "Reasoning", kind: "enum", options: ["true", "false"], placeholder: "(family default)", doc: "Whether the model supports reasoning/thinking." },
  { key: "temperature", title: "Temperature", kind: "enum", options: ["true", "false"], placeholder: "(family default)", doc: "Whether the model accepts a temperature parameter." },
  { key: "tool_call", title: "Tool calls", kind: "enum", options: ["true", "false"], placeholder: "(family default)", doc: "Whether the model supports tool calling." },
  { key: "interleaved", title: "Interleaved thinking", kind: "enum", options: ["true", "false"], placeholder: "(family default)", doc: "Whether thinking can be interleaved between tool calls." },
  { key: "status", title: "Status", kind: "enum", options: MODEL_STATUS_OPTIONS, placeholder: "active", doc: "Lifecycle status.", default: "active" },
  {
    key: "limit",
    title: "Limits",
    kind: "object",
    doc: "Context/output token limits.",
    fields: [
      { key: "context", title: "Context", kind: "number", min: 1, placeholder: "(unknown)", doc: "Total context window tokens." },
      { key: "input", title: "Input", kind: "number", min: 1, placeholder: "(= context)", doc: "Maximum input tokens." },
      { key: "output", title: "Output", kind: "number", min: 1, placeholder: "(unknown)", doc: "Maximum output tokens." },
    ],
  },
  {
    key: "cost",
    title: "Cost (USD / Mtok)",
    kind: "object",
    doc: "Pricing per million tokens; used to estimate session cost.",
    fields: [
      { key: "input", title: "Input", kind: "string", placeholder: "e.g. 0.5", doc: "Input cost." },
      { key: "output", title: "Output", kind: "string", placeholder: "e.g. 2", doc: "Output cost." },
      { key: "cache_read", title: "Cache read", kind: "string", placeholder: "(free)", doc: "Cached-prompt read cost." },
      { key: "cache_write", title: "Cache write", kind: "string", placeholder: "(free)", doc: "Prompt-cache write cost." },
      {
        key: "context_over_200k",
        title: "Over 200k rates",
        kind: "object",
        doc: "Differential rates applied above 200k context (long-context pricing).",
        fields: [
          { key: "input", title: "Input", kind: "string", placeholder: "(same)", doc: "Input cost above 200k." },
          { key: "output", title: "Output", kind: "string", placeholder: "(same)", doc: "Output cost above 200k." },
          { key: "cache_read", title: "Cache read", kind: "string", placeholder: "(same)", doc: "Cache-read cost above 200k." },
          { key: "cache_write", title: "Cache write", kind: "string", placeholder: "(same)", doc: "Cache-write cost above 200k." },
        ],
      },
    ],
  },
  {
    key: "modalities",
    title: "Modalities",
    kind: "object",
    doc: "Accepted and produced modalities.",
    fields: [
      { key: "input", title: "Input", kind: "stringList", doc: "e.g. text, image, audio." },
      { key: "output", title: "Output", kind: "stringList", doc: "e.g. text, image." },
    ],
  },
  { key: "options", title: "Default request options", kind: "json", doc: "Options merged into every request for this model when no variant overrides them (the model default-options editor)." },
  { key: "headers", title: "Extra headers", kind: "json", doc: "HTTP headers sent with every request for this model." },
  {
    key: "provider",
    title: "Per-model provider",
    kind: "object",
    doc: "Provider override for a single model (custom API/npm wiring).",
    fields: [
      { key: "npm", title: "SDK package", kind: "string", doc: "npm package implementing the API." },
      { key: "api", title: "API base", kind: "string", doc: "API family selector." },
    ],
  },
  { key: "variants", title: "Variants", kind: "json", doc: "Named parameter presets selected via provider/model#variant. Managed from the model detail view." },
]

// ---------------------------------------------------------------------------
// MCP entry schemas
// ---------------------------------------------------------------------------

export const MCP_LOCAL_FIELDS: ObjectFieldSpec[] = [
  { key: "command", title: "Command", kind: "stringList", doc: "Executable plus arguments, one array element per token (e.g. [\"npx\", \"-y\", \"server\"]). Required for local servers." },
  { key: "cwd", title: "Working directory", kind: "string", doc: "Spawn cwd (resolved against the workspace)." },
  { key: "environment", title: "Environment", kind: "json", doc: "Extra env vars merged over process.env ({ \"KEY\": \"value\" })." },
  { key: "enabled", title: "Enabled", kind: "enum", options: ["true", "false"], placeholder: "true", doc: "Disabled servers stay configured but never connect.", default: true },
  { key: "timeout", title: "Timeout (ms)", kind: "number", min: 1, placeholder: "(experimental default)", doc: "Connect + request timeout for this server." },
]

export const MCP_REMOTE_FIELDS: ObjectFieldSpec[] = [
  { key: "url", title: "URL", kind: "string", placeholder: "https://...", doc: "Streamable HTTP / SSE endpoint. Required for remote servers." },
  { key: "headers", title: "Headers", kind: "json", doc: "HTTP headers ({ \"Authorization\": \"...\" })." },
  { key: "oauth", title: "OAuth", kind: "json", doc: "OAuth credentials object, or false to disable OAuth auto-detection." },
  { key: "enabled", title: "Enabled", kind: "enum", options: ["true", "false"], placeholder: "true", doc: "Disabled servers stay configured but never connect.", default: true },
  { key: "timeout", title: "Timeout (ms)", kind: "number", min: 1, placeholder: "(experimental default)", doc: "Connect + request timeout for this server." },
]

// ---------------------------------------------------------------------------
// Cleanup catalog: deprecated keys -> migration plans
// ---------------------------------------------------------------------------

export interface CleanupRule {
  /** Root key or "agent.<field>". */
  target: string
  title: string
  detail: string
}

export const CLEANUP_RULES: CleanupRule[] = [
  { target: "mode", title: "mode -> agent", detail: "Each mode entry becomes an agent entry with mode: \"primary\"." },
  { target: "tools", title: "tools -> permission", detail: "{ tool: bool } becomes permission { tool: allow|deny } (write/edit/patch fold into edit)." },
  { target: "autoshare", title: "autoshare -> share", detail: "autoshare: true becomes share: \"auto\"." },
  { target: "reference", title: "reference -> references", detail: "Moves the map to the references key (only read when references is absent)." },
  { target: "layout", title: "layout (dead)", detail: "Layout is always stretch - the key does nothing. Removes it." },
  { target: "logLevel", title: "logLevel (dead in files)", detail: "Runtime level comes from OPENCODE_LOG_LEVEL / --log-level. Removes the key." },
  { target: "agent.tools", title: "agent.<name>.tools -> permission", detail: "Per-agent tool toggles become agent permission rules." },
  { target: "agent.maxSteps", title: "agent.<name>.maxSteps -> steps", detail: "Renames the deprecated field to steps." },
]

/** Known permission tool keys (v1 schema) + note that any tool id is valid. */
export const PERMISSION_TOOL_KEYS = [
  "read", "edit", "glob", "grep", "list", "bash", "task",
  "external_directory", "todowrite", "question", "webfetch",
  "websearch", "lsp", "doom_loop", "skill",
] as const

export const PERMISSION_ACTIONS = ["ask", "allow", "deny"] as const

/** Permission keys restricted to plain actions (no pattern maps). */
export const PERMISSION_PLAIN_ONLY = ["todowrite", "question", "webfetch", "websearch", "doom_loop"] as const

export function isPlainOnlyPermissionKey(key: string): boolean {
  return (PERMISSION_PLAIN_ONLY as readonly string[]).includes(key)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Converts a legacy tools map to permission rules (mirrors OpenCode's load-time conversion). */
export function toolsToPermission(tools: Record<string, unknown>): Record<string, string> {
  const rules: Record<string, string> = {}
  for (const [tool, enabled] of Object.entries(tools)) {
    const key = tool === "write" || tool === "edit" || tool === "patch" ? "edit" : tool
    rules[key] = enabled ? "allow" : "deny"
  }
  return rules
}

export function keybindGroupsMatching(query: string): Array<{ group: string; names: string[] }> {
  const q = query.trim().toLowerCase()
  if (!q) return Object.entries(KEYBIND_GROUPS).map(([group, names]) => ({ group, names }))
  return Object.entries(KEYBIND_GROUPS)
    .map(([group, names]) => ({ group, names: names.filter((name) => name.includes(q) || group.toLowerCase().includes(q)) }))
    .filter((entry) => entry.names.length > 0)
}
