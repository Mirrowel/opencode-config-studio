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
 * Groups tools by source: unmatched tools land in "builtin", MCP tools in a
 * group per server (longest server-prefix match wins - server names may
 * contain underscores themselves).
 */
export function groupToolsBySource(tools: StudioTool[], serverIds: string[]): ToolGroup[] {
  const prefixes = serverIds
    .map((id) => ({ id, prefix: `${sanitizeMcpName(id)}_` }))
    .sort((a, b) => b.prefix.length - a.prefix.length)
  const builtin: StudioTool[] = []
  const perServer = new Map<string, StudioTool[]>()
  for (const id of serverIds) perServer.set(id, [])
  for (const tool of tools) {
    const hit = prefixes.find((entry) => tool.id.startsWith(entry.prefix))
    if (hit) perServer.get(hit.id)?.push(tool)
    else builtin.push(tool)
  }
  const groups: ToolGroup[] = []
  if (builtin.length > 0) groups.push({ source: "builtin", title: "Built-in tools", tools: [...builtin].sort((a, b) => a.id.localeCompare(b.id)) })
  for (const id of [...serverIds].sort((a, b) => a.localeCompare(b))) {
    const list = perServer.get(id) ?? []
    if (list.length === 0) continue
    groups.push({ source: id, title: `MCP server: ${id}`, tools: [...list].sort((a, b) => a.id.localeCompare(b.id)) })
  }
  return groups
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

/**
 * Fetches the live tool inventory. `modelRef` ("provider/model") selects the
 * tool visibility for Tool.list; any valid default works. Fails soft: ids
 * fallback, then an empty bundle.
 */
export async function fetchToolBundle(api: TuiPluginApi, modelRef: string | undefined): Promise<ToolBundle> {
  const tool = toolNamespace(api)
  if (!tool) return emptyToolBundle("Tool API unavailable in this OpenCode version")
  const status = await fetchMcpStatus(api)
  const serverIds = Object.keys(status ?? {})
  const [provider, model] = (modelRef ?? "").split("/")

  const list = tool["list"]
  if (typeof list === "function" && provider && model) {
    const result = await fetchWithTimeout(() => (list as (args: unknown) => Promise<unknown>).call(tool, { query: { provider, model } }))
    const data = result && typeof result === "object" ? (result as { data?: unknown }).data : undefined
    if (Array.isArray(data)) {
      const tools: StudioTool[] = []
      for (const item of data) {
        if (!item || typeof item !== "object") continue
        const record = item as { id?: unknown; description?: unknown; parameters?: unknown }
        if (typeof record.id !== "string") continue
        tools.push({ id: record.id, description: typeof record.description === "string" ? record.description : "", parameters: record.parameters })
      }
      return { tools, groups: groupToolsBySource(tools, serverIds), mode: "live", serverIds, statuses: status }
    }
  }

  const ids = tool["ids"]
  if (typeof ids === "function") {
    const result = await fetchWithTimeout(() => (ids as (args?: unknown) => Promise<unknown>).call(tool))
    const data = result && typeof result === "object" ? (result as { data?: unknown }).data : undefined
    if (Array.isArray(data)) {
      const tools: StudioTool[] = data.filter((id): id is string => typeof id === "string").map((id) => ({ id, description: "" }))
      return { tools, groups: groupToolsBySource(tools, serverIds), mode: "ids", serverIds, statuses: status, note: "Tool details unavailable in this OpenCode version (ids only)" }
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

export async function getToolBundle(api: TuiPluginApi, modelRef: string | undefined): Promise<ToolBundle> {
  if (toolCache && Date.now() - toolCache.at < TOOL_CACHE_TTL) return toolCache.bundle
  const bundle = await fetchToolBundle(api, modelRef)
  toolCache = { at: Date.now(), bundle }
  return bundle
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
