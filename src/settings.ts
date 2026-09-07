/**
 * Studio settings (`<dataDir>/settings.jsonc`).
 *
 * Low-stakes, studio-owned file: loaded leniently with defaults merged, saved
 * atomically. Editing OpenCode's own config files goes through the jsonc edit
 * engine instead; this file only shapes how the studio itself behaves.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { isPlainObject, parseJsonc, writeTextAtomic } from "./jsonc.js"

export type CaptureSettings = {
  /** Top-level request-body sections hidden by default in capture views. */
  hiddenSections: string[]
}

export type ModuleSettings = {
  /** Module enable switches; missing = defaultEnabled of the module. */
  enabled: Record<string, boolean>
  /** Free-form per-module options (e.g. layout switches). */
  options: Record<string, Record<string, unknown>>
}

export type StudioSettings = {
  capture: CaptureSettings
  modules: ModuleSettings
  /** Pinned deep screens (Menu-2+ only) shown after the fixed defaults. */
  quickAccess: string[]
}

/**
 * Fixed Quick access entries: always present, never pinnable/unpinnable -
 * they are already one click away (the whole main menu is).
 */
export const DEFAULT_QUICK_ACCESS = ["browse", "agents"]

/**
 * Pinnable screens: real option-menus at Menu depth 2+ (children of a
 * main-menu screen). Menu-1 screens (Settings, Browse, Agents, ...) are NOT
 * pinnable - they live in the main menu. Info views (Diagnostics, How it
 * works, captures) are not menus and cannot be pinned.
 */
export const PINNABLE_SCREENS: Array<{ id: string; title: string }> = [
  { id: "settings:Models & agents", title: "Models & agents" },
  { id: "settings:Providers", title: "Settings - Providers" },
  { id: "settings:Providers:disabled_providers", title: "Disabled providers" },
  { id: "settings:Providers:enabled_providers", title: "Enabled providers (allowlist)" },
  { id: "settings:Providers:provider", title: "Provider entries (all, green = enabled)" },
  { id: "settings:Tools & files", title: "Settings - Tools & files" },
  { id: "settings:Tools & files:mcp", title: "MCP servers" },
  { id: "settings:Tools & files:command", title: "Commands" },
  { id: "settings:Tools & files:permission", title: "Permissions" },
  { id: "settings:Tools & files:instructions", title: "Instructions" },
  { id: "settings:Tools & files:skills", title: "Skills" },
  { id: "settings:Tools & files:references", title: "References" },
  { id: "settings:Tools & files:formatter", title: "Formatter" },
  { id: "settings:Tools & files:lsp", title: "LSP" },
  { id: "settings:Session behavior", title: "Settings - Session behavior" },
  { id: "settings:Sharing & updates", title: "Settings - Sharing & updates" },
  { id: "settings:Server", title: "Settings - Server" },
  { id: "settings:Developer", title: "Settings - Developer" },
  { id: "settings:Deprecated", title: "Settings - Deprecated" },
]

export function screenTitle(id: string): string {
  return PINNABLE_SCREENS.find((screen) => screen.id === id)?.title ?? id
}

/** Sections hidden by default when rendering captured request bodies. */
export const DEFAULT_HIDDEN_SECTIONS = [
  "messages",
  "tools",
  "tool_choice",
  "response_format",
  "parallel_tool_calls",
  "stream_options",
  "metadata",
]

export function defaultSettings(): StudioSettings {
  return {
    capture: { hiddenSections: [...DEFAULT_HIDDEN_SECTIONS] },
    modules: { enabled: {}, options: {} },
    // Deep pins only; the fixed defaults (DEFAULT_QUICK_ACCESS) are always
    // rendered and never stored here.
    quickAccess: [],
  }
}

export function settingsPath(dataDir: string): string {
  return join(dataDir, "settings.jsonc")
}

function coerceStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === "string")
  return items.length === value.length ? items : undefined
}

export function loadSettings(dataDir: string): StudioSettings {
  const result = defaultSettings()
  const file = settingsPath(dirOf(dataDir))
  try {
    if (!existsSync(file)) return result
    const report = parseJsonc(readFileSync(file, "utf8"))
    if (!isPlainObject(report.data)) return result
    const capture = report.data["capture"]
    if (isPlainObject(capture)) {
      const hidden = coerceStringArray(capture["hiddenSections"])
      if (hidden) result.capture.hiddenSections = hidden
    }
    const modules = report.data["modules"]
    if (isPlainObject(modules)) {
      const enabled = modules["enabled"]
      if (isPlainObject(enabled)) {
        for (const [id, value] of Object.entries(enabled)) {
          if (typeof value === "boolean") result.modules.enabled[id] = value
        }
      }
      const options = modules["options"]
      if (isPlainObject(options)) {
        for (const [id, bag] of Object.entries(options)) {
          if (isPlainObject(bag)) result.modules.options[id] = { ...bag }
        }
      }
    }
    const quickAccess = report.data["quickAccess"]
    const pinned = coerceStringArray(quickAccess)
    if (pinned) result.quickAccess = pinned
  } catch {
    // Corrupt settings never block the studio.
  }
  return result
}

export function saveSettings(dataDir: string, settings: StudioSettings): void {
  const file = settingsPath(dirOf(dataDir))
  const body = JSON.stringify(
    {
      capture: settings.capture,
      modules: settings.modules,
      quickAccess: settings.quickAccess,
    },
    null,
    2,
  )
  writeTextAtomic(file, `${body}\n`)
}

function dirOf(dataDir: string): string {
  // dataDir may point at the studio data directory itself.
  return dataDir
}

export function moduleEnabled(settings: StudioSettings, id: string, defaultEnabled = true): boolean {
  const value = settings.modules.enabled[id]
  return typeof value === "boolean" ? value : defaultEnabled
}

export function setModuleEnabled(dataDir: string, settings: StudioSettings, id: string, enabled: boolean): void {
  settings.modules.enabled[id] = enabled
  saveSettings(dataDir, settings)
}

export function moduleOption<T>(settings: StudioSettings, id: string, key: string, fallback: T): T {
  const bag = settings.modules.options[id]
  const value = bag?.[key]
  if (value === undefined) return fallback
  return value as T
}

export function setModuleOption(dataDir: string, settings: StudioSettings, id: string, key: string, value: unknown): void {
  const bag = settings.modules.options[id] ?? (settings.modules.options[id] = {})
  bag[key] = value
  saveSettings(dataDir, settings)
}
