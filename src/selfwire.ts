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
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { editConfigFile, isPlainObject } from "./jsonc.js"
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

export function isOwnSpec(spec: unknown, ourRoot: string): boolean {
  if (typeof spec !== "string" || spec.length === 0) return false
  if (spec === PLUGIN_NPM_NAME || spec.startsWith(`${PLUGIN_NPM_NAME}@`)) return true
  if (spec.startsWith("file:")) {
    try {
      let url = spec
      if (!url.startsWith("file:///") && url.startsWith("file://")) url = `file:///${url.slice("file://".length)}`
      return samePath(fileURLToPath(url), ourRoot)
    } catch {
      return false
    }
  }
  return false
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

function findInLayers(layers: Array<{ path: string; data: Record<string, unknown> }>, ourRoot: string): string | undefined {
  for (const layer of layers) {
    for (const spec of specStrings(layer.data)) {
      if (isOwnSpec(spec, ourRoot)) return spec
    }
  }
  return undefined
}

function tuiLayers(input: { globalConfigDir: string; directory?: string; worktree?: string; env?: NodeJS.ProcessEnv }): Array<{ path: string; data: Record<string, unknown> }> {
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
  | { status: "not-registered" }
  | { status: "failed"; error: string }

export function ensureTuiRegistration(input: { globalConfigDir: string; ourRoot: string; directory?: string; worktree?: string; env?: NodeJS.ProcessEnv }): WireResult {
  const already = findInLayers(tuiLayers(input), input.ourRoot)
  if (already) return { status: "already-wired", spec: already }

  const spec = findInLayers(opencodeLayers(input).map((file) => ({ path: file.path, data: isPlainObject(file.data) ? file.data : {} })), input.ourRoot)
  if (!spec) return { status: "not-registered" }

  const target = join(input.globalConfigDir, "tui.json")
  const existing = readData(target)
  const index = pluginArray(existing).length
  const result = editConfigFile(target, [{ op: "set", path: ["plugin", index], value: spec }], {
    stateDir: join(input.globalConfigDir, "config-studio"),
    reason: "self-wire config-studio TUI registration",
  })
  if (!result.ok) {
    if (result.error?.includes("No changes")) return { status: "already-wired", spec }
    return { status: "failed", error: result.error ?? "unknown error" }
  }
  return { status: "wired", spec, target }
}
