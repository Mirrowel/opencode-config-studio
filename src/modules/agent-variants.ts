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
  deleteVariantFor,
  editParentFields,
  editVariantFor,
  generatedAliasSet,
  mainMenu as wizardMainMenu,
  manageModelPresets,
  newWizardSettings,
  toggleEntryFor,
  variantCount,
  wizardInfoText,
  type WizardSettings,
} from "@mirrowel/opencode-agent-variants/wizard"
import { registerModule, type ModuleContext, type StudioModule } from "../modules.js"

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
  return `Variants (${count})`
}

async function variantsSubmenu(ctx: ModuleContext, agent: string): Promise<void> {
  const config = ensureDraft()
  while (true) {
    const entry = config.agents[agent]
    const variants = Object.entries(entry?.variants ?? {})
    const options = [
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
    const picked = await ctxPick(ctx, { title: `${agent} variants`, options })
    if (!picked || picked === "__back__") return
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
// from the wizard entry point and cast once at this boundary.
type AVApi = Parameters<typeof wizardMainMenu>[0]

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
    help: "Off (default): variant and preset management lives on the Agents screens, merged into Config Studio. On: adds a dedicated Agent Variants main-menu entry that opens the full wizard. Diagnostics, docs, review, and save always stay merged.",
  },
  hasPendingChanges: () => sidecarChanged(),
  mainMenuEntry: (ctx) => ({
    title: "Agent Variants",
    description: `${variantCount(ensureDraft())} variant(s), ${sidecarAgents().length} agent(s)`,
    help: "Full Agent Variants wizard: add/edit/delete variants, parent fields, presets, advanced tools. Save & exit stages into the studio queue.",
    run: async (context) => {
      const config = ensureDraft()
      const next = await wizardMainMenu(avApi(context.api), config, settingsOf(), {
        onSave: async (saved, wizardState) => {
          assign(saved)
          wizardSettings = wizardState
          context.api.ui.toast({
            variant: "info",
            title: "Sidecar staged",
            message: "Agent Variants changes queued - finish with Review changes / Save & exit.",
          })
          return "continue"
        },
      })
      assign(next)
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
    return [
      {
        title: variantPickerTitle(agent),
        description: entry && Object.keys(entry.variants).length > 0 ? `${Object.keys(entry.variants).length} variant(s)` : "none yet",
        help: "Agent Variants: variants are full copies of this agent with overridden fields (model, prompt, ...), selectable in the task tool.",
        run: async (context) => {
          await variantsSubmenu(context, agent)
        },
      },
      {
        title: `AV parent fields${parentOverrides > 0 ? ` (${parentOverrides})` : ""}`,
        description: "Propagate model/prompt/params to all variants",
        help: "Agent Variants: parent fields override the agent's config for every variant of this agent, with per-field propagation.",
        run: async (context) => {
          assign(await editParentFields(avApi(context.api), ensureDraft(), agent, settingsOf()))
        },
      },
    ]
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
    return [
      {
        title: "Agent Variants",
        lines: [
          `sidecar: ${defaultSidecarPath()}`,
          `agents configured: ${Object.keys(config.agents).length}`,
          `variants configured: ${variantCount(config)}`,
          `debug mode: ${config.debug ? "enabled" : "disabled"}`,
          `prompt route markers: ${config.routing.prompt_markers ? "enabled" : "disabled"}`,
          `summary: ${errors} error(s), ${warnings} warning(s), ${infos} info`,
          "",
          ...(diagnostics.length === 0 ? ["No diagnostics."] : diagnostics.map((item) => `${item.level.toUpperCase()}: ${item.message}`)),
        ],
      },
    ]
  },
  infoSections: () => [{ title: "Agent Variants", lines: wizardInfoText().split("\n") }],
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
