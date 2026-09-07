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

function scanFile(file: { path: string; data: unknown }): StandaloneHit[] {
  if (!isPlainObject(file.data)) return []
  const plugin = file.data["plugin"]
  if (!Array.isArray(plugin)) return []
  const hits: StandaloneHit[] = []
  plugin.forEach((entry, index) => {
    const spec = typeof entry === "string" ? entry : Array.isArray(entry) && typeof entry[0] === "string" ? (entry[0] as string) : undefined
    if (spec !== undefined && isStandaloneAgentVariantsSpec(spec)) hits.push({ file: file.path, spec, index })
  })
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

  const tuiCandidates = [join(input.globalConfigDir, "tui.json")]
  const envTui = input.env?.["OPENCODE_TUI_CONFIG"]
  if (envTui) tuiCandidates.push(envTui)
  for (const path of tuiCandidates) {
    hits.push(...scanFile({ path, data: readLayerData(path) }))
  }
  return hits
}

/** Removes every standalone hit (descending indices per file, backups kept). */
export function removeStandaloneHits(hits: StandaloneHit[], stateDir: string): Array<{ file: string; error?: string }> {
  const byFile = new Map<string, StandaloneHit[]>()
  for (const hit of hits) {
    const list = byFile.get(hit.file) ?? []
    list.push(hit)
    byFile.set(hit.file, list)
  }
  const results: Array<{ file: string; error?: string }> = []
  for (const [file, fileHits] of byFile) {
    const ops: EditOp[] = [...fileHits]
      .sort((a, b) => b.index - a.index)
      .map((hit) => ({ op: "delete" as const, path: ["plugin", hit.index] }))
    const result = editConfigFile(file, ops, { stateDir, reason: "remove standalone agent-variants (embedded in config studio)" })
    results.push({ file, error: result.ok ? undefined : result.error })
  }
  return results
}
