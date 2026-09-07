/**
 * Self-wiring: make sure the TUI part of this plugin is registered in a tui
 * config layer once the plugin is registered anywhere in OpenCode config.
 *
 * OpenCode loads server plugins from the `plugin` array in opencode.json
 * layers, but TUI plugins only from tui.json layers. A user (or installer)
 * that registers this plugin in opencode.json alone would get the server part
 * without the wizard. The server entry therefore calls ensureTuiRegistration()
 * on startup: if the plugin spec appears in any opencode.json layer but in no
 * tui.json layer, the exact same spec is appended to the global tui.json.
 */

import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { editConfigFile, isPlainObject, type EditOp } from "./jsonc.js"
import { discoverConfigFiles, type ConfigFileEntry } from "./discovery.js"

export const PLUGIN_NPM_NAME = "@mirrowel/opencode-config-studio"

export function ourRootDir(from: string = import.meta.url): string {
  try {
    return dirname(dirname(fileURLToPath(from)))
  } catch {
    return ""
  }
}

function samePath(a: string, b: string): boolean {
  if (!a || !b) return false
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
  return normalize(a) === normalize(b)
}

export function isOwnSpec(spec: unknown, ourRoot?: string): boolean {
  if (typeof spec !== "string" || spec.length === 0) return false
  if (spec === PLUGIN_NPM_NAME || spec.startsWith(`${PLUGIN_NPM_NAME}@`)) return true
  if (spec.startsWith("file:")) {
    try {
      let url = spec
      if (!url.startsWith("file:///") && url.startsWith("file://")) url = `file:///${url.slice("file://".length)}`
      const path = new URL(url).pathname.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
      // Identity, not instance: ANY checkout of this plugin counts, regardless
      // of which copy is currently running (npm cache vs local repo). Without
      // this, switching between local and npm installs made the selfwire stack
      // a second registration because the other copy's path looked foreign.
      if (path.endsWith("/opencode-config-studio")) return true
      if (ourRoot && samePath(fileURLToPath(url), ourRoot)) return true
      return false
    } catch {
      return false
    }
  }
  return false
}

/** Local checkouts win over npm specs when both are registered. */
function preferLocal(specs: string[]): string[] {
  const local = specs.filter(isLocalSpec)
  const npm = specs.filter((spec) => !local.includes(spec))
  return [...local, ...npm]
}

function isLocalSpec(spec: string): boolean {
  return spec.startsWith("file:") || /^([a-zA-Z]:[\\/]|\/)/.test(spec)
}

function pluginArray(data: Record<string, unknown>): unknown[] {
  const plugin = data["plugin"]
  if (!Array.isArray(plugin)) return []
  return plugin
}

function specStrings(data: Record<string, unknown>): string[] {
  const result: string[] = []
  for (const entry of pluginArray(data)) {
    if (typeof entry === "string") result.push(entry)
    else if (Array.isArray(entry) && typeof entry[0] === "string") result.push(entry[0] as string)
  }
  return result
}

function readData(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {}
    const text = readFileSync(path, "utf8")
    // Parse without importing jsonc.ts's full report (any JSONC is fine here).
    // jsonc parse via the shared engine:
    return parseData(text)
  } catch {
    return {}
  }
}

function parseData(text: string): Record<string, unknown> {
  try {
    // Lazy-safe: use Function-free JSON first, fall back to stripping comments.
    return JSON.parse(stripJsonc(text)) as Record<string, unknown>
  } catch {
    return {}
  }
}

function stripJsonc(text: string): string {
  let out = ""
  let index = 0
  let inString = false
  while (index < text.length) {
    const char = text[index]!
    if (inString) {
      out += char
      if (char === "\\") {
        if (index + 1 < text.length) out += text[index + 1]
        index += 2
        continue
      }
      if (char === '"') inString = false
      index++
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      index++
      continue
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++
      continue
    }
    if (char === "/" && text[index + 1] === "*") {
      index += 2
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index++
      index += 2
      continue
    }
    out += char
    index++
  }
  return out
}

function tuiLayersOf(input: { globalConfigDir: string; directory?: string; worktree?: string; env?: NodeJS.ProcessEnv }): Array<{ path: string; data: Record<string, unknown> }> {
  const layers: Array<{ path: string; data: Record<string, unknown> }> = []
  layers.push({ path: join(input.globalConfigDir, "tui.json"), data: readData(join(input.globalConfigDir, "tui.json")) })
  const envTui = input.env?.["OPENCODE_TUI_CONFIG"]
  if (envTui) layers.push({ path: envTui, data: readData(envTui) })
  if (input.directory && input.worktree && input.directory.startsWith(input.worktree)) {
    let current: string | undefined = input.directory
    for (let guard = 0; guard < 64 && current; guard++) {
      for (const name of ["tui.json"]) {
        const path = join(current, name)
        if (existsSync(path)) layers.push({ path, data: readData(path) })
      }
      const dotOpencode = join(current, ".opencode", "tui.json")
      if (existsSync(dotOpencode)) layers.push({ path: dotOpencode, data: readData(dotOpencode) })
      if (current === input.worktree || current === dirname(current)) break
      current = dirname(current)
    }
  }
  return layers
}

function opencodeLayers(input: { globalConfigDir: string; directory?: string; worktree?: string; env?: NodeJS.ProcessEnv }): ConfigFileEntry[] {
  return discoverConfigFiles({
    globalConfigDir: input.globalConfigDir,
    envConfigFile: input.env?.["OPENCODE_CONFIG"],
    directory: input.directory ?? input.globalConfigDir,
    worktree: input.worktree ?? input.globalConfigDir,
  }).filter((file) => file.exists && file.parseErrors.length === 0)
}

export type WireResult =
  | { status: "already-wired"; spec: string }
  | { status: "wired"; spec: string; target: string }
  | { status: "corrected"; spec: string; target: string; removed: string[] }
  | { status: "not-registered" }
  | { status: "failed"; error: string }

/** Config level directory for a config file path (`.opencode/` nests up). */
function levelDirOf(configPath: string): string {
  let dir = dirname(configPath)
  if (basename(dir) === ".opencode") dir = dirname(dir)
  return dir
}

function tuiPathForLevel(input: { globalConfigDir: string }, levelDir: string): string {
  if (samePath(levelDir, input.globalConfigDir)) return join(input.globalConfigDir, "tui.json")
  return join(levelDir, "tui.json")
}

/** Own-spec indices inside a tui.json-style file's plugin array. */
function ownIndicesIn(tuiPath: string, ourRoot: string): number[] {
  const data = readData(tuiPath)
  const plugin = pluginArray(data)
  const indices: number[] = []
  plugin.forEach((entry, index) => {
    const spec =
      typeof entry === "string"
        ? entry
        : Array.isArray(entry) && typeof entry[0] === "string"
          ? (entry[0] as string)
          : entry && typeof entry === "object" && typeof (entry as { package?: unknown }).package === "string"
            ? (entry as { package: string }).package
            : undefined
    if (spec !== undefined && isOwnSpec(spec, ourRoot)) indices.push(index)
  })
  return indices
}

type PlannedEdit = { file: string; ops: EditOp[]; kind: "wire" | "correct" | "prune" }

export function ensureTuiRegistration(input: { globalConfigDir: string; ourRoot: string; directory?: string; worktree?: string; env?: NodeJS.ProcessEnv }): WireResult {
  // Server-side registrations, grouped per config level.
  const opencodeOwn = opencodeLayers(input)
    .map((file) => ({
      path: file.path,
      level: levelDirOf(file.path),
      specs: specStrings(isPlainObject(file.data) ? file.data : {}).filter((spec) => isOwnSpec(spec, input.ourRoot)),
    }))
    .filter((layer) => layer.specs.length > 0)
  if (opencodeOwn.length === 0) return { status: "not-registered" }

  // Local checkouts win over npm installs; discovery order (strongest layer
  // first) breaks ties. This is "the loaded one" the TUI must mirror.
  const preferAt = (layers: typeof opencodeOwn): string | undefined => {
    const ordered = [...layers].sort((a, b) => {
      const aLocal = a.specs.some(isLocalSpec)
      const bLocal = b.specs.some(isLocalSpec)
      if (aLocal !== bLocal) return aLocal ? -1 : 1
      return 0
    })
    const first = ordered[0]
    if (!first) return undefined
    return preferLocal(first.specs)[0]
  }
  const wanted = preferAt(opencodeOwn)
  if (!wanted) return { status: "not-registered" }
  const wantedLevel = opencodeOwn.find((layer) => layer.specs.includes(wanted))?.level ?? input.globalConfigDir
  const target = tuiPathForLevel(input, wantedLevel)

  // Per tui layer: a level with a server registration mirrors it exactly
  // (one entry, the preferred spec); a level WITHOUT a registration must not
  // carry our entry at all (stale mirror removed).
  const planned: PlannedEdit[] = []
  const seenFiles = new Set<string>()
  const planForTuiFile = (tuiPath: string, level: string) => {
    if (seenFiles.has(tuiPath)) return
    seenFiles.add(tuiPath)
    if (!existsSync(tuiPath)) return
    const indices = ownIndicesIn(tuiPath, input.ourRoot)
    if (indices.length === 0) return
    const levelLayers = opencodeOwn.filter((layer) => samePath(layer.level, level))
    if (levelLayers.length === 0) {
      // Stale mirror: no server registration at this level anymore.
      planned.push({
        file: tuiPath,
        kind: "prune",
        ops: [...indices].sort((a, b) => b - a).map((index) => ({ op: "delete" as const, path: ["plugin", index] })),
      })
      return
    }
    const wantedHere = preferAt(levelLayers) ?? wanted
    if (indices.length === 1) {
      const data = readData(tuiPath)
      const entry = pluginArray(data)[indices[0]!]
      const spec = typeof entry === "string" ? entry : Array.isArray(entry) && typeof entry[0] === "string" ? (entry[0] as string) : undefined
      if (spec === wantedHere) return
      planned.push({ file: tuiPath, kind: "correct", ops: [{ op: "set", path: ["plugin", indices[0]!], value: wantedHere }] })
      return
    }
    const [keep, ...drop] = indices
    const ops: EditOp[] = [{ op: "set", path: ["plugin", keep!], value: wantedHere }]
    for (const index of [...drop].sort((a, b) => b - a)) ops.push({ op: "delete", path: ["plugin", index] })
    planned.push({ file: tuiPath, kind: "correct", ops })
  }

  const tuiLayers = tuiLayersOf(input)
  for (const layer of tuiLayers) planForTuiFile(layer.path, levelDirOf(layer.path))

  // Ensure the registration level carries its mirror.
  if (!seenFiles.has(target) || !existsSync(target)) {
    const indices = existsSync(target) ? ownIndicesIn(target, input.ourRoot) : []
    if (indices.length === 0) {
      const data = readData(target)
      planned.push({ file: target, kind: "wire", ops: [{ op: "set", path: ["plugin", pluginArray(data).length], value: wanted }] })
    }
  }

  if (planned.length === 0) return { status: "already-wired", spec: wanted }

  const removed: string[] = []
  for (const edit of planned) {
    const result = editConfigFile(edit.file, edit.ops, {
      stateDir: join(input.globalConfigDir, "config-studio"),
      reason: "self-wire config-studio TUI registration",
    })
    if (!result.ok) {
      if (result.error?.includes("No changes")) continue
      return { status: "failed", error: `${edit.file}: ${result.error ?? "unknown error"}` }
    }
    removed.push(`${edit.file} (${edit.kind})`)
  }
  if (removed.length === 0) return { status: "already-wired", spec: wanted }
  if (planned.every((edit) => edit.kind === "wire")) {
    return { status: "wired", spec: wanted, target }
  }
  return { status: "corrected", spec: wanted, target, removed }
}
