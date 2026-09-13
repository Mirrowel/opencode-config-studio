/**
 * Standalone Agent Variants detection and removal.
 *
 * Config Studio embeds the agent-variants plugin as a module. When the
 * standalone plugin is ALSO registered in any config layer, routing would run
 * twice after the studio's embedded server part activates. The studio
 * therefore detects standalone registrations (npm name or any file: path
 * pointing at an agent-variants install) and offers to remove them from every
 * layer; until the next restart, the studio's embedded router stays dormant
 * whenever a standalone registration exists.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { editConfigFile, isPlainObject, parseJsonc, type EditOp } from "./jsonc.js"
import { discoverConfigFiles, type ConfigFileEntry } from "./discovery.js"

export const AGENT_VARIANTS_NPM = "@mirrowel/opencode-agent-variants"

export type StandaloneHit = {
  file: string
  spec: string
  index: number
  /** Config array key the entry lives in: v1 `plugin`, v2 `plugins`. */
  key: "plugin" | "plugins"
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

/** True for any plugin spec that registers agent-variants (npm or file). */
export function isStandaloneAgentVariantsSpec(spec: unknown): spec is string {
  if (typeof spec !== "string" || spec.length === 0) return false
  if (spec === AGENT_VARIANTS_NPM || spec.startsWith(`${AGENT_VARIANTS_NPM}@`)) return true
  if (spec.startsWith("file:")) {
    let url = spec
    if (!url.startsWith("file:///") && url.startsWith("file://")) url = `file:///${url.slice("file://".length)}`
    try {
      const path = normalizePath(new URL(url).pathname)
      if (path.endsWith("/opencode-agent-variants") || path.endsWith("/agent-variants")) return true
      if (path.includes("/node_modules/@mirrowel/opencode-agent-variants")) return true
      return false
    } catch {
      return false
    }
  }
  return false
}

/** Extracts the spec string from v1 (string | [spec, options]) and v2 ({package}) entry forms. */
export function pluginEntrySpec(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0] as string
  if (entry && typeof entry === "object" && typeof (entry as { package?: unknown }).package === "string") {
    return (entry as { package: string }).package
  }
  return undefined
}

function scanFile(file: { path: string; data: unknown }): StandaloneHit[] {
  if (!isPlainObject(file.data)) return []
  const hits: StandaloneHit[] = []
  // v1 opencode.json/tui.json use `plugin`; v2 opencode.json/cli.json use `plugins`.
  for (const key of ["plugin", "plugins"] as const) {
    const array = file.data[key]
    if (!Array.isArray(array)) continue
    array.forEach((entry, index) => {
      const spec = pluginEntrySpec(entry)
      if (spec !== undefined && isStandaloneAgentVariantsSpec(spec)) hits.push({ file: file.path, spec, index, key })
    })
  }
  return hits
}

function readLayerData(path: string): unknown {
  if (!existsSync(path)) return {}
  return parseJsonc(readFileSync(path, "utf8")).data
}

export function findStandaloneAgentVariants(input: {
  globalConfigDir: string
  directory?: string
  worktree?: string
  env?: NodeJS.ProcessEnv
}): StandaloneHit[] {
  const hits: StandaloneHit[] = []
  const layers: ConfigFileEntry[] = discoverConfigFiles({
    globalConfigDir: input.globalConfigDir,
    envConfigFile: input.env?.["OPENCODE_CONFIG"],
    directory: input.directory ?? input.globalConfigDir,
    worktree: input.worktree ?? input.globalConfigDir,
  }).filter((file) => file.exists && file.parseErrors.length === 0)
  const seen = new Set<string>()
  for (const layer of layers) {
    if (seen.has(layer.path)) continue
    seen.add(layer.path)
    hits.push(...scanFile(layer))
  }

  // Terminal-client config files: v1 tui.json layers, v2 one global cli.json.
  const tuiCandidates = [join(input.globalConfigDir, "tui.json"), join(input.globalConfigDir, "cli.json")]
  const envTui = input.env?.["OPENCODE_TUI_CONFIG"]
  if (envTui) tuiCandidates.push(envTui)
  for (const path of tuiCandidates) {
    hits.push(...scanFile({ path, data: readLayerData(path) }))
  }
  return hits
}

/** Removes every standalone hit (descending indices per file+key, backups kept). */
export function removeStandaloneHits(hits: StandaloneHit[], stateDir: string): Array<{ file: string; error?: string }> {
  const byFile = new Map<string, StandaloneHit[]>()
  for (const hit of hits) {
    const list = byFile.get(hit.file) ?? []
    list.push(hit)
    byFile.set(hit.file, list)
  }
  const results: Array<{ file: string; error?: string }> = []
  for (const [file, fileHits] of byFile) {
    // Delete per key so v1 (`plugin`) and v2 (`plugins`) indices stay correct.
    const byKey = new Map<"plugin" | "plugins", StandaloneHit[]>()
    for (const hit of fileHits) {
      const list = byKey.get(hit.key) ?? []
      list.push(hit)
      byKey.set(hit.key, list)
    }
    const ops: EditOp[] = []
    for (const list of byKey.values()) {
      for (const hit of [...list].sort((a, b) => b.index - a.index)) {
        ops.push({ op: "delete" as const, path: [hit.key, hit.index] })
      }
    }
    const result = editConfigFile(file, ops, { stateDir, reason: "remove standalone agent-variants (embedded in config studio)" })
    results.push({ file, error: result.ok ? undefined : result.error })
  }
  return results
}
