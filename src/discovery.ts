/**
 * Config file discovery and provenance merge.
 *
 * Mirrors OpenCode's config layering (packages/opencode/src/config/config.ts
 * loadInstanceState): global files first, then OPENCODE_CONFIG, then project
 * files walking up from the instance directory to the worktree root (deepest
 * wins), then .opencode directory configs. Every discovered file is parsed and
 * merged with per-leaf provenance so the UI can show exactly which file each
 * resolved value comes from.
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { deepClone, isPlainObject, parseJsonc, stableStringify } from "./jsonc.js"

export type ConfigLayerKind = "global" | "env" | "project" | "opencode-dir"

export interface ConfigFileEntry {
  id: string
  kind: ConfigLayerKind
  label: string
  path: string
  precedence: number
  exists: boolean
  parseErrors: string[]
  data: Record<string, unknown>
  text: string
}

export interface ProvenancedMerge {
  merged: Record<string, unknown>
  /** dotted pointer -> id of the file that provided the winning value */
  winner: Map<string, string>
  /** dotted pointer -> ids of every file that defined the pointer */
  contributors: Map<string, string[]>
}

export interface DiscoveryInput {
  globalConfigDir: string
  envConfigFile: string | undefined
  directory: string
  worktree: string
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function readConfigFileSafe(path: string): { text: string; data: Record<string, unknown>; errors: string[] } {
  try {
    if (!existsSync(path)) return { text: "", data: {}, errors: [] }
    const text = readFileSync(path, "utf8")
    const report = parseJsonc(text)
    return {
      text,
      data: isPlainObject(report.data) ? report.data : {},
      errors: report.errors,
    }
  } catch (error) {
    return { text: "", data: {}, errors: [error instanceof Error ? error.message : String(error)] }
  }
}

function makeEntry(kind: ConfigLayerKind, label: string, path: string, precedence: number): ConfigFileEntry {
  const read = readConfigFileSafe(path)
  return {
    id: `${kind}:${label}`,
    kind,
    label,
    path,
    precedence,
    exists: existsSync(path),
    parseErrors: read.errors,
    data: read.data,
    text: read.text,
  }
}

function walkUpChain(directory: string, worktree: string): string[] {
  const chain: string[] = []
  let current = directory
  for (let guard = 0; guard < 64; guard++) {
    chain.push(current)
    if (!current || current === worktree || current === dirname(current)) break
    if (!worktree || !current.startsWith(worktree)) break
    current = dirname(current)
  }
  if (worktree && !chain.includes(worktree)) chain.push(worktree)
  return chain
}

export function discoverConfigFiles(input: DiscoveryInput): ConfigFileEntry[] {
  const entries: ConfigFileEntry[] = []
  let precedence = 0

  // 1. Global config directory: config.json, opencode.json, opencode.jsonc (merged in this order).
  for (const name of ["config.json", "opencode.json", "opencode.jsonc"]) {
    entries.push(makeEntry("global", name, join(input.globalConfigDir, name), precedence++))
  }

  // 2. OPENCODE_CONFIG env file.
  if (input.envConfigFile) {
    entries.push(makeEntry("env", "OPENCODE_CONFIG", input.envConfigFile, precedence++))
  }

  // 3. Project configs: walk directory -> worktree root, applied root-first so deepest wins.
  if (input.directory && input.worktree && input.directory.startsWith(input.worktree)) {
    const chain = walkUpChain(input.directory, input.worktree).reverse()
    for (const dir of chain) {
      for (const name of ["opencode.json", "opencode.jsonc"]) {
        const path = join(dir, name)
        if (existsSync(path)) {
          const relative = dir === input.worktree ? "." : dir.slice(input.worktree.length + 1)
          entries.push(makeEntry("project", `${relative}/${name}`, path, precedence++))
        }
      }
    }
  }

  // 4. .opencode directory configs: global first, then up-tree (weakest to strongest).
  entries.push(makeEntry("opencode-dir", ".opencode/opencode.json", join(input.globalConfigDir, ".opencode", "opencode.json"), precedence++))
  entries.push(makeEntry("opencode-dir", ".opencode/opencode.jsonc", join(input.globalConfigDir, ".opencode", "opencode.jsonc"), precedence++))
  if (input.directory && input.worktree && input.directory.startsWith(input.worktree)) {
    const chain = walkUpChain(input.directory, input.worktree).reverse()
    for (const dir of chain) {
      for (const name of ["opencode.json", "opencode.jsonc"]) {
        const path = join(dir, ".opencode", name)
        if (existsSync(path)) entries.push(makeEntry("opencode-dir", name, path, precedence++))
      }
    }
  }

  return entries
}

export function editableFiles(entries: ConfigFileEntry[]): ConfigFileEntry[] {
  return entries.filter((entry) => entry.exists && entry.parseErrors.length === 0)
}

// ---------------------------------------------------------------------------
// Provenance merge
// ---------------------------------------------------------------------------

function mergeConcatDedupe(previous: unknown[], next: unknown[]): unknown[] {
  const result = [...previous]
  for (const item of next) {
    const key = stableStringify(item)
    if (!result.some((existing) => stableStringify(existing) === key)) result.push(item)
  }
  return result
}

function recordAll(value: Record<string, unknown>, sourceId: string, prefix: string, winner: Map<string, string>, contributors: Map<string, string[]>): void {
  for (const [key, item] of Object.entries(value)) {
    const pointer = `${prefix}.${key}`
    winner.set(pointer, sourceId)
    const list = contributors.get(pointer) ?? ([] as string[])
    if (!list.includes(sourceId)) list.push(sourceId)
    contributors.set(pointer, list)
    if (isPlainObject(item)) recordAll(item, sourceId, pointer, winner, contributors)
  }
}

function mergeInto(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceId: string,
  prefix: string,
  winner: Map<string, string>,
  contributors: Map<string, string[]>,
): void {
  for (const [key, value] of Object.entries(source)) {
    const pointer = prefix ? `${prefix}.${key}` : key
    const existing = target[key]
    const record = () => {
      winner.set(pointer, sourceId)
      const list = contributors.get(pointer) ?? ([] as string[])
      if (!list.includes(sourceId)) list.push(sourceId)
      contributors.set(pointer, list)
    }
    if (isPlainObject(existing) && isPlainObject(value)) {
      // Object-level provenance: this file participates in defining the subtree.
      record()
      mergeInto(existing as Record<string, unknown>, value, sourceId, pointer, winner, contributors)
    } else if (Array.isArray(existing) && Array.isArray(value)) {
      target[key] = mergeConcatDedupe(existing, value)
      record()
    } else {
      // Assign a copy so the merged tree never aliases parsed file data.
      const assigned = isPlainObject(value) ? deepClone(value) : Array.isArray(value) ? [...value] : value
      target[key] = assigned
      record()
      if (isPlainObject(assigned)) recordAll(assigned, sourceId, pointer, winner, contributors)
    }
  }
}

export function mergeWithProvenance(files: ConfigFileEntry[]): ProvenancedMerge {
  const merged: Record<string, unknown> = {}
  const winner = new Map<string, string>()
  const contributors = new Map<string, string[]>()
  for (const file of files) {
    if (!file.exists || file.parseErrors.length > 0) continue
    mergeInto(merged, file.data, file.id, "", winner, contributors)
  }
  return { merged, winner, contributors }
}

// ---------------------------------------------------------------------------
// Value access helpers
// ---------------------------------------------------------------------------

export type JSONPointer = (string | number)[]

export function getIn(value: unknown, pointer: JSONPointer): unknown {
  let current: unknown = value
  for (const segment of pointer) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined
      current = current[segment]
    } else {
      if (!isPlainObject(current)) return undefined
      current = current[segment]
    }
    if (current === undefined) return undefined
  }
  return current
}

export function provenanceAt(merge: ProvenancedMerge, pointer: JSONPointer): { winner?: string; contributors: string[] } {
  const key = pointer.join(".")
  return { winner: merge.winner.get(key), contributors: merge.contributors.get(key) ?? [] }
}

// ---------------------------------------------------------------------------
// File summaries for the selector UI
// ---------------------------------------------------------------------------

export interface FileSummary {
  entry: ConfigFileEntry
  providerCount: number
  editedModelCount: number
  agentCount: number
  hasRootModel: boolean
  topKeys: string[]
}

export function summarizeFile(entry: ConfigFileEntry): FileSummary {
  const provider = entry.data["provider"]
  const providerCount = isPlainObject(provider) ? Object.keys(provider).length : 0
  let editedModelCount = 0
  if (isPlainObject(provider)) {
    for (const providerEntry of Object.values(provider)) {
      if (!isPlainObject(providerEntry)) continue
      const models = providerEntry["models"]
      if (isPlainObject(models)) editedModelCount += Object.keys(models).length
    }
  }
  const agent = entry.data["agent"]
  const agentCount = isPlainObject(agent) ? Object.keys(agent).length : 0
  return {
    entry,
    providerCount,
    editedModelCount,
    agentCount,
    hasRootModel: typeof entry.data["model"] === "string",
    topKeys: Object.keys(entry.data),
  }
}

/** Model entries in a file that carry edits worth surfacing. */
export function fileModelEdits(entry: ConfigFileEntry): Array<{ providerID: string; modelID: string; entry: Record<string, unknown> }> {
  const result: Array<{ providerID: string; modelID: string; entry: Record<string, unknown> }> = []
  const provider = entry.data["provider"]
  if (!isPlainObject(provider)) return result
  for (const [providerID, rawProvider] of Object.entries(provider)) {
    if (!isPlainObject(rawProvider)) continue
    const models = rawProvider["models"]
    if (!isPlainObject(models)) continue
    for (const [modelID, rawModel] of Object.entries(models)) {
      if (!isPlainObject(rawModel)) continue
      result.push({ providerID, modelID, entry: rawModel })
    }
  }
  return result
}

/** Agent entries defined in a file. */
export function fileAgentEdits(entry: ConfigFileEntry): Array<{ agentID: string; entry: Record<string, unknown> }> {
  const agent = entry.data["agent"]
  if (!isPlainObject(agent)) return []
  return Object.entries(agent)
    .filter((entry): entry is [string, Record<string, unknown>] => isPlainObject(entry[1]))
    .map(([agentID, agentEntry]) => ({ agentID, entry: agentEntry }))
}

/**
 * Diff the file-merged config against OpenCode's resolved config to find keys
 * that come from non-file layers (inline env content, remote, managed).
 */
export function findUneditableLayers(merged: Record<string, unknown>, resolved: Record<string, unknown>): Array<{ pointer: string; mergedValue?: unknown; resolvedValue: unknown }> {
  const findings: Array<{ pointer: string; mergedValue?: unknown; resolvedValue: unknown }> = []

  const walk = (mergedNode: unknown, resolvedNode: unknown, prefix: string) => {
    if (!isPlainObject(resolvedNode)) return
    for (const [key, resolvedValue] of Object.entries(resolvedNode)) {
      if (key === "$schema" || key === "plugin" || key === "plugin_origins") continue
      const pointer = prefix ? `${prefix}.${key}` : key
      const mergedValue = isPlainObject(mergedNode) ? mergedNode[key] : undefined
      if (mergedValue === undefined && resolvedValue !== undefined) {
        findings.push({ pointer, resolvedValue })
        continue
      }
      if (isPlainObject(resolvedValue) && isPlainObject(mergedValue)) {
        walk(mergedValue, resolvedValue, pointer)
      }
    }
  }

  walk(merged, resolved, "")
  return findings.slice(0, 200)
}
