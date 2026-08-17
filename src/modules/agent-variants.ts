/**
 * Agent Variants module for Config Studio.
 *
 * Embeds the agent-variants wizard library (@mirrowel/opencode-agent-variants)
 * into the studio. Two layouts (switch on the Modules screen):
 *
 * - integrated (default): variant management lives on the Agents screens
 *   (per-agent Variants submenu + Parent fields), model presets on the
 *   Agents screen. No separate Agent Variants menu.
 * - own-menu: one main-menu entry opens the full standalone wizard loop.
 *
 * Either way, saves are staged: wizard flows mutate an in-memory sidecar
 * draft; the studio's unified Save & exit writes it (saveSidecar) together
 * with any staged opencode.json changes. The standalone plugin remains fully
 * functional on its own.
 */

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import {
  defaultSidecarPath,
  diagnoseConfig,
  loadSidecar,
  saveSidecar,
  type SidecarConfig,
} from "@mirrowel/opencode-agent-variants/config"
import {
  addVariantFor,
  agentModes,
  clearDebugLog,
  configBackupsMenu,
  deleteVariantFor,
  editParentFields,
  editVariantFor,
  generatedAliasSet,
  manageModelPresets,
  newWizardSettings,
  pickParentAgent,
  toggleEntryFor,
  variantCount,
  viewDebugLog,
  wizardInfoText,
  type WizardSettings,
} from "@mirrowel/opencode-agent-variants/wizard"
import { registerModule, type ModuleContext, type StudioModule } from "../modules.js"
import { buildMigrationPlan, savableParentFields } from "../migration.js"

/** Parent-patch fields that stay in the sidecar (config hosts the rest). */
const SIDECAR_PARENT_FIELDS = new Set(["prompt_prepend", "prompt_append", "description_prepend", "description_append"])

let draft: SidecarConfig | undefined
let wizardSettings: WizardSettings | undefined

function ensureDraft(): SidecarConfig {
  draft ??= loadSidecar(defaultSidecarPath())
  wizardSettings ??= newWizardSettings(true)
  return draft
}

function settingsOf(): WizardSettings {
  wizardSettings ??= newWizardSettings(true)
  return wizardSettings
}

function assign(next: SidecarConfig): void {
  draft = next
}

function sidecarChanged(): boolean {
  if (!draft) return false
  return JSON.stringify(draft) !== JSON.stringify(loadSidecar(defaultSidecarPath()))
}

/** Agents the sidecar knows (parents with variants or parent overrides). */
function sidecarAgents(): string[] {
  if (!draft) return []
  return Object.keys(draft.agents)
}

function variantPickerTitle(agent: string): string {
  const entry = draft?.agents[agent]
  const count = Object.keys(entry?.variants ?? {}).length
  return `Agent Variants (${count})`
}

async function variantsSubmenu(ctx: ModuleContext, agent: string): Promise<void> {
  const config = ensureDraft()
  while (true) {
    const entry = config.agents[agent]
    const parentDisabled = entry?.disable === true
    const variants = Object.entries(entry?.variants ?? {})
    const options = [
      {
        title: `Full disable: ${parentDisabled ? "currently sidecar-disabled" : "off"} - write to config`,
        value: "__config_disable__",
        description: "agent.<name>.disable = true in opencode.json",
        help: "Writes a full disable to the OpenCode config: the agent (and all its variants) disappear everywhere. RESTART REQUIRED after Save & exit.",
        danger: true,
      },
      {
        title: `Parent patches: ${parentDisabled ? "disabled" : "active"} - toggle sidecar`,
        value: "__parent_toggle__",
        description: parentDisabled ? "no parent patches applied" : "parent patches applied to variants",
        help: "Disables only the sidecar parent patches. NOTE: agent-variants currently also hides the variants when the parent patch entry is disabled (parent-only disable is not implemented yet) - recommended: full disable until it is.",
      },
      {
        title: "Add variant",
        value: "__add__",
        description: "New variant under this agent",
        help: "Creates a new variant of this agent. The new task-list alias appears after an OpenCode restart.",
      },
      ...variants.map(([key, variant]) => {
        const disabled = (variant as { disable?: boolean }).disable === true
        return {
          title: `${disabled ? "x " : ""}${key}`,
          value: key,
          description: [
            typeof variant.model === "string" ? variant.model : undefined,
            typeof variant.name === "string" ? variant.name : undefined,
            disabled ? "disabled" : undefined,
          ].filter(Boolean).join(" - "),
          help: "Edit this variant's fields (model, prompt, temperature, inheritance...).",
        }
      }),
      { title: "< Back", value: "__back__", description: "Return to agent detail" },
    ]
    const picked = await ctxPick(ctx, { title: `${agent} - Agent Variants`, options })
    if (!picked || picked === "__back__") return
    if (picked === "__config_disable__") {
      // Full disable lives in opencode.json: stage through the studio queue.
      const agentEntry = (ctx.state.merge.merged as Record<string, unknown>)["agent"] as Record<string, unknown> | undefined
      const currentlyDisabled = (agentEntry?.[agent] as Record<string, unknown> | undefined)?.["disable"] === true
      const staged = await ctx.stageConfigEdits(
        currentlyDisabled
          ? [{ op: "delete", path: ["agent", agent, "disable"] }]
          : [{ op: "set", path: ["agent", agent, "disable"], value: true }],
        `${currentlyDisabled ? "enable" : "full-disable"} agent ${agent} (config)`,
      )
      if (staged) {
        settingsOf().restartReasons.push(`${agent}: full ${currentlyDisabled ? "enable" : "disable"} (config) requires restart.`)
      }
      continue
    }
    if (picked === "__parent_toggle__") {
      assign(await toggleEntryFor(avApi(ctx.api), config, settingsOf(), { agent }))
      continue
    }
    if (picked === "__add__") {
      assign(await addVariantFor(avApi(ctx.api), config, settingsOf(), agent))
      continue
    }
    assign(await variantActions(ctx, agent, picked))
    if (!config.agents[agent]?.variants[picked]) return
  }
}

async function variantActions(ctx: ModuleContext, agent: string, key: string): Promise<SidecarConfig> {
  const config = ensureDraft()
  const options = [
    { title: "Edit variant", value: "edit", description: "Fields, prompt, inheritance" },
    { title: "Toggle disable", value: "toggle", description: "Hide/show in the task list" },
    { title: "Delete variant", value: "delete", description: "Remove from sidecar", danger: true },
    { title: "< Back", value: "__back__", description: "Return to variants" },
  ]
  const picked = await ctxPick(ctx, { title: `${agent} / ${key}`, options })
  if (!picked || picked === "__back__") return config
  if (picked === "edit") return editVariantFor(avApi(ctx.api), config, settingsOf(), agent, key)
  if (picked === "toggle") return toggleEntryFor(avApi(ctx.api), config, settingsOf(), { agent, variant: key })
  return deleteVariantFor(avApi(ctx.api), config, settingsOf(), agent, key)
}

// The wizard library is compiled inside the agent-variants package, whose
// TuiPluginApi type may come from a different @opencode-ai/plugin copy than
// the studio's (guaranteed identical shape). Derive the exact parameter type
// from a wizard entry point and cast once at this boundary.
type AVApi = Parameters<typeof pickParentAgent>[0]

function avApi(api: TuiPluginApi): AVApi {
  return api as unknown as AVApi
}

// Small indirection so this file does not import UI helpers from tui.tsx
// (tui.tsx imports this module for registration; circularity stays one-way).
type PickOption = { title: string; value: string; description?: string; help?: string; danger?: boolean }
let pickImpl: ((api: TuiPluginApi, props: { title: string; options: PickOption[] }) => Promise<string | undefined>) | undefined

export function setModulePickImplementation(impl: typeof pickImpl): void {
  pickImpl = impl
}

async function ctxPick(ctx: ModuleContext, props: { title: string; options: PickOption[] }): Promise<string | undefined> {
  if (!pickImpl) return undefined
  return pickImpl(ctx.api, props)
}

/** Picker: agents that have variants (for edit/delete flows). */
async function pickAgentWithVariants(ctx: ModuleContext, title: string): Promise<string | undefined> {
  const config = ensureDraft()
  const agents = Object.entries(config.agents).filter(([, entry]) => Object.keys((entry as { variants?: object }).variants ?? {}).length > 0)
  if (agents.length === 0) return undefined
  const picked = await ctxPick(ctx, {
    title,
    options: [
      ...agents.map(([agent, entry]) => ({
        title: agent,
        value: agent,
        description: `${Object.keys((entry as { variants: object }).variants).length} variant(s)`,
      })),
      { title: "< Cancel", value: "__cancel__" },
    ],
  })
  if (!picked || picked === "__cancel__") return undefined
  return picked
}

async function pickVariantOf(ctx: ModuleContext, agent: string, title: string): Promise<string | undefined> {
  const entry = ensureDraft().agents[agent]
  const variants = Object.entries((entry as { variants?: Record<string, { name?: string; model?: string; disable?: boolean }> }).variants ?? {})
  if (variants.length === 0) return undefined
  const picked = await ctxPick(ctx, {
    title,
    options: [
      ...variants.map(([key, variant]) => ({
        title: `${variant.disable === true ? "x " : ""}${key}`,
        value: key,
        description: [typeof variant.model === "string" ? variant.model : undefined, typeof variant.name === "string" ? variant.name : undefined].filter(Boolean).join(" - "),
      })),
      { title: "< Cancel", value: "__cancel__" },
    ],
  })
  if (!picked || picked === "__cancel__") return undefined
  return picked
}

/**
 * Own-menu layout: the variant-management actions in one submenu. Not the
 * full standalone wizard - save/review, diagnostics, info, and advanced tools
 * stay merged in the studio's own screens.
 */
async function ownMenuSubmenu(ctx: ModuleContext): Promise<void> {
  while (true) {
    const config = ensureDraft()
    const action = await ctxPick(ctx, {
      title: "Agent Variants",
      options: [
        { title: "Add variant", value: "add", description: "Create a new agent variant", help: "Creates a new variant under a parent agent. The new task-list alias appears after an OpenCode restart." },
        { title: "Edit variant", value: "edit", description: "Change fields on an existing variant" },
        { title: "Toggle disable", value: "toggle", description: "Enable or disable agents/variants" },
        { title: "Delete variant", value: "delete", description: "Remove a variant", danger: true },
        { title: "Edit parent fields", value: "parent", description: "Override fields on an agent parent" },
        { title: `Model presets (${Object.keys(config.models).length})`, value: "presets", description: "Reusable model shortcuts" },
        { title: "< Back", value: "__back__", description: "Return to Config Studio" },
      ],
    })
    if (!action || action === "__back__") return

    if (action === "add") {
      const agent = await pickParentAgent(avApi(ctx.api), config, settingsOf(), "Add variant - pick parent agent")
      if (agent) assign(await addVariantFor(avApi(ctx.api), ensureDraft(), settingsOf(), agent))
      continue
    }
    if (action === "edit" || action === "delete") {
      const agent = await pickAgentWithVariants(ctx, `Pick agent (${action} variant)`)
      if (!agent) continue
      const key = await pickVariantOf(ctx, agent, `${action} variant of "${agent}"`)
      if (!key) continue
      if (action === "edit") assign(await editVariantFor(avApi(ctx.api), ensureDraft(), settingsOf(), agent, key))
      else assign(await deleteVariantFor(avApi(ctx.api), ensureDraft(), settingsOf(), agent, key))
      continue
    }
    if (action === "toggle") {
      const config2 = ensureDraft()
      const items: Array<{ title: string; value: string }> = []
      for (const [agent, raw] of Object.entries(config2.agents)) {
        const entry = raw as { disable?: boolean; variants?: Record<string, { disable?: boolean }> }
        items.push({ title: `${entry.disable === true ? "x" : "ok"} ${agent} (parent)`, value: `p:${agent}` })
        for (const [key, variant] of Object.entries(entry.variants ?? {})) {
          items.push({ title: `  ${variant.disable === true ? "x" : "ok"} ${agent}-${key}`, value: `v:${agent}:${key}` })
        }
      }
      if (items.length === 0) continue
      const picked = await ctxPick(ctx, {
        title: "Toggle disable",
        options: [...items, { title: "< Cancel", value: "__cancel__" }],
      })
      if (!picked || picked === "__cancel__") continue
      const [kind, agent, key] = picked.split(":")
      void kind
      const target = key !== undefined ? { agent: agent!, variant: key } : { agent: agent! }
      assign(await toggleEntryFor(avApi(ctx.api), config2, settingsOf(), target))
      continue
    }
    if (action === "parent") {
      const agent = await pickParentAgent(avApi(ctx.api), config, settingsOf(), "Edit parent fields - pick agent")
      if (agent) assign(await editParentFields(avApi(ctx.api), ensureDraft(), agent, settingsOf()))
      continue
    }
    if (action === "presets") {
      assign(await manageModelPresets(avApi(ctx.api), ensureDraft()))
      continue
    }
  }
}

/** Interactive migration: stages config ops + sidecar removals together. */
async function runMigration(ctx: ModuleContext, agent: string): Promise<void> {
  const config = ensureDraft()
  const plan = buildMigrationPlan(config, agent)
  if (!plan) {
    await ctxPick(ctx, { title: "Nothing to migrate", options: [{ title: "< Back", value: "__back__" }] })
    return
  }
  const confirmed = await showConfirmViaPick(ctx, {
    title: `Migrate parent fields of "${agent}"?`,
    lines: [
      "These sidecar parent patches move into opencode.json and disappear from the sidecar:",
      ...plan.ops.map((op) => `  - ${op.op === "set" ? "set" : "delete"} ${formatPath(op.path)}`),
      "",
      ...(plan.notes.length > 0 ? ["Notes:", ...plan.notes.map((note) => `  * ${note}`), ""] : []),
      "Both halves are staged; Save & exit writes them together.",
    ],
  })
  if (!confirmed) return
  const staged = await ctx.stageConfigEdits(plan.ops, `migrate AV parent fields of ${agent} to config`)
  if (!staged) return
  const next = structuredClone(ensureDraft())
  const entry = next.agents[agent]
  if (entry) {
    const parent = entry.parent as Record<string, unknown>
    for (const key of plan.sidecarRemovals) delete parent[key]
    if (Object.keys(parent).length === 0) delete next.agents[agent]
  }
  assign(next)
  settingsOf().restartReasons.push(`${agent}: parent field migration changes the sidecar; restart after save.`)
  ctx.api.ui.toast({ variant: "info", title: "Migration staged", message: `${plan.sidecarRemovals.length} field(s) -> config; sidecar cleanup staged. Finish with Save & exit.` })
}

async function showConfirmViaPick(ctx: ModuleContext, props: { title: string; lines: string[] }): Promise<boolean> {
  const picked = await ctxPick(ctx, {
    title: props.title,
    options: [
      { title: "Confirm", value: "__yes__", description: props.lines[0] ?? "" },
      { title: "< Cancel", value: "__no__" },
    ],
  })
  return picked === "__yes__"
}

function formatPath(path: (string | number)[]): string {
  return path
    .map((segment, index) => (typeof segment === "number" ? `[${segment}]` : index === 0 ? String(segment) : `.${segment}`))
    .join("")
}

const agentVariantsModule: StudioModule = {
  id: "agent-variants",
  title: "Agent Variants",
  version: "embedded",
  description: "Model variants of subagents: aliases, routing, presets, inheritance.",
  defaultEnabled: true,
  ownMenuOption: {
    key: "ownMenu",
    title: "Own menu",
    description: "Dedicated Agent Variants entry instead of integrated menus",
    help: "Off (default): variant and preset management lives on the Agents screens, merged into Config Studio. On: adds a dedicated Agent Variants main-menu entry with the variant-management actions in one place. Diagnostics, docs, advanced tools, review, and save always stay merged either way.",
  },
  hasPendingChanges: () => sidecarChanged(),
  mainMenuEntry: (ctx) => ({
    title: "Agent Variants",
    description: `${variantCount(ensureDraft())} variant(s), ${sidecarAgents().length} agent(s)`,
    help: "Variant management in one menu: add/edit/toggle/delete variants, parent fields, presets. Saves stage into the studio queue - use the studio's Save & exit.",
    run: async (context) => {
      await ownMenuSubmenu(context)
    },
  }),
  agentsScreenEntries: (ctx) => {
    const config = ensureDraft()
    void ctx
    return [
      {
        title: `Model presets (${Object.keys(config.models).length})`,
        description: "Reusable model shortcuts",
        help: "Create reusable model presets (light, heavy, ...) that variant and parent fields can reference.",
        run: async (context) => {
          assign(await manageModelPresets(avApi(context.api), ensureDraft()))
        },
      },
    ]
  },
  agentDetailEntries: (ctx, agent) => {
    void ctx
    const config = ensureDraft()
    const entry = config.agents[agent]
    const parentOverrides = Object.keys(entry?.parent ?? {}).length
    const savable = savableParentFields(config, agent)
    const entries = []
    entries.push({
      title: variantPickerTitle(agent),
      description: entry && Object.keys(entry.variants).length > 0 ? `${Object.keys(entry.variants).length} variant(s)` : "none yet",
      help: "Agent Variants: variants are full copies of this agent with overridden fields (model, prompt, ...), selectable in the task tool.",
      run: async (context: ModuleContext) => {
        await variantsSubmenu(context, agent)
      },
    })
    if (savable.length > 0) {
      entries.push({
        title: `Migrate AV parent fields to config (${savable.length})`,
        description: `${savable.join(", ")} - move to opencode.json`,
        help: "Moves config-savable parent patches (model, variant, temperature, top_p, prompt, description, options, color) into opencode.json and removes them from the sidecar. Model preset references resolve to concrete models; template tokens are materialized. Stages both halves - review before Save & exit.",
        run: async (context: ModuleContext) => {
          await runMigration(context, agent)
        },
      })
    }
    entries.push({
      title: `AV parent patches${parentOverrides > 0 ? ` (${parentOverrides})` : ""}`,
      description: "Prepend/append prompt & description patches",
      help: "Agent Variants parent patches that stay sidecar-only: relative prompt/description prepend+append (config cannot express them).",
      run: async (context: ModuleContext) => {
        assign(await editParentFields(avApi(context.api), ensureDraft(), agent, settingsOf(), SIDECAR_PARENT_FIELDS))
      },
    })
    return entries
  },
  diagnosticsSections: async (ctx) => {
    const config = ensureDraft()
    const generatedAliases = generatedAliasSet(config)
    const agents = agentsFromState(avApi(ctx.api)).filter((agent) => !generatedAliases.has(agent))
    const diagnostics = diagnoseConfig(config, {
      agents,
      providers: avApi(ctx.api).state.provider,
      pluginEntries: avApi(ctx.api).state.config.plugin as unknown[] | undefined,
      agentModes: agentModes(avApi(ctx.api)),
    })
    const errors = diagnostics.filter((item) => item.level === "error").length
    const warnings = diagnostics.filter((item) => item.level === "warning").length
    const infos = diagnostics.filter((item) => item.level === "info").length
    const migrateHints: string[] = []
    for (const [agent, entry] of Object.entries(config.agents)) {
      if (entry.disable === true) continue
      const savable = savableParentFields(config, agent)
      if (savable.length > 0) {
        migrateHints.push(`agent "${agent}" keeps ${savable.join(", ")} in the sidecar - consider "Migrate AV parent fields to config" on its agent page (sidecar values shadow config at assembly time).`)
      }
    }
    return [
      {
        title: "AV summary",
        lines: [
          `sidecar: ${defaultSidecarPath()}`,
          `agents configured: ${Object.keys(config.agents).length}`,
          `variants configured: ${variantCount(config)}`,
          `debug mode: ${config.debug ? "enabled" : "disabled"}`,
          `prompt route markers: ${config.routing.prompt_markers ? "enabled" : "disabled"}`,
          `summary: ${errors} error(s), ${warnings} warning(s), ${infos} info`,
        ],
      },
      {
        title: "AV diagnostics",
        lines: diagnostics.length === 0 ? ["No diagnostics."] : diagnostics.map((item) => `${item.level.toUpperCase()}: ${item.message}`),
      },
      ...(migrateHints.length > 0
        ? [
            {
              title: "AV migrate hints",
              lines: migrateHints,
            },
          ]
        : []),
    ]
  },
  infoSections: () => [{ title: "Agent Variants", lines: wizardInfoText().split("\n") }],
  advancedEntries: (ctx) => {
    void ctx
    const config = ensureDraft()
    const settings = settingsOf()
    return [
      {
        title: `AV debug mode: ${config.debug ? "on" : "off"}`,
        description: "Routing/model diagnostic toasts and debug log",
        help: "Toggles the sidecar debug flag. Applies as soon as the studio's Save & exit writes it (the server hot-reads the flag).",
        run: async (context) => {
          const next = structuredClone(ensureDraft())
          next.debug = !next.debug
          assign(next)
          context.api.ui.toast({ variant: "info", title: "Agent Variants", message: `Debug mode ${next.debug ? "enabled" : "disabled"} - staged, applies on Save & exit.` })
        },
      },
      {
        title: `AV prompt route markers: ${config.routing.prompt_markers ? "on" : "off"}`,
        description: config.routing.prompt_markers ? "Legacy prompt-marker correlation active" : "Markerless metadata correlation active",
        danger: config.routing.prompt_markers,
        help: "Default off. Markerless routing matches the child session through OpenCode's task metadata. Enable only as a legacy debug fallback if markerless routing fails.",
        run: async (context) => {
          const next = structuredClone(ensureDraft())
          next.routing.prompt_markers = !next.routing.prompt_markers
          assign(next)
          context.api.ui.toast({ variant: "warning", title: "Agent Variants", message: `Prompt route markers ${next.routing.prompt_markers ? "enabled" : "disabled"} - staged, applies on Save & exit.` })
        },
      },
      {
        title: "AV view debug log",
        description: "Recent agent-variants.debug.log entries",
        help: "Shows the tail of the debug log written while the sidecar debug flag is on.",
        run: async (context) => {
          await viewDebugLog(avApi(context.api))
        },
      },
      {
        title: "AV clear debug log",
        description: "Empty agent-variants.debug.log",
        help: "Clears the debug log file immediately (not staged).",
        run: async (context) => {
          await clearDebugLog(avApi(context.api))
        },
      },
      {
        title: "AV sidecar backups",
        description: "Preview, restore, and snapshot the agent-variants config",
        help: "Browse the sidecar backup journal (reverse patches and full snapshots). Restoring replaces the staged draft.",
        run: async (context) => {
          assign(await configBackupsMenu(avApi(context.api), ensureDraft()))
        },
      },
      {
        title: `AV parent picker filter: ${settings.subagentCapableOnly ? "subagent-capable only" : "all agents"}`,
        description: "Filters the parent pickers in variant flows",
        help: "When on, only agents the task tool can use are offered as variant parents.",
        run: async (context) => {
          settingsOf().subagentCapableOnly = !settingsOf().subagentCapableOnly
          context.api.ui.toast({ variant: "info", title: "Agent Variants", message: `Parent picker now shows ${settingsOf().subagentCapableOnly ? "subagent-capable agents only" : "all agents"}.` })
        },
      },
    ]
  },
  pendingSummary: () => {
    if (!sidecarChanged() || !draft) return undefined
    const disk = loadSidecar(defaultSidecarPath())
    const changedSections: string[] = []
    for (const key of ["agents", "models", "routing", "ui", "debug"] as const) {
      if (JSON.stringify(draft[key]) !== JSON.stringify(disk[key])) changedSections.push(key)
    }
    return {
      title: "Agent Variants sidecar",
      lines: [
        `Changed sections: ${changedSections.join(", ") || "(unknown)"}`,
        `Variants: ${variantCount(draft)} (disk: ${variantCount(disk)})`,
        ...settingsOf().restartReasons.map((reason) => `restart: ${reason}`),
      ],
      restartReasons: [...settingsOf().restartReasons],
    }
  },
  save: async () => {
    if (!draft || !sidecarChanged()) return { restartReasons: [] }
    saveSidecar(draft, defaultSidecarPath())
    const restartReasons = [...new Set(settingsOf().restartReasons)]
    wizardSettings = newWizardSettings(true)
    return { restartReasons }
  },
  discard: () => {
    draft = loadSidecar(defaultSidecarPath())
    wizardSettings = newWizardSettings(true)
  },
}

function agentsFromState(api: { state: { config: { agent?: Record<string, unknown> } } }): string[] {
  const config = api.state.config
  const names = Object.keys(config.agent ?? {})
  for (const builtin of ["build", "plan", "general"]) {
    if (!names.includes(builtin)) names.push(builtin)
  }
  return names
}

registerModule(agentVariantsModule)

export const agentVariantsModuleId = agentVariantsModule.id
