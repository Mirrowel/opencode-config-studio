/**
 * Catalog intelligence: models.dev metadata, variant derivation, and
 * config-vs-catalog provenance analysis.
 *
 * OpenCode derives a model's variant list from models.dev `reasoning_options`
 * (effort tiers / budget_tokens / toggle) with a per-SDK heuristic fallback,
 * then deep-merges user config variants on top (config wins per key,
 * `disabled: true` removes the variant). The resolved catalog (via
 * client.provider.list) already contains the exact merged bodies; this module
 * combines that with raw models.dev metadata and the parsed config files to
 * attribute every variant and every body key to its source.
 *
 * Base request defaults (what "no variant" sends) live in OpenCode's internal
 * ProviderTransform table and are exposed by no API. computeBaseDefaults()
 * mirrors the significant branches of that table as a labeled approximation;
 * the request-capture sink provides the exact ground truth.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isPlainObject, stableStringify } from "./jsonc.js"
import { getIn, provenanceAt, type ProvenancedMerge } from "./discovery.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CatalogModelMeta {
  reasoning?: boolean
  reasoning_options?: Array<{ type: "effort" | "toggle" | "budget_tokens"; values?: Array<string | null>; min?: number; max?: number }>
  limit?: { context?: number; output?: number }
  [key: string]: unknown
}

export interface CatalogProviderMeta {
  npm?: string
  name?: string
  api?: string
  models?: Record<string, CatalogModelMeta>
}

export type ModelsDevCatalog = Record<string, CatalogProviderMeta>

export interface RuntimeModelLike {
  id: string
  name: string
  providerID?: string
  api?: { id?: string; npm?: string }
  capabilities?: { reasoning?: boolean; temperature?: boolean; toolcall?: boolean }
  reasoning?: boolean
  options?: Record<string, unknown>
  variants?: Record<string, Record<string, unknown>>
  limit?: { context?: number; output?: number }
  [key: string]: unknown
}

export interface RuntimeProviderLike {
  id: string
  name: string
  source?: string
  env?: string[]
  options?: Record<string, unknown>
  models: Record<string, RuntimeModelLike>
}

export type VariantSourceKind = "catalog-effort" | "catalog-budget" | "catalog-toggle" | "catalog-heuristic" | "config" | "disabled"

export interface VariantKeyProvenance {
  key: string
  value: unknown
  source: "config" | "catalog"
  fileIDs: string[]
}

export interface VariantAnalysis {
  name: string
  source: VariantSourceKind
  disabled: boolean
  resolvedBody: Record<string, unknown>
  configBody: Record<string, unknown> | undefined
  derivedBody: Record<string, unknown> | undefined
  keyProvenance: VariantKeyProvenance[]
  files: string[]
}

export interface ModelAnalysis {
  providerID: string
  modelID: string
  runtime: RuntimeModelLike
  variants: VariantAnalysis[]
  configOptions: Record<string, unknown> | undefined
  configOptionsFiles: string[]
  /** options merged onto the runtime model entry (config overlay result) */
  effectiveModelOptions: Record<string, unknown>
  smallModelBody: Record<string, unknown> | undefined
}

// ---------------------------------------------------------------------------
// models.dev fetch with cache
// ---------------------------------------------------------------------------

const MODELS_URL = "https://models.opencode.ai/api.json"
const CACHE_TTL_MS = 5 * 60 * 1000

let memoryCache: { at: number; catalog: ModelsDevCatalog } | undefined

export async function fetchModelsDev(stateDir: string, timeoutMs = 15000): Promise<{ catalog: ModelsDevCatalog; cached: boolean; error?: string }> {
  if (memoryCache && Date.now() - memoryCache.at < CACHE_TTL_MS) {
    return { catalog: memoryCache.catalog, cached: true }
  }
  const cacheFile = join(stateDir, "models-cache.json")
  try {
    if (existsSync(cacheFile)) {
      const raw = JSON.parse(readFileSync(cacheFile, "utf8")) as { at: number; catalog: ModelsDevCatalog }
      if (Date.now() - raw.at < CACHE_TTL_MS) {
        memoryCache = { at: raw.at, catalog: raw.catalog }
        return { catalog: raw.catalog, cached: true }
      }
    }
  } catch {
    // cache read failures fall through to fetch
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const response = await fetch(MODELS_URL, { signal: controller.signal })
    clearTimeout(timer)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const catalog = (await response.json()) as ModelsDevCatalog
    memoryCache = { at: Date.now(), catalog }
    try {
      const stateDirResolved = stateDir
      const { mkdirSync } = await import("node:fs")
      mkdirSync(stateDirResolved, { recursive: true })
      writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), catalog }), "utf8")
    } catch {
      // disk cache is best-effort
    }
    return { catalog, cached: false }
  } catch (error) {
    // network failed: fall back to stale disk cache if any
    try {
      if (existsSync(cacheFile)) {
        const raw = JSON.parse(readFileSync(cacheFile, "utf8")) as { at: number; catalog: ModelsDevCatalog }
        return { catalog: raw.catalog, cached: true, error: error instanceof Error ? error.message : String(error) }
      }
    } catch {
      // ignore
    }
    return { catalog: {}, cached: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------------------
// Variant derivation (mirrors ProviderTransform.reasoningVariants)
// ---------------------------------------------------------------------------

const OUTPUT_TOKEN_MAX = 32768 * 4

export function reasoningEffortBody(npm: string | undefined, modelID: string, effort: string): Record<string, unknown> | undefined {
  const id = modelID.toLowerCase()
  switch (npm) {
    case "@openrouter/ai-sdk-provider":
      return { reasoning: { effort } }
    case "@ai-sdk/anthropic":
    case "@ai-sdk/google-vertex/anthropic": {
      const isClaude = id.includes("claude")
      if (isClaude && effort !== "none") return { thinking: { type: "enabled" }, effort }
      if (isClaude) return { effort }
      return { thinking: { type: "adaptive", display: "summarized" }, effort }
    }
    case "@ai-sdk/google":
    case "@ai-sdk/google-vertex":
      return { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } }
    case "@ai-sdk/amazon-bedrock":
      return { reasoningConfig: { type: "enabled", maxReasoningEffort: effort } }
    case "@ai-sdk/github-copilot":
      return { reasoningEffort: effort, reasoningSummary: "auto", include: ["reasoning.encrypted_content"] }
    case "@ai-sdk/openai":
    case "@ai-sdk/amazon-bedrock/mantle":
    case "@ai-sdk/azure":
      return { reasoningEffort: effort, reasoningSummary: "auto", include: ["reasoning.encrypted_content"] }
    case "@ai-sdk/gateway":
      return { reasoningEffort: effort }
    case "@jerome-benoit/sap-ai-provider-v2":
      return { modelParams: { reasoningEffort: effort } }
    default:
      // openai-compatible family and most other providers
      return { reasoningEffort: effort }
  }
}

export function reasoningBudgetBody(npm: string | undefined, budget: number): Record<string, unknown> | undefined {
  switch (npm) {
    case "@openrouter/ai-sdk-provider":
      return { reasoning: { max_tokens: budget } }
    case "@ai-sdk/anthropic":
    case "@ai-sdk/google-vertex/anthropic":
      return { thinking: { type: "enabled", budgetTokens: budget } }
    case "@ai-sdk/google":
    case "@ai-sdk/google-vertex":
      return { thinkingConfig: { thinkingBudget: budget } }
    case "@ai-sdk/amazon-bedrock":
      return { reasoningConfig: { budgetTokens: budget } }
    case "cohere-ai":
      return { tokenBudget: budget }
    case "@jerome-benoit/sap-ai-provider-v2":
      return { modelParams: { thinkingBudget: budget } }
    default:
      return undefined
  }
}

export interface DerivedVariants {
  names: string[]
  bodies: Record<string, Record<string, unknown> | undefined>
  kinds: Record<string, "catalog-effort" | "catalog-budget" | "catalog-toggle">
}

export function deriveVariantsFromMeta(
  npm: string | undefined,
  modelID: string,
  meta: CatalogModelMeta | undefined,
): DerivedVariants | undefined {
  if (!meta || meta.reasoning_options === undefined) return undefined
  const options = meta.reasoning_options
  if (options.length === 0) return { names: [], bodies: {}, kinds: {} }

  const effort = options.find((option) => option.type === "effort")
  if (effort) {
    const names = (effort.values ?? []).map((value) => value ?? "none")
    const bodies: Record<string, Record<string, unknown> | undefined> = {}
    const kinds: Record<string, "catalog-effort"> = {}
    for (const name of names) {
      bodies[name] = reasoningEffortBody(npm, modelID, name)
      kinds[name] = "catalog-effort"
    }
    return { names, bodies, kinds }
  }

  const budget = options.find((option) => option.type === "budget_tokens")
  if (budget) {
    const maximum = Math.min(budget.max ?? OUTPUT_TOKEN_MAX - 1, (meta.limit?.output ?? OUTPUT_TOKEN_MAX) - 1, OUTPUT_TOKEN_MAX - 1)
    const high = Math.max(budget.min ?? 0, Math.floor((maximum + 1) / 2))
    const bodies: Record<string, Record<string, unknown> | undefined> = {
      high: reasoningBudgetBody(npm, high),
      max: reasoningBudgetBody(npm, maximum),
    }
    return { names: ["high", "max"], bodies, kinds: { high: "catalog-budget", max: "catalog-budget" } }
  }

  if (options.some((option) => option.type === "toggle")) {
    const id = modelID.toLowerCase()
    if (npm === "cohere-ai" || npm === "@ai-sdk/cohere") {
      return {
        names: ["none", "high"],
        bodies: { none: { thinking: { type: "disabled" } }, high: { thinking: { type: "enabled" } } },
        kinds: { none: "catalog-toggle", high: "catalog-toggle" },
      }
    }
    if (id.includes("qwen") || id.includes("alibaba") || id.includes("dashscope")) {
      return {
        names: ["none", "high"],
        bodies: { none: { enable_thinking: false }, high: { enable_thinking: true } },
        kinds: { none: "catalog-toggle", high: "catalog-toggle" },
      }
    }
    return { names: [], bodies: {}, kinds: {} }
  }

  return { names: [], bodies: {}, kinds: {} }
}

// ---------------------------------------------------------------------------
// Base defaults preview (approximation of ProviderTransform.options)
// ---------------------------------------------------------------------------

export interface BaseDefaultsPreview {
  options: Record<string, unknown>
  notes: string[]
  approximate: true
}

export function computeBaseDefaults(npm: string | undefined, providerID: string, model: RuntimeModelLike): BaseDefaultsPreview {
  const result: Record<string, unknown> = {}
  const notes: string[] = []
  const id = (model.api?.id ?? model.id ?? "").toLowerCase()
  const reasoning = model.capabilities?.reasoning ?? model.reasoning ?? false

  if (npm === "@ai-sdk/google-vertex/anthropic" || (!id.includes("claude") && npm === "@ai-sdk/anthropic")) {
    result["toolStreaming"] = false
  }

  if (providerID === "openai" || npm === "@ai-sdk/openai" || npm === "@ai-sdk/github-copilot" || npm === "@ai-sdk/amazon-bedrock/mantle" || npm === "@ai-sdk/xai" || npm === "@ai-sdk/azure") {
    result["store"] = false
  }

  if (npm === "@openrouter/ai-sdk-provider" || npm === "@llmgateway/ai-sdk-provider") {
    result["usage"] = { include: true }
    if (id.includes("gemini-3")) result["reasoning"] = { effort: "high" }
  }

  if (providerID === "baseten" || (providerID === "opencode" && ["kimi-k2-thinking", "glm-4.6"].includes(id))) {
    result["chat_template_args"] = { enable_thinking: true }
  }

  if (["zai", "zhipuai"].some((token) => providerID.includes(token)) && npm === "@ai-sdk/openai-compatible") {
    result["thinking"] = { type: "enabled", clear_thinking: false }
  }

  if (npm === "@ai-sdk/google" || npm === "@ai-sdk/google-vertex") {
    if (reasoning) {
      result["thinkingConfig"] = { includeThoughts: true }
      if (id.includes("gemini-3")) result["thinkingConfig"] = { includeThoughts: true, thinkingLevel: "high" }
    }
  }

  if (id.includes("minimax-m3") && npm === "@ai-sdk/anthropic") {
    result["thinking"] = { type: "adaptive" }
  }

  if (providerID === "alibaba-cn" && reasoning && npm === "@ai-sdk/openai-compatible" && !id.includes("kimi-k2-thinking")) {
    result["enable_thinking"] = true
  }

  if (["@ai-sdk/deepinfra", "@ai-sdk/cerebras"].includes(npm ?? "")) {
    result["prompt_cache_key"] = "<session id>"
  } else if (["@ai-sdk/openai", "@ai-sdk/azure", "@ai-sdk/xai", "@ai-sdk/mistral", "venice-ai-sdk-provider"].includes(npm ?? "")) {
    result["promptCacheKey"] = "<session id>"
  }

  if (npm === "@ai-sdk/gateway") {
    result["gateway"] = { caching: "auto" }
  }

  if (id.includes("gpt-5") && !id.includes("gpt-5-chat") && !id.includes("gpt-5-pro")) {
    result["reasoningEffort"] = "medium"
    if (["@ai-sdk/openai", "@ai-sdk/azure", "@ai-sdk/github-copilot", "@ai-sdk/amazon-bedrock/mantle"].includes(npm ?? "")) {
      result["reasoningSummary"] = "auto"
    }
    if (npm === "@ai-sdk/openai" || npm === "@ai-sdk/amazon-bedrock/mantle") {
      result["include"] = ["reasoning.encrypted_content"]
    }
    if (id.includes("gpt-5.") && !id.includes("codex") && !id.includes("-chat") && providerID !== "azure") {
      result["textVerbosity"] = "low"
    }
  }

  if (providerID.startsWith("opencode") && id.includes("gpt-5")) {
    result["promptCacheKey"] = "<session id>"
    result["include"] = ["reasoning.encrypted_content"]
    result["reasoningSummary"] = "auto"
  }

  notes.push("Computed preview of OpenCode's internal base-defaults table.")
  notes.push("Exact values depend on session state and OpenCode version; use request capture for ground truth.")
  return { options: result, notes, approximate: true }
}

/** Mirror of ProviderTransform.smallOptions: first variant body (titles/summaries). */
export function computeSmallModelOptions(model: RuntimeModelLike): Record<string, unknown> | undefined {
  const variants = model.variants
  if (!variants) return undefined
  const first = Object.values(variants)[0]
  return first ? { ...first } : undefined
}

// ---------------------------------------------------------------------------
// Model analysis: config vs catalog provenance
// ---------------------------------------------------------------------------

export function configVariantEntry(merge: ProvenancedMerge, providerID: string, modelID: string): Record<string, Record<string, unknown>> {
  const value = getIn(merge.merged, ["provider", providerID, "models", modelID, "variants"])
  if (!isPlainObject(value)) return {}
  const result: Record<string, Record<string, unknown>> = {}
  for (const [name, body] of Object.entries(value)) {
    if (isPlainObject(body)) result[name] = body
  }
  return result
}

export function analyzeModel(
  runtime: RuntimeModelLike,
  providerID: string,
  modelID: string,
  merge: ProvenancedMerge,
  modelsDevCatalog?: ModelsDevCatalog,
): ModelAnalysis {
  const configVariants = configVariantEntry(merge, providerID, modelID)
  const meta = modelsDevCatalog?.[providerID]?.models?.[modelID]
  const npm = modelsDevCatalog?.[providerID]?.npm ?? runtime.api?.npm
  const derived = deriveVariantsFromMeta(npm, modelID, meta)
  const resolvedVariants = runtime.variants ?? {}

  const variantNames = new Set<string>([...Object.keys(resolvedVariants), ...Object.keys(configVariants)])
  const variants: VariantAnalysis[] = []

  for (const name of variantNames) {
    const configEntry = configVariants[name]
    const resolvedBody = resolvedVariants[name]
    const disabled = configEntry?.["disabled"] === true
    const derivedBody = derived?.bodies[name]
    const derivedKind = derived?.kinds[name]

    const keyProvenance: VariantKeyProvenance[] = []
    const bodySource = resolvedBody ?? derivedBody ?? {}
    const winnerFiles = provenanceAt(merge, ["provider", providerID, "models", modelID, "variants", name])
    for (const [key, value] of Object.entries(bodySource)) {
      if (key === "disabled") continue
      const keyFiles = provenanceAt(merge, ["provider", providerID, "models", modelID, "variants", name, key])
      const fromConfig = keyFiles.contributors.length > 0
      keyProvenance.push({ key, value, source: fromConfig ? "config" : "catalog", fileIDs: keyFiles.contributors })
    }

    let source: VariantSourceKind
    if (disabled) {
      source = "disabled"
    } else if (winnerFiles.contributors.length > 0 && derived?.names.includes(name)) {
      source = derivedKind ?? "catalog-heuristic"
    } else if (winnerFiles.contributors.length > 0) {
      source = "config"
    } else if (derived?.names.includes(name)) {
      source = derivedKind ?? "catalog-heuristic"
    } else {
      source = "catalog-heuristic"
    }

    variants.push({
      name,
      source,
      disabled,
      resolvedBody: (resolvedBody ?? {}) as Record<string, unknown>,
      configBody: configEntry,
      derivedBody,
      keyProvenance,
      files: winnerFiles.contributors,
    })
  }

  variants.sort((a, b) => {
    if (a.disabled !== b.disabled) return a.disabled ? 1 : -1
    const rank = (variant: VariantAnalysis) => (variant.source === "config" || variant.files.length > 0 ? 0 : variant.source === "catalog-heuristic" ? 2 : 1)
    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank
    return a.name.localeCompare(b.name)
  })

  const configOptions = getIn(merge.merged, ["provider", providerID, "models", modelID, "options"])
  const optionsFiles = provenanceAt(merge, ["provider", providerID, "models", modelID, "options"]).contributors

  return {
    providerID,
    modelID,
    runtime,
    variants,
    configOptions: isPlainObject(configOptions) ? configOptions : undefined,
    configOptionsFiles: optionsFiles,
    effectiveModelOptions: runtime.options ?? {},
    smallModelBody: computeSmallModelOptions(runtime),
  }
}

// ---------------------------------------------------------------------------
// Provider analysis for the browser
// ---------------------------------------------------------------------------

export interface ProviderAnalysis {
  providerID: string
  name: string
  npm: string | undefined
  source: string | undefined
  connected: boolean
  isDefaultProvider: boolean
  modelCount: number
  editedModelCount: number
  edited: boolean
}

export function analyzeProviders(
  providers: RuntimeProviderLike[],
  defaults: Record<string, string>,
  merge: ProvenancedMerge,
): ProviderAnalysis[] {
  const analyses: ProviderAnalysis[] = []
  for (const provider of providers) {
    let editedModelCount = 0
    const providerConfig = getIn(merge.merged, ["provider", provider.id, "models"])
    if (isPlainObject(providerConfig)) editedModelCount = Object.keys(providerConfig).length
    const providerEdited = provenanceAt(merge, ["provider", provider.id]).contributors.length > 0
    const firstModel = Object.values(provider.models ?? {})[0]
    analyses.push({
      providerID: provider.id,
      name: provider.name || provider.id,
      npm: firstModel?.api?.npm,
      source: provider.source,
      connected: true,
      isDefaultProvider: defaults[provider.id] !== undefined,
      modelCount: Object.keys(provider.models ?? {}).length,
      editedModelCount,
      edited: providerEdited || editedModelCount > 0,
    })
  }
  analyses.sort((a, b) => {
    if (a.edited !== b.edited) return a.edited ? -1 : 1
    if (a.isDefaultProvider !== b.isDefaultProvider) return a.isDefaultProvider ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return analyses
}

export function bodyOneLine(body: Record<string, unknown> | undefined, max = 60): string {
  if (!body) return ""
  const text = stableStringify(body)
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}
