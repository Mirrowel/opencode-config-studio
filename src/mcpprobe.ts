import { spawn, type ChildProcess } from "node:child_process"
import path from "node:path"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

/**
 * MCP tool inventory via direct protocol probes.
 *
 * OpenCode's tool registry never contains MCP tools (they attach per session
 * at prompt time), and no HTTP surface lists them - so the studio speaks the
 * MCP JSON-RPC subset itself:
 * - local servers: spawn the configured command, newline-delimited JSON-RPC
 *   over stdio (initialize -> notifications/initialized -> tools/list)
 * - remote servers: streamable HTTP POST (session header, SSE or JSON body)
 *
 * Tool runtime ids = sanitize(server) + "_" + sanitize(tool name) - exactly
 * the names the model sees (OpenCode mcp/catalog.ts).
 */

export type McpProbeTool = {
  /** Tool name as reported by the server. */
  name: string
  /** The model-visible runtime id (server-prefixed). */
  runtimeId: string
  description: string
  inputSchema?: unknown
}

export type McpProbeResult =
  | { status: "ok"; tools: McpProbeTool[]; serverName?: string; serverVersion?: string; at: number }
  | { status: "auth"; hint?: string; at: number }
  | { status: "failed"; error: string; at: number }

/** Mirrors OpenCode mcp/catalog.ts sanitize(). */
export function sanitizeMcpId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_")
}

export function mcpRuntimeToolId(server: string, tool: string): string {
  return `${sanitizeMcpId(server)}_${sanitizeMcpId(tool)}`
}

const PROTOCOL_VERSION = "2025-03-26"
const CLIENT_INFO = { name: "opencode-config-studio", version: "0.5.0" }
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_LIST_PAGES = 100

type McpConfigEntry = Record<string, unknown>

/** Expands ${VAR} (and $VAR) from process.env, mirroring config semantics. */
function expandEnvValue(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, plain) => {
    const name = braced ?? plain
    const found = env[name]
    return found === undefined ? match : found
  })
}

function expandEnvMap(map: Record<string, unknown> | undefined, env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(map ?? {})) {
    if (typeof value === "string") result[key] = expandEnvValue(value, env)
    else if (typeof value === "number" || typeof value === "boolean") result[key] = String(value)
  }
  return result
}

/** Effective env for a local server: process.env overlaid with the entry. */
export function localServerEnv(entry: McpConfigEntry): Record<string, string> {
  return expandEnvMap(entry["environment"] as Record<string, unknown> | undefined, process.env as Record<string, string | undefined>)
}

let nextRequestId = 1

type JsonRpcResponse = { id?: number | string | null; result?: unknown; error?: { message?: string } }

/**
 * Probes one MCP server for its tool list. Never throws - failures come back
 * as { status: "failed", error }.
 */
export async function probeMcpServer(api: TuiPluginApi | undefined, name: string, entry: McpConfigEntry): Promise<McpProbeResult> {
  const timeout = typeof entry["timeout"] === "number" && entry["timeout"] > 0 ? Math.min(entry["timeout"], 30_000) : DEFAULT_TIMEOUT_MS
  try {
    if (entry["type"] === "remote") return await probeRemote(name, entry, timeout)
    if (entry["type"] === "local") return await probeLocal(api, name, entry, timeout)
    return { status: "failed", error: "entry is not a local or remote server (partial overlay?)", at: Date.now() }
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error), at: Date.now() }
  }
}

// ---------------------------------------------------------------------------
// Local stdio probe
// ---------------------------------------------------------------------------

async function probeLocal(api: TuiPluginApi | undefined, name: string, entry: McpConfigEntry, timeout: number, shellRetry = true): Promise<McpProbeResult> {
  const command = entry["command"]
  if (!Array.isArray(command) || command.length === 0 || typeof command[0] !== "string") {
    return { status: "failed", error: "no command configured", at: Date.now() }
  }
  const args = command.slice(1).filter((arg): arg is string => typeof arg === "string")
  const env = localServerEnv(entry)
  const cwdValue = typeof entry["cwd"] === "string" ? entry["cwd"] : undefined
  const baseDir = (api as { state?: { path?: { directory?: string } } } | undefined)?.state?.path?.directory
  const cwd = cwdValue !== undefined && baseDir ? path.resolve(baseDir, cwdValue) : cwdValue
  const spawnOptions: import("node:child_process").SpawnOptions = { env: { ...process.env, ...env }, ...(cwd ? { cwd } : {}), stdio: ["pipe", "pipe", "pipe"] }

  let child: ChildProcess | undefined
  let usedShell = false
  const stderrChunks: string[] = []
  const pending = new Map<number, { resolve: (value: JsonRpcResponse) => void; reject: (error: Error) => void }>()

  const send = (payload: unknown) => {
    if (!child?.stdin || child.stdin.destroyed) return
    child.stdin.write(`${JSON.stringify(payload)}\n`)
  }
  const request = (method: string, params?: unknown) => {
    const id = nextRequestId++
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  const deadline = Date.now() + timeout
  const remaining = () => Math.max(0, deadline - Date.now())
  let timer: NodeJS.Timeout | undefined
  const armTimeout = (onTimeout: () => void) => {
    clearTimeout(timer)
    timer = setTimeout(onTimeout, remaining())
    ;(timer as { unref?: () => void }).unref?.()
  }

  const failPending = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  }

  try {
    let spawnError: Error | undefined
    let sawResponse = false
    try {
      child = spawn(command[0], args, spawnOptions)
    } catch (error) {
      spawnError = error instanceof Error ? error : new Error(String(error))
    }
    if (!child) {
      // Windows .cmd/.bat resolution or direct-spawn rejection: retry via shell.
      const joined = [command[0], ...args].map((token) => (/[^\w./:-]/.test(token) ? `"${token.replaceAll('"', "")}"` : token)).join(" ")
      usedShell = true
      try {
        child = spawn(joined, { ...spawnOptions, shell: true })
      } catch (error) {
        return { status: "failed", error: `spawn failed: ${spawnError?.message ?? ""}; shell retry: ${error instanceof Error ? error.message : String(error)}`, at: Date.now() }
      }
    }

    let buffer = ""
    child?.stdout?.setEncoding("utf8")
    child?.stdout?.on("data", (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf("\n")
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.length > 0) {
          try {
            const message = JSON.parse(line) as JsonRpcResponse
            if (message.id !== undefined && message.id !== null) {
              sawResponse = true
              const waiter = pending.get(Number(message.id))
              if (waiter) {
                pending.delete(Number(message.id))
                waiter.resolve(message)
              }
            }
          } catch {
            // Non-JSON stdout noise from the server - ignore.
          }
        }
        newline = buffer.indexOf("\n")
      }
    })
    child?.stderr?.setEncoding("utf8")
    child?.stderr?.on("data", (chunk: string) => {
      if (stderrChunks.join("").length < 400) stderrChunks.push(chunk)
    })
    const exited = new Promise<void>((resolve) => {
      child?.once("exit", () => resolve())
    })
    // Async spawn failures (ENOENT/EINVAL) arrive as 'error' events - fail
    // soft, and retry once via shell when nothing was received yet.
    const spawnFailure = new Promise<Error>((resolve) => {
      child?.once("error", (error: Error) => resolve(error))
    })

    const timeoutError = () => {
      failPending(new Error(`probe timed out after ${timeout}ms`))
    }
    armTimeout(timeoutError)

    const init = await Promise.race([
      request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }),
      exited.then(() => Promise.reject(new Error(`server exited before responding${stderrText(stderrChunks)}`))),
      spawnFailure.then((error) =>
        Promise.reject(
          new SpawnError(error.message, { shellRetry: !usedShell && !sawResponse && shellRetry, stderr: stderrText(stderrChunks) }),
        ),
      ),
    ]).catch(async (error: unknown) => {
      if (error instanceof SpawnError && error.retryViaShell) {
        const joined = [command[0], ...args].map((token) => (/[^\w./:-]/.test(token) ? `"${token.replaceAll('"', "")}"` : token)).join(" ")
        return await probeLocal(api, name, { ...entry, command: [joined] }, timeout, false)
      }
      throw error
    })
    if ("status" in init) return init
    if (init.error) throw new Error(`initialize failed: ${init.error.message ?? "unknown error"}`)
    const info = init.result as { serverInfo?: { name?: string; version?: string } } | undefined
    send({ jsonrpc: "2.0", method: "notifications/initialized" })

    // tools/list with cursor pagination.
    const tools: McpProbeTool[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const list = await Promise.race([request("tools/list", cursor === undefined ? {} : { cursor }), exited.then(() => Promise.reject(new Error("server exited during tools/list")))])
      if (list.error) throw new Error(`tools/list failed: ${list.error.message ?? "unknown error"}`)
      const result = list.result as { tools?: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown }>; nextCursor?: unknown } | undefined
      for (const tool of result?.tools ?? []) {
        if (typeof tool?.name !== "string") continue
        tools.push({
          name: tool.name,
          runtimeId: mcpRuntimeToolId(name, tool.name),
          description: typeof tool.description === "string" ? tool.description : "",
          inputSchema: tool.inputSchema,
        })
      }
      if (typeof result?.nextCursor !== "string" || result.nextCursor === cursor) break
      cursor = result.nextCursor
    }

    return {
      status: "ok",
      tools: tools.sort((a, b) => a.runtimeId.localeCompare(b.runtimeId)),
      ...(info?.serverInfo?.name ? { serverName: info.serverInfo.name } : {}),
      ...(info?.serverInfo?.version ? { serverVersion: info.serverInfo.version } : {}),
      at: Date.now(),
    }
  } finally {
    clearTimeout(timer)
    for (const waiter of pending.values()) waiter.reject(new Error("probe closed"))
    pending.clear()
    try {
      child?.stdin?.end()
    } catch {
      // Already closed.
    }
    const kill = child
    if (kill && kill.exitCode === null && !kill.killed) {
      kill.kill()
      setTimeout(() => {
        if (kill.exitCode === null && !kill.killed) kill.kill("SIGKILL")
      }, 2000).unref?.()
    }
  }
}

function stderrText(chunks: string[]): string {
  const text = chunks.join("").trim()
  if (text.length === 0) return ""
  return ` (${text.slice(-200).replace(/\s+/g, " ")})`
}

/** Spawn failure marker carrying the retry decision for probeLocal. */
class SpawnError extends Error {
  readonly retryViaShell: boolean
  readonly stderrSuffix: string
  constructor(message: string, options: { shellRetry: boolean; stderr: string }) {
    super(`${message}${options.stderr}`)
    this.retryViaShell = options.shellRetry
    this.stderrSuffix = options.stderr
  }
}

// ---------------------------------------------------------------------------
// Remote streamable-HTTP probe
// ---------------------------------------------------------------------------

type HttpProbeContext = { url: string; headers: Record<string, string>; sessionId?: string }

async function rpcOverHttp(ctx: HttpProbeContext, method: string, params?: unknown, id?: number): Promise<{ status: number; json?: JsonRpcResponse; text: string; headers: Headers }> {
  const response = await fetch(ctx.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(ctx.sessionId ? { "mcp-session-id": ctx.sessionId } : {}),
      ...ctx.headers,
    },
    body: JSON.stringify(id === undefined ? { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) } : { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
  })
  const text = await response.text()
  let json: JsonRpcResponse | undefined
  const contentType = response.headers.get("content-type") ?? ""
  if (contentType.includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("")
      if (data.length === 0) continue
      try {
        const parsed = JSON.parse(data) as JsonRpcResponse
        if (parsed.id !== undefined && parsed.id !== null) {
          json = parsed
          break
        }
      } catch {
        // Skip keep-alive comments and non-JSON events.
      }
    }
  } else if (text.trim().length > 0) {
    try {
      json = JSON.parse(text) as JsonRpcResponse
    } catch {
      // Non-JSON body - surfaced as text.
    }
  }
  return { status: response.status, json, text, headers: response.headers }
}

async function probeRemote(name: string, entry: McpConfigEntry, timeout: number): Promise<McpProbeResult> {
  const rawUrl = entry["url"]
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return { status: "failed", error: "no url configured", at: Date.now() }
  const env = process.env as Record<string, string | undefined>
  const url = expandEnvValue(rawUrl, env)
  const headers = expandEnvMap(entry["headers"] as Record<string, unknown> | undefined, env)

  const withTimeout = async <T>(work: Promise<T>): Promise<T> => {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`probe timed out after ${timeout}ms`)), timeout)
        ;(timer as { unref?: () => void }).unref?.()
      }),
    ])
  }

  const ctx: HttpProbeContext = { url, headers }
  const init = await withTimeout(rpcOverHttp(ctx, "initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, nextRequestId++))
  if (init.status === 401 || init.status === 403) {
    return { status: "auth", ...(init.headers.get("www-authenticate") ? { hint: init.headers.get("www-authenticate") ?? undefined } : {}), at: Date.now() }
  }
  if (init.status >= 400 || !init.json || init.json.error) {
    return { status: "failed", error: `initialize failed (HTTP ${init.status})${init.json?.error?.message ? `: ${init.json.error.message}` : init.text.slice(0, 160)}`, at: Date.now() }
  }
  const sessionId = init.headers.get("mcp-session-id") ?? undefined
  if (sessionId) ctx.sessionId = sessionId
  const info = init.json.result as { serverInfo?: { name?: string; version?: string } } | undefined

  await withTimeout(rpcOverHttp(ctx, "notifications/initialized"))

  const tools: McpProbeTool[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const list = await withTimeout(rpcOverHttp(ctx, "tools/list", cursor === undefined ? {} : { cursor }, nextRequestId++))
    if (list.status === 401 || list.status === 403) return { status: "auth", at: Date.now() }
    if (!list.json || list.json.error) {
      return { status: "failed", error: `tools/list failed (HTTP ${list.status})${list.json?.error?.message ? `: ${list.json.error.message}` : list.text.slice(0, 160)}`, at: Date.now() }
    }
    const result = list.json.result as { tools?: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown }>; nextCursor?: unknown } | undefined
    for (const tool of result?.tools ?? []) {
      if (typeof tool?.name !== "string") continue
      tools.push({ name: tool.name, runtimeId: mcpRuntimeToolId(name, tool.name), description: typeof tool.description === "string" ? tool.description : "", inputSchema: tool.inputSchema })
    }
    if (typeof result?.nextCursor !== "string" || result.nextCursor === cursor) break
    cursor = result.nextCursor
  }
  return {
    status: "ok",
    tools: tools.sort((a, b) => a.runtimeId.localeCompare(b.runtimeId)),
    ...(info?.serverInfo?.name ? { serverName: info.serverInfo.name } : {}),
    ...(info?.serverInfo?.version ? { serverVersion: info.serverInfo.version } : {}),
    at: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Cache (60 min TTL; invalidated by config hash and manual refetch)
// ---------------------------------------------------------------------------

export const MCP_PROBE_TTL_MS = 60 * 60 * 1000

function configFingerprint(entry: McpConfigEntry): string {
  const keys = ["type", "command", "url", "environment", "headers", "cwd", "timeout", "enabled"]
  const parts: string[] = []
  for (const key of keys) {
    const value = entry[key]
    if (value === undefined) continue
    parts.push(`${key}=${JSON.stringify(value)}`)
  }
  return parts.join("|")
}

type CacheEntry = { fingerprint: string; at: number; result: McpProbeResult }

const probeCache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<McpProbeResult>>()
const runningFingerprints = new Map<string, string>()

export function cachedMcpProbe(name: string, entry: McpConfigEntry | undefined): McpProbeResult | undefined {
  if (!entry) return undefined
  const hit = probeCache.get(name)
  if (!hit) return undefined
  if (hit.fingerprint !== configFingerprint(entry)) return undefined
  if (Date.now() - hit.at > MCP_PROBE_TTL_MS) return undefined
  return hit.result
}

/** Probes one server unless a fresh cache entry exists. Concurrent callers share one probe. */
export function getMcpProbe(api: TuiPluginApi | undefined, name: string, entry: McpConfigEntry, options?: { force?: boolean }): Promise<McpProbeResult> {
  if (!options?.force) {
    const cached = cachedMcpProbe(name, entry)
    if (cached) return Promise.resolve(cached)
    const running = inflight.get(name)
    if (running && configFingerprint(entry) === (probeCache.get(name)?.fingerprint ?? runningFingerprints.get(name))) {
      // An identical probe is already in flight - share it.
      return running
    }
  }
  const fingerprint = configFingerprint(entry)
  runningFingerprints.set(name, fingerprint)
  const work = probeMcpServer(api, name, entry)
    .then((result) => {
      probeCache.set(name, { fingerprint, at: Date.now(), result })
      return result
    })
    .finally(() => {
      inflight.delete(name)
      runningFingerprints.delete(name)
    })
  inflight.set(name, work)
  return work
}

export function clearMcpProbeCache(): void {
  probeCache.clear()
  inflight.clear()
  runningFingerprints.clear()
}

/** All cached probe results (snapshot for rendering). */
export function mcpProbeSnapshot(): Record<string, McpProbeResult> {
  const out: Record<string, McpProbeResult> = {}
  for (const [name, entry] of probeCache) out[name] = entry.result
  return out
}

/**
 * Auto-probes every enabled server (config enabled !== false and runtime
 * status not disabled). Concurrency-capped; failures are cached with their
 * error so the UI can show "unknown" instead of a wrong 0.
 */
export async function autoProbeEnabledServers(api: TuiPluginApi | undefined, mcpConfig: Record<string, unknown> | undefined, statuses: Record<string, { status?: unknown }> | undefined): Promise<void> {
  const targets: Array<[string, McpConfigEntry]> = []
  for (const [name, entry] of Object.entries(mcpConfig ?? {})) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const object = entry as McpConfigEntry
    if (object["type"] !== "local" && object["type"] !== "remote") continue
    if (object["enabled"] === false) continue
    if (statuses?.[name]?.status === "disabled") continue
    targets.push([name, object])
  }
  const queue = [...targets]
  const workers = Array.from({ length: Math.min(4, Math.max(1, queue.length)) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift()
      if (!next) break
      await getMcpProbe(api, next[0], next[1]).catch(() => undefined)
    }
  })
  await Promise.all(workers)
}

export const __testMcpProbeInternals = {
  configFingerprint,
  expandEnvValue,
  localServerEnv,
  probeCache,
}
