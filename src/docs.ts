/**
 * Field documentation database powering the [i] info menu.
 *
 * Every doc entry describes one config field or concept: what it means, where
 * OpenCode reads it, how values merge, and what the allowed values are. The
 * TUI injects live values and provenance into these docs at render time.
 */

export interface FieldDoc {
  /** Code citation shown at the end of the help text. */
  source?: string
  id: string
  title: string
  summary: string
  lines: string[]
}

export const FIELD_DOCS: Record<string, FieldDoc> = {
  "root.model": {
    id: "root.model",
    title: "model (root)",
    summary: "The default model in provider/model format.",
    lines: [
      "Sets the session default model. New sessions start on this model unless an agent or the model picker overrides it.",
      "The root default does not retain a variant; agent and command model references can select one.",
      "Changing the default does not rewrite existing sessions - switching models in a session is per-session.",
      "The configured model becomes the catalog default when its provider is available and the model is enabled. Otherwise OpenCode falls back to the newest available supported model.",
    ],
    source: "Source: OpenCode core/src/v1/config/config.ts:74-76; provider/provider.ts:1978-2034",
  },
  "root.small_model": {
    id: "root.small_model",
    title: "small_model",
    summary: "Model used for titles, summaries, and other background work.",
    lines: [
      "Used for session titles, summaries, and other cheap background calls.",
      "Small-model requests never apply the selected variant. They use the FIRST variant body of the model if one exists (see request capture to verify what that sends), plus a few provider tweaks.",
      "When unset, OpenCode picks a small model automatically per provider.",
    ],
    source: "Source: config.ts:77-79; provider.ts:1909-1976",
  },
  "root.default_agent": {
    id: "root.default_agent",
    title: "default_agent",
    summary: "Agent used for new sessions when none is picked.",
    lines: [
      "Names the agent that new sessions start with (default: build).",
    ],
    source: "Source: config.ts:80-83; agent/agent.ts:328-339",
  },
  "root.disabled_providers": {
    id: "root.disabled_providers",
    title: "disabled_providers",
    summary: "Provider IDs to remove from the catalog entirely.",
    lines: [
      "A list of provider IDs. Disabled providers disappear from the model picker and their models cannot be selected.",
    ],
    source: "Source: config.ts:68-73; provider.ts:1418-1422",
  },
  "root.provider": {
    id: "root.provider",
    title: "provider",
    summary: "Provider overlays: options, headers, custom models, and variants.",
    lines: [
      "Keyed by provider ID. Each entry overlays the catalog provider.",
      "Fields: name, env, npm, api, id, options (apiKey, baseURL, timeout, ...), whitelist, blacklist, models.",
      "models is keyed by catalog model ID. Each model entry can override metadata (name, limit, cost, reasoning, ...) and define options and variants.",
      "At request time provider values are inherited by the model, model values override the provider, and the selected variant is applied last.",
    ],
    source: "Source: core/src/v1/config/provider.ts:82-126; provider.ts:1452-1550",
  },
  "root.agent": {
    id: "root.agent",
    title: "agent",
    summary: "Agent definitions and per-agent overrides.",
    lines: [
      "Keyed by agent name. Common fields: model, variant, temperature, top_p, prompt, description, options, mode, hidden, permission, tools, disable.",
      "agent.<name>.variant applies only when the session uses that agent's configured model.",
    ],
    source: "Source: core/src/v1/config/agent.ts:12-41; agent.ts:140-293",
  },
  "root.instructions": {
    id: "root.instructions",
    title: "instructions",
    summary: "Extra system prompt instructions, appended to OpenCode's defaults.",
    lines: [
      "Arrays from multiple config files are concatenated, unlike most other keys which are overridden by the highest-precedence file.",
    ],
    source: "Source: config.ts:124-126 + 45-51; session/instruction.ts",
  },

  "provider.name": {
    id: "provider.name",
    title: "provider.<id>.name",
    summary: "Display name for the provider.",
    lines: ["Shown in pickers and menus instead of the provider ID."],
    source: "Source: provider.ts:1456",
  },
  "provider.env": {
    id: "provider.env",
    title: "provider.<id>.env",
    summary: "Environment variables that provide the provider connection.",
    lines: [
      "The provider counts as connected when at least one of these variables is set (unless options.apiKey replaces the need).",
    ],
    source: "Source: provider.ts:1557-1561",
  },
  "provider.npm": {
    id: "provider.npm",
    title: "provider.<id>.npm",
    summary: "Runtime provider package.",
    lines: [
      "Which AI SDK integration serves this provider, e.g. @ai-sdk/openai-compatible or @ai-sdk/anthropic.",
      "The package decides how option keys are serialized into the request body, and which base defaults apply.",
    ],
    source: "Source: provider.ts:107-134, 1801-1826",
  },
  "provider.options": {
    id: "provider.options",
    title: "provider.<id>.options",
    summary: "Provider-level options passed to the runtime package.",
    lines: [
      "Common keys: apiKey, baseURL, timeout (ms or false), headerTimeout, chunkTimeout, setCacheKey.",
      "provider.options are inherited by every model of the provider; model.options override them per model.",
    ],
    source: "Source: provider.ts:1729-1798; variable.ts:33-91",
  },
  "provider.whitelist": {
    id: "provider.whitelist",
    title: "provider.<id>.whitelist",
    summary: "Keep only the listed model IDs.",
    lines: ["Hides every model of the provider except the listed ones. blacklist then removes entries from that set."],
    source: "Source: provider.ts:1666-1668",
  },
  "provider.blacklist": {
    id: "provider.blacklist",
    title: "provider.<id>.blacklist",
    summary: "Hide the listed model IDs.",
    lines: ["Removes specific models from the picker and catalog for this provider."],
    source: "Source: provider.ts:1665-1666",
  },
  "provider.models": {
    id: "provider.models",
    title: "provider.<id>.models",
    summary: "Model overlays and custom models, keyed by model ID.",
    lines: [
      "For an existing catalog model the entry deep-merges over catalog metadata.",
      "A model ID that is not in the catalog creates a custom model; set modelID-like fields (name, reasoning, tool_call, limit, cost, options, variants) so OpenCode can route it.",
      "Use the canonical lowercase model id as the key - display-name casing creates a separate key that never attaches to the built-in model.",
    ],
    source: "Source: core/src/v1/config/provider.ts:13-80; provider.ts:1463-1547",
  },

  "model.name": {
    id: "model.name",
    title: "models.<id>.name",
    summary: "Display name of the model.",
    lines: ["Shown in the model picker and menus."],
    source: "Source: provider.ts:1475-1479",
  },
  "model.reasoning": {
    id: "model.reasoning",
    title: "models.<id>.reasoning",
    summary: "Whether the model supports reasoning/thinking output.",
    lines: [
      "Controls whether variant derivation and several base defaults (thinking toggles, reasoning summaries) apply.",
    ],
    source: "Source: provider/transform.ts:729-731",
  },
  "model.tool_call": {
    id: "model.tool_call",
    title: "models.<id>.tool_call",
    summary: "Whether the model supports tool calling.",
    lines: ["Agent features that require tools disable themselves when this is false."],
    source: "Source: provider.ts:1494",
  },
  "model.temperature": {
    id: "model.temperature",
    title: "models.<id>.temperature",
    summary: "Whether the model accepts sampling temperature.",
    lines: ["When false, temperature is omitted from requests even if configured."],
    source: "Source: session/request.ts:124-126; transform.ts:528-546",
  },
  "model.limit": {
    id: "model.limit",
    title: "models.<id>.limit",
    summary: "Context and output token limits.",
    lines: [
      "limit.context and limit.output bound the usable window and the max output tokens per request.",
      "Budget-token variants (high/max) are computed from these limits.",
    ],
    source: "Source: session/overflow.ts:10-34; transform.ts:18",
  },
  "model.cost": {
    id: "model.cost",
    title: "models.<id>.cost",
    summary: "Per-token pricing.",
    lines: ["cost.input, cost.output, cost.cache.read, cost.cache.write in dollars per million tokens."],
    source: "Source: core/src/v1/config/provider.ts:31-46; session.ts:386-403",
  },
  "model.options": {
    id: "model.options",
    title: "models.<id>.options",
    summary: "Default request options for this model - what every request sends when no variant overrides the key.",
    lines: [
      "Merged into the request options after provider base defaults and before agent options and the variant body.",
      "This is the 'default' lever: keys set here are sent on every invocation of the model that does not select a variant carrying the same keys.",
      "Use 'Copy from variant' in the Default options editor to materialize a variant body here.",
    ],
    source: "Source: request.ts:80-91; transform.ts:1360-1418",
  },
  "model.variants": {
    id: "model.variants",
    title: "models.<id>.variants",
    summary: "Named request overlays for the model.",
    lines: [
      "Keyed by variant name. Each value is a flat options body merged directly into the request - keys are NOT wrapped in a nested options object.",
      "config variants deep-merge over catalog-derived variants (per key, config wins).",
      "disabled: true removes the variant from the catalog and picker while keeping the config.",
      "Derived variant names come from models.dev metadata (reasoning effort tiers, token budgets, thinking toggles); do not assume low/high/max exist for every model.",
    ],
    source: "Source: provider.ts:1538-1546 + 1675-1682",
  },

  "variant.reasoningEffort": {
    id: "variant.reasoningEffort",
    title: "reasoningEffort",
    summary: "OpenAI-family reasoning effort.",
    lines: [
      "Sent by openai-compatible providers, @ai-sdk/openai, azure, copilot, bedrock/mantle.",
      "Typical values: low, medium, high, xhigh, max - but the exact set is model-specific.",
    ],
  },
  "variant.reasoning": {
    id: "variant.reasoning",
    title: "reasoning",
    summary: "OpenRouter reasoning object.",
    lines: [
      "reasoning.effort selects effort; reasoning.max_tokens sets a token budget.",
    ],
  },
  "variant.thinking": {
    id: "variant.thinking",
    title: "thinking",
    summary: "Anthropic-style thinking control.",
    lines: [
      "thinking.type: adaptive | enabled | disabled; budgetTokens caps the thinking budget.",
      "z.ai/zhipuai openai-compatible endpoints use thinking: {type: enabled, clear_thinking: false} as their base default.",
    ],
  },
  "variant.thinkingConfig": {
    id: "variant.thinkingConfig",
    title: "thinkingConfig",
    summary: "Google Gemini thinking control.",
    lines: [
      "includeThoughts returns thought summaries; thinkingLevel sets effort (low/medium/high); thinkingBudget caps tokens.",
    ],
  },
  "variant.enable_thinking": {
    id: "variant.enable_thinking",
    title: "enable_thinking",
    summary: "DashScope/Alibaba thinking switch.",
    lines: ["Required true on alibaba-cn endpoints for reasoning models to emit reasoning_content at all."],
  },
  "variant.reasoningSummary": {
    id: "variant.reasoningSummary",
    title: "reasoningSummary",
    summary: "OpenAI reasoning summary mode.",
    lines: ["Usually 'auto'; paired with include: [reasoning.encrypted_content] so thinking survives replay."],
  },
  "variant.textVerbosity": {
    id: "variant.textVerbosity",
    title: "textVerbosity",
    summary: "OpenAI answer length control.",
    lines: ["low | medium | high. Chat-style gpt-5 models only accept medium."],
  },
  "variant.store": {
    id: "variant.store",
    title: "store",
    summary: "OpenAI response storage flag.",
    lines: ["OpenCode sets store: false by default on openai-family endpoints."],
  },

  "agent.model": {
    id: "agent.model",
    title: "agent.<name>.model",
    summary: "Model this agent runs on, in provider/model format.",
    lines: [
      "When set, the agent uses this model for its sessions.",
      "Subagents (task tool calls) whose agent sets a model do NOT inherit the parent's selected variant - they use agent.variant or the model default.",
    ],
    source: "Source: core/src/v1/config/agent.ts:15-20; tool/task.ts:179-212",
  },
  "agent.variant": {
    id: "agent.variant",
    title: "agent.<name>.variant",
    summary: "Default model variant for this agent.",
    lines: [
      "Applies only when the session uses this agent's configured model and the variant exists in that model's variant map.",
      "A variant selected in the session (model picker or prompt) overrides the agent default.",
    ],
    source: "Source: tool/task.ts:179-212",
  },
  "agent.temperature": {
    id: "agent.temperature",
    title: "agent.<name>.temperature",
    summary: "Sampling temperature override for the agent.",
    lines: ["Sent only when the model supports temperature."],
    source: "Source: request.ts:80-91",
  },
  "agent.top_p": {
    id: "agent.top_p",
    title: "agent.<name>.top_p",
    summary: "Nucleus sampling override for the agent.",
    lines: ["Sent only when the model supports it."],
    source: "Source: request.ts:80-91",
  },
  "agent.options": {
    id: "agent.options",
    title: "agent.<name>.options",
    summary: "Extra request options for the agent.",
    lines: [
      "Merged after model options and before the variant body.",
      "Good place for provider-specific keys an agent should always send.",
    ],
    source: "Source: request.ts:80-91 (merge: SDK < model < agent < variant)",
  },
  "agent.prompt": {
    id: "agent.prompt",
    title: "agent.<name>.prompt",
    summary: "System prompt for the agent (replaces the built-in one).",
    lines: [
      "Agents can also be defined as markdown files (.opencode/agent/*.md); the config value wins when both exist.",
      "Editing the prompt applies after Save & exit (config reload); no OpenCode restart needed.",
    ],
    source: "Source: agent/agent.ts:281-293; config/agent.ts:11-32",
  },
  "agent.description": {
    id: "agent.description",
    title: "agent.<name>.description",
    summary: "Description shown in the task list and agent pickers.",
    lines: [
      "The main model reads this to decide when to pick the agent - clear descriptions improve selection.",
      "RESTART REQUIRED: OpenCode caches the task list at startup; the new description appears after restart.",
    ],
    source: "Source: agent.ts:274-293",
  },
  "agent.color": {
    id: "agent.color",
    title: "agent.<name>.color",
    summary: "Hex color (#RRGGBB) or theme color for the agent in lists.",
    lines: [
      "Theme colors: primary, secondary, accent, success, warning, error, info.",
      "RESTART REQUIRED: cached UI metadata updates only after restart.",
    ],
    source: "Source: agent.ts:274-293",
  },
  "agent.disable": {
    id: "agent.disable",
    title: "agent.<name>.disable",
    summary: "Fully disables the agent: hidden from task list and selection.",
    lines: [
      "True disable written to opencode.json; removes the agent everywhere (variants included).",
      "Agent Variants parent-patch disable (sidecar) is a softer variant-machinery switch; see the Variants submenu.",
    ],
    source: "Source: agent.ts:268-271",
  },

  "concept.precedence": {
    id: "concept.precedence",
    title: "Config precedence",
    summary: "How OpenCode merges config files, weakest to strongest.",
    lines: [
      "1. Remote .well-known org defaults (not editable here)",
      "2. Global config directory: config.json, then opencode.json, then opencode.jsonc",
      "3. OPENCODE_CONFIG env file",
      "4. Project opencode.json / opencode.jsonc walking up from the session directory - deepest wins",
      "5. .opencode directory configs (global first, then up-tree)",
      "6. OPENCODE_CONFIG_CONTENT env content (not a file)",
      "7. Managed/enterprise config (not editable here)",
      "Plain values: the strongest file wins per key. Objects deep-merge per leaf. instructions arrays concatenate.",
      "OpenCode reads files at startup; after editing, Config Studio triggers a config reload (instance disposal) so changes apply without an app restart.",
    ],
    source: "Source: opencode/src/config/config.ts:398-434",
  },
  "concept.request": {
    id: "concept.request",
    title: "How a request is built",
    summary: "The exact merge order of request options.",
    lines: [
      "Outgoing options = base provider defaults (internal table, per npm package and provider) then model.options then agent.options then the selected variant body.",
      "'Default' (no variant) is not 'send nothing': base defaults already include provider-specific keys like store:false, thinking toggles, or reasoningEffort:medium for gpt-5 models.",
      "Variant bodies merge key-by-key: a variant only overrides the keys it carries.",
      "Small-model requests (titles/summaries) skip the selected variant and use the model's first variant body instead.",
      "Subagents inherit the parent session's selected variant only when the agent does not set its own model.",
      "Use 'Capture real request' for ground truth - it runs the full pipeline against a local sink without contacting any provider.",
    ],
    source: "Source: session/request.ts:80-91",
  },
  "concept.catalog": {
    id: "concept.catalog",
    title: "Where variants come from",
    summary: "Catalog-derived vs config-defined variants.",
    lines: [
      "OpenCode builds provider catalogs from models.dev metadata (models.opencode.ai/api.json), refreshed hourly.",
      "Variant names derive from reasoning metadata: effort tiers (low/medium/high/...), token budgets (high/max), or thinking toggles (none/high).",
      "Your config overlays this: new variant names add entries, matching names deep-merge per key, disabled:true removes.",
      "Config Studio labels each variant: catalog (unchanged), config (file-defined or key-overridden), hidden (disabled), or SDK heuristic (no models.dev metadata).",
    ],
    source: "Source: core/src/models-dev.ts:160-176",
  },
  "concept.capture": {
    id: "concept.capture",
    title: "Request capture",
    summary: "See exactly what would be sent - without sending it.",
    lines: [
      "Capture starts a temporary OpenCode server with an inline config that redirects one provider to a local listener, sends a minimal prompt through the full request pipeline, and records the body the SDK would have posted.",
      "No real provider is contacted and no config files are modified. The temporary session is deleted and the server shut down afterwards.",
      "A/B mode captures two configurations (e.g. default vs a variant) and diffs the bodies.",
      "Auth headers differ (dummy key) but the request body matches what the provider would receive.",
    ],
    source: "Source: Config Studio sink design (local listener + temp server)",
  },
  "concept.hotreload": {
    id: "concept.hotreload",
    title: "Applying changes",
    summary: "What applies when, after a save.",
    lines: [
      "After writing a file Config Studio asks OpenCode to reload config (dispose instances). New provider options, models, variants, and agent model settings then apply to NEW requests.",
      "Running sessions keep their selected model/variant; new sessions and new task calls pick up the new config.",
      "Some host-cached surfaces (e.g. the model picker list inside the current TUI) may only refresh after the disposal completes.",
    ],
    source: "Source: config.ts:281-289 + 600-660",
  },
}

export function docFor(id: string): FieldDoc | undefined {
  return FIELD_DOCS[id]
}

export function allDocIds(): string[] {
  return Object.keys(FIELD_DOCS)
}
