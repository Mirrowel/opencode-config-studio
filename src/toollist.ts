import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

/**
 * Live tool inventory for the MCP manager and the permission editor.
 *
 * Data sources (all receiver-preserving, feature-detected, fail-soft):
 * - Tool.list({provider, model}) -> [{id, description, parameters(JSON schema)}]
 * - Tool.ids()                   -> string[] (fallback when list is unavailable)
 * - Mcp.status()                 -> per-server runtime state (server ids)
 *
 * MCP tool ids follow `sanitize(serverName) + "_" + sanitize(toolName)`
 * (OpenCode mcp/catalog.ts), so tools group by longest matching server
 * prefix; everything unmatched is treated as built-in.
 */

export type StudioTool = { id: string; description: string; parameters?: unknown }

export type ToolGroup = {
  /** "builtin" or the MCP server id. */
  source: string
  title: string
  tools: StudioTool[]
}

export type ToolBundle = {
  tools: StudioTool[]
  groups: ToolGroup[]
  /** "live" = full list with parameters, "ids" = ids only, "none" = unavailable. */
  mode: "live" | "ids" | "none"
  /** MCP server ids known at runtime (status keys). */
  serverIds: string[]
  /** Runtime status per server (connected/failed/disabled/needs-auth) when available. */
  statuses: Record<string, { status?: unknown; error?: unknown }> | undefined
  /** Human-readable fetch note for [i]/empty-state rendering. */
  note?: string
}

export function emptyToolBundle(note?: string): ToolBundle {
  return { tools: [], groups: [], mode: "none", serverIds: [], statuses: undefined, note }
}

/** Mirrors OpenCode mcp/catalog.ts sanitize(). */
export function sanitizeMcpName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_")
}

/**
 * Canonical OpenCode built-in tool ids (from the tool sources: shell, edit,
 * read, write, glob, grep, list, patch, apply_patch, todo, webfetch,
 * websearch, task, question, skill, lsp, plan, probe). Everything else that
 * is not MCP-prefixed is treated as a plugin-registered tool. Best-effort:
 * new built-ins simply show under "Plugin tools" until this list is updated.
 */
export const KNOWN_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "edit",
  "read",
  "write",
  "glob",
  "grep",
  "list",
  "patch",
  "apply_patch",
  "applypatch",
  "todowrite",
  "todoread",
  "todo",
  "task",
  "webfetch",
  "websearch",
  "question",
  "skill",
  "lsp",
  "plan",
  "probe",
  "code_mode",
])

/**
 * Groups registry tools: unmatched ids split into built-ins (known set) and
 * plugin-registered tools. `serverIds` prefix-matching only EXCLUDES
 * MCP-prefixed ids from the plugins group (their groups come from the direct
 * probe, which owns MCP data in this generation).
 */
export function groupToolsBySource(tools: StudioTool[], serverIds: string[]): ToolGroup[] {
  const prefixes = serverIds
    .map((id) => ({ id, prefix: `${sanitizeMcpName(id)}_` }))
    .sort((a, b) => b.prefix.length - a.prefix.length)
  const builtin: StudioTool[] = []
  const plugins: StudioTool[] = []
  for (const tool of tools) {
    if (prefixes.some((entry) => tool.id.startsWith(entry.prefix))) continue
    if (KNOWN_BUILTIN_TOOLS.has(tool.id)) builtin.push(tool)
    else plugins.push(tool)
  }
  const groups: ToolGroup[] = []
  if (builtin.length > 0) groups.push({ source: "builtin", title: "Built-in tools", tools: [...builtin].sort((a, b) => a.id.localeCompare(b.id)) })
  if (plugins.length > 0) groups.push({ source: "plugins", title: `Plugin tools (${plugins.length})`, tools: [...plugins].sort((a, b) => a.id.localeCompare(b.id)) })
  return groups
}

/** Appends one group per successfully probed MCP server. */
export function appendProbeGroups(groups: ToolGroup[], probes: Record<string, import("./mcpprobe.js").McpProbeResult>): ToolGroup[] {
  const out = [...groups]
  for (const name of Object.keys(probes).sort((a, b) => a.localeCompare(b))) {
    const probe = probes[name]
    if (probe?.status !== "ok" || probe.tools.length === 0) continue
    out.push({
      source: `mcp:${name}`,
      title: `MCP server: ${name}`,
      tools: probe.tools.map((tool) => ({ id: tool.runtimeId, description: tool.description, parameters: tool.inputSchema })),
    })
  }
  return out
}

type McpStatusLike = { status?: unknown; error?: unknown }

/** Runtime status for each MCP server; feature-detected, receiver-safe, fail-soft. */
export async function fetchMcpStatus(api: TuiPluginApi): Promise<Record<string, McpStatusLike> | undefined> {
  const client = (api as { client?: unknown }).client
  if (!client || typeof client !== "object") return undefined
  const mcp = (client as { mcp?: unknown }).mcp
  if (!mcp || typeof mcp !== "object") return undefined
  const status = (mcp as Record<string, unknown>)["status"]
  if (typeof status !== "function") return undefined
  try {
    const result = await Promise.race([
      (status as (args?: unknown) => Promise<unknown>).call(mcp) as Promise<unknown>,
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), 5000)
        ;(timer as { unref?: () => void }).unref?.()
      }),
    ])
    if (!result || typeof result !== "object") return undefined
    const data = (result as { data?: unknown }).data
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined
    return data as Record<string, McpStatusLike>
  } catch {
    return undefined
  }
}

/** Human label for a McpStatus entry. */
export function mcpStatusLabel(state: McpStatusLike | undefined): { label: string; error?: string; kind: "connected" | "disabled" | "failed" | "auth" | "unknown" } {
  const status = state?.status
  if (status === "connected") return { label: "connected", kind: "connected" }
  if (status === "disabled") return { label: "disabled", kind: "disabled" }
  if (status === "failed") return { label: "failed", error: typeof state?.error === "string" ? state.error : undefined, kind: "failed" }
  if (status === "needs_auth") return { label: "needs auth", kind: "auth" }
  if (status === "needs_client_registration") return { label: "needs client registration", error: typeof state?.error === "string" ? state.error : undefined, kind: "auth" }
  return { label: "unknown", kind: "unknown" }
}

async function fetchWithTimeout(value: () => Promise<unknown>): Promise<unknown> {
  try {
    return await Promise.race([
      value(),
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), 5000)
        ;(timer as { unref?: () => void }).unref?.()
      }),
    ])
  } catch {
    return undefined
  }
}

function toolNamespace(api: TuiPluginApi): Record<string, unknown> | undefined {
  const client = (api as { client?: unknown }).client
  if (!client || typeof client !== "object") return undefined
  const tool = (client as { tool?: unknown }).tool
  if (!tool || typeof tool !== "object") return undefined
  return tool as Record<string, unknown>
}

/** Accepts both the {data} envelope and a raw response body. */
function unwrapPayload(result: unknown): unknown {
  if (!result || typeof result !== "object") return undefined
  const record = result as { data?: unknown }
  if (record.data !== undefined) return record.data
  return result
}

/**
 * Fetches the live tool inventory. `modelRef` ("provider/model") selects the
 * tool visibility for Tool.list; any valid default works. Fails soft: ids
 * fallback, then an empty bundle.
 *
 * Param shapes differ across client generations: the v2 client (what current
 * OpenCode injects into plugins) takes FLAT `{provider, model}` query args;
 * the v1-era client took `{query: {...}}`. Both are attempted.
 */
export async function fetchToolBundle(api: TuiPluginApi, modelRef: string | undefined, probes?: Record<string, import("./mcpprobe.js").McpProbeResult>): Promise<ToolBundle> {
  const tool = toolNamespace(api)
  if (!tool) return emptyToolBundle("Tool API unavailable in this OpenCode version")
  const status = await fetchMcpStatus(api)
  const serverIds = Object.keys(status ?? {})
  const [provider, model] = (modelRef ?? "").split("/")

  const list = tool["list"]
  if (typeof list === "function" && provider && model) {
    // v2 shape (flat query args) first - matches the current plugin client.
    let result = await fetchWithTimeout(() => (list as (args: unknown) => Promise<unknown>).call(tool, { provider, model }))
    let data = unwrapPayload(result)
    if (!Array.isArray(data)) {
      // v1-era shape (nested query object) fallback.
      result = await fetchWithTimeout(() => (list as (args: unknown) => Promise<unknown>).call(tool, { query: { provider, model } }))
      data = unwrapPayload(result)
    }
    if (Array.isArray(data)) {
      const tools: StudioTool[] = []
      for (const item of data) {
        if (!item || typeof item !== "object") continue
        const record = item as { id?: unknown; description?: unknown; parameters?: unknown }
        if (typeof record.id !== "string") continue
        tools.push({ id: record.id, description: typeof record.description === "string" ? record.description : "", parameters: record.parameters })
      }
      return { tools, groups: appendProbeGroups(groupToolsBySource(tools, serverIds), probes ?? {}), mode: "live", serverIds, statuses: status }
    }
  }

  const ids = tool["ids"]
  if (typeof ids === "function") {
    const result = await fetchWithTimeout(() => (ids as (args?: unknown) => Promise<unknown>).call(tool))
    const data = unwrapPayload(result)
    if (Array.isArray(data)) {
      const tools: StudioTool[] = data.filter((id): id is string => typeof id === "string").map((id) => ({ id, description: "" }))
      return { tools, groups: appendProbeGroups(groupToolsBySource(tools, serverIds), probes ?? {}), mode: "ids", serverIds, statuses: status, note: "Tool details unavailable in this OpenCode version (ids only)" }
    }
  }

  return emptyToolBundle("Could not load the tool list from OpenCode")
}

// ---------------------------------------------------------------------------
// Per-process cache (studio opens reuse the tool list; TTL keeps it fresh)
// ---------------------------------------------------------------------------

let toolCache: { at: number; bundle: ToolBundle } | undefined
const TOOL_CACHE_TTL = 5 * 60 * 1000

export function clearToolCache(): void {
  toolCache = undefined
}

export async function getToolBundle(api: TuiPluginApi, modelRef: string | undefined, probes?: Record<string, import("./mcpprobe.js").McpProbeResult>): Promise<ToolBundle> {
  if (toolCache && Date.now() - toolCache.at < TOOL_CACHE_TTL) {
    // Groups merge live probe data even on a registry cache hit.
    return probes ? { ...toolCache.bundle, groups: appendProbeGroups(toolCache.bundle.groups.filter((group) => !group.source.startsWith("mcp:")), probes) } : toolCache.bundle
  }
  const bundle = await fetchToolBundle(api, modelRef, probes)
  toolCache = { at: Date.now(), bundle: probes ? { ...bundle, groups: bundle.groups.filter((group) => !group.source.startsWith("mcp:")) } : bundle }
  return bundle
}

// ---------------------------------------------------------------------------
// File/runtime MCP source union (runtime entries are contributed by plugin
// config() hooks or OPENCODE_CONFIG and are invisible in config files)
// ---------------------------------------------------------------------------

export type McpSourceRow = {
  name: string
  /** Merged-file entry (from discovered config layers), when present. */
  file: Record<string, unknown> | undefined
  /** Runtime entry from api.state.config.mcp, when present. */
  runtime: Record<string, unknown> | undefined
  status: McpStatusLike | undefined
  /** Entry used for probing: file entry with a server type wins, else runtime. */
  effective: Record<string, unknown> | undefined
  /** "file" = editable config entry; "runtime" = plugin/env contributed; "overlay" = partial file entry. */
  kind: "file" | "runtime" | "overlay"
  runtimeOnly: boolean
}

function hasServerType(entry: Record<string, unknown> | undefined): boolean {
  return entry?.["type"] === "local" || entry?.["type"] === "remote"
}

/**
 * Unions file config, runtime config, and runtime status keys into rows.
 * File entries own editing; runtime entries own probe data for
 * runtime-contributed servers (e.g. plugins registering MCP via config()).
 */
export function mergeMcpSources(
  fileMcp: Record<string, unknown> | undefined,
  runtimeMcp: Record<string, unknown> | undefined,
  statusKeys: string[] | undefined,
): McpSourceRow[] {
  const names = new Set<string>([...Object.keys(fileMcp ?? {}), ...Object.keys(runtimeMcp ?? {}), ...(statusKeys ?? [])])
  const rows: McpSourceRow[] = []
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const file = fileMcp?.[name]
    const runtime = runtimeMcp?.[name]
    const fileEntry = file && typeof file === "object" && !Array.isArray(file) ? (file as Record<string, unknown>) : undefined
    const runtimeEntry = runtime && typeof runtime === "object" && !Array.isArray(runtime) ? (runtime as Record<string, unknown>) : undefined
    const kind: McpSourceRow["kind"] = fileEntry === undefined ? "runtime" : hasServerType(fileEntry) ? "file" : "overlay"
    const effective = hasServerType(fileEntry) ? fileEntry : hasServerType(runtimeEntry) ? runtimeEntry : undefined
    rows.push({ name, file: fileEntry, runtime: runtimeEntry, status: undefined, effective, kind, runtimeOnly: fileEntry === undefined })
  }
  return rows
}

/** Renders a headers map with values masked (`Authorization: (set)`). */
export function maskSecretHeaders(entry: Record<string, unknown> | undefined): string {
  const headers = entry?.["headers"]
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return "(not set)"
  const keys = Object.keys(headers as Record<string, unknown>)
  if (keys.length === 0) return "(empty)"
  return keys.map((key) => `${key}: (set)`).join(", ")
}

// ---------------------------------------------------------------------------
// Parameter schema rendering
// ---------------------------------------------------------------------------

/** Flattens a JSON-schema-like parameters object into readable lines. */
export function describeToolParameters(parameters: unknown): string[] {
  if (!parameters || typeof parameters !== "object") return []
  const schema = parameters as { type?: unknown; properties?: unknown; required?: unknown; description?: unknown }
  const lines: string[] = []
  if (typeof schema.description === "string" && schema.description.length > 0) lines.push(schema.description, "")
  const properties = schema.properties
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]).filter((entry): entry is string => typeof entry === "string") : [])
    const entries = Object.entries(properties as Record<string, unknown>)
    if (entries.length === 0) lines.push("(no parameters)")
    for (const [name, raw] of entries) {
      const prop = raw && typeof raw === "object" ? (raw as { type?: unknown; description?: unknown; enum?: unknown }) : {}
      const type = Array.isArray(prop.type) ? prop.type.join(" | ") : typeof prop.type === "string" ? prop.type : "?"
      const flag = required.has(name) ? "required" : "optional"
      lines.push(`  ${name} (${type}, ${flag})`)
      if (typeof prop.description === "string" && prop.description.length > 0) lines.push(`    ${truncateLine(prop.description, 100)}`)
      if (Array.isArray(prop.enum) && prop.enum.length > 0) lines.push(`    values: ${prop.enum.map((entry) => JSON.stringify(entry)).join(", ").slice(0, 120)}`)
    }
  } else if (typeof schema.type === "string" && schema.type !== "object") {
    lines.push(`(parameters: ${schema.type})`)
  }
  return lines
}

function truncateLine(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Rich [i] body for a tool: description, parameters, raw schema. */
export function toolInfoText(tool: StudioTool, rule?: string): string {
  const lines: string[] = [`Tool: ${tool.id}`]
  if (rule !== undefined) lines.push(`Permission rule: ${rule}`)
  lines.push("")
  lines.push("Description:")
  lines.push(tool.description.length > 0 ? tool.description : "(none provided)")
  const params = describeToolParameters(tool.parameters)
  if (params.length > 0) {
    lines.push("")
    lines.push("Parameters:")
    lines.push(...params)
  }
  if (tool.parameters !== undefined) {
    lines.push("")
    lines.push("Raw schema:")
    lines.push(JSON.stringify(tool.parameters, null, 2).split("\n").map((line) => `  ${line}`).join("\n"))
  }
  return lines.join("\n")
}
