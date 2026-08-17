/**
 * Config Studio module system.
 *
 * The studio is a host: feature modules (agent-variants being the first)
 * contribute menu entries, diagnostics sections, docs, and save hooks. A
 * module lives in src/modules/<id>.ts, registers itself here, and can be
 * enabled/disabled plus configured from the studio Modules screen
 * (settings.jsonc). Disabled modules vanish from every menu.
 */

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { PagedSection } from "./tui.js"
import type { StudioState } from "./tui.js"
import type { StudioSettings } from "./settings.js"
import { moduleEnabled } from "./settings.js"

export type MenuEntry = {
  title: string
  description?: string
  help?: string
  edited?: boolean
  danger?: boolean
}

export type ModuleContext = {
  api: TuiPluginApi
  state: StudioState
  settings: StudioSettings
  /** Reload studio state after direct file writes (rare; modules normally stage). */
  refresh: () => Promise<void>
}

export type ModuleOption = {
  key: string
  title: string
  description: string
  help?: string
}

export type StudioModule = {
  id: string
  title: string
  version: string
  description: string
  defaultEnabled: boolean
  /** Options shown on the Modules screen (stored in settings.modules.options[id]). */
  options?: ModuleOption[]
  /** "own-menu" adds a dedicated main-menu entry instead of spreading entries. */
  ownMenuOption?: ModuleOption
  /** True when the module currently has unsaved (staged) changes. */
  hasPendingChanges: (ctx: ModuleContext) => boolean
  /** Main-menu entry (own-menu layout only). */
  mainMenuEntry?: (ctx: ModuleContext) => MenuEntry & { run: (ctx: ModuleContext) => Promise<void> }
  /** Entries at the top of the Agents screen (integrated layout). */
  agentsScreenEntries?: (ctx: ModuleContext) => Array<MenuEntry & { run: (ctx: ModuleContext) => Promise<void> }>
  /** Per-agent entries in the agent detail view (integrated layout). */
  agentDetailEntries?: (ctx: ModuleContext, agent: string) => Array<MenuEntry & { run: (ctx: ModuleContext) => Promise<void> }>
  /** Sections merged into the Diagnostics screen. */
  diagnosticsSections?: (ctx: ModuleContext) => Promise<PagedSection[]>
  /** Sections merged into How it works. */
  infoSections?: () => PagedSection[]
  /**
   * Human-readable summary of staged changes for the Review screen plus
   * restart reasons collected so far.
   */
  pendingSummary?: (ctx: ModuleContext) => { title: string; lines: string[]; restartReasons: string[] } | undefined
  /** Write module-owned files at Save & exit. */
  save?: (ctx: ModuleContext) => Promise<{ restartReasons: string[] }>
  /** Drop all staged module changes. */
  discard?: () => void
}

const registry: StudioModule[] = []

export function registerModule(module: StudioModule): void {
  if (registry.some((item) => item.id === module.id)) return
  registry.push(module)
}

export function getModules(): StudioModule[] {
  return [...registry]
}

export function enabledModules(settings: StudioSettings): StudioModule[] {
  return registry.filter((module) => moduleEnabled(settings, module.id, module.defaultEnabled))
}

export function moduleUsesOwnMenu(settings: StudioSettings, module: StudioModule): boolean {
  if (!module.ownMenuOption) return false
  const bag = settings.modules.options[module.id]
  return bag?.[module.ownMenuOption.key] === true
}
