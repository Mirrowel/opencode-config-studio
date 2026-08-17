/**
 * Sidecar -> config migration for Agent Variants parent fields.
 *
 * Config-savable parent fields (model, variant, temperature, top_p, prompt,
 * description, options, color) can live directly in opencode.json instead of
 * sidecar parent patches. Migration materializes them:
 * - model preset references are resolved to concrete provider/model values
 * - prompt/description templates ({agent}, {key}, ...) are rendered with
 *   real values, because config values are static
 *
 * Pure data in/out; the module stages the ops and removes the sidecar keys.
 */

import {
  applyModelPresetPatch,
  renderTemplate,
  resolveModel,
  templateContext,
  type SidecarConfig,
} from "@mirrowel/opencode-agent-variants/config"
import type { EditOp } from "./jsonc.js"

/** Parent-patch fields that opencode.json can store directly. */
export const CONFIG_SAVABLE_PARENT_FIELDS = [
  "model",
  "variant",
  "temperature",
  "top_p",
  "prompt",
  "description",
  "options",
  "color",
] as const

export type ConfigSavableField = (typeof CONFIG_SAVABLE_PARENT_FIELDS)[number]

/** Fields that keep template semantics in the sidecar. */
const TEMPLATE_FIELDS = new Set(["prompt", "description"])

export type MigrationPlan = {
  agent: string
  /** Config ops writing the materialized values. */
  ops: EditOp[]
  /** Sidecar parent keys to remove after migration. */
  sidecarRemovals: string[]
  /** Human-readable notes shown in the review dialog. */
  notes: string[]
}

/** Which savable fields does this agent's sidecar parent patch define? */
export function savableParentFields(config: SidecarConfig, agent: string): ConfigSavableField[] {
  const entry = config.agents[agent]
  if (!entry) return []
  const patch = entry.parent as Record<string, unknown>
  return CONFIG_SAVABLE_PARENT_FIELDS.filter((key) => patch[key] !== undefined && patch[key] !== "")
}

/** Builds the migration plan for one agent (no mutation). */
export function buildMigrationPlan(config: SidecarConfig, agent: string): MigrationPlan | undefined {
  const savable = savableParentFields(config, agent)
  if (savable.length === 0) return undefined
  const entry = config.agents[agent]!
  const resolved = applyModelPresetPatch(entry.parent, config) as Record<string, unknown>
  const context = templateContext(agent, undefined, {}, config)
  const ops: EditOp[] = []
  const notes: string[] = []
  for (const key of savable) {
    let value = resolved[key]
    if (value === undefined || value === "") {
      // Preset resolution dropped it (invalid ref): keep the raw value so the
      // user sees it in the diff and can fix it in config afterwards.
      value = (entry.parent as Record<string, unknown>)[key]
      notes.push(`${key}: kept raw sidecar value (model preset did not resolve)`)
    }
    if (key === "model" && typeof value === "string") {
      // applyModelPresetPatch keeps the preset KEY in model; config needs the
      // concrete provider/model it resolves to.
      const concrete = resolveModel(value, config)
      if (concrete && concrete !== value) {
        notes.push(`model: preset "${value}" resolved to ${concrete}`)
        value = concrete
      }
    }
    if (TEMPLATE_FIELDS.has(key) && typeof value === "string") {
      const rendered = renderTemplate(value, context)
      if (rendered !== value) notes.push(`${key}: template tokens materialized (${JSON.stringify(value)} -> ${JSON.stringify(rendered)})`)
      value = rendered
    }
    ops.push({ op: "set", path: ["agent", agent, key], value })
  }
  return { agent, ops, sidecarRemovals: [...savable], notes }
}
