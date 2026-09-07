/**
 * Request capture sink.
 *
 * Runs OpenCode's full request pipeline against a local HTTP listener without
 * contacting any real provider and without touching any config file:
 *
 *  1. A local listener starts on 127.0.0.1:<ephemeral>.
 *  2. A temporary `opencode serve` process boots in a temp directory with an
 *     inline env config (OPENCODE_CONFIG_CONTENT) that redirects the target
 *     provider's baseURL to the listener and defines a minimal sim agent on
 *     the target model. The provider keeps its real ID and npm package so
 *     base defaults and SDK serialization match reality.
 *  3. A tiny prompt is sent through the HTTP API; the exact request body the
 *     runtime would post is captured and answered with a minimal SSE reply.
 *  4. The session is deleted, the server killed, and the temp dir removed.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { accessSync, constants as fsConstants } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RuntimeModelLike } from "./catalog.js"

export interface SinkCaptureTarget {
  providerID: string
  modelID: string
  runtimeModel: RuntimeModelLike
  providerNpm?: string
  variant?: string
  agentOverrides?: { temperature?: number; top_p?: number; options?: Record<string, unknown> }
}

export interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  bodyText: string
  body: unknown
  at: number
  streamed: boolean
  kind: "anthropic" | "openai" | "other"
}

export interface CaptureRunResult {
  ok: boolean
  error?: string
  logs: string[]
  requests: CapturedRequest[]
  durationMs: number
  serverKilled: boolean
  sessionDeleted: boolean
}

const SERVER_START_TIMEOUT_MS = 45_000
const PROMPT_TIMEOUT_MS = 40_000
const GRACE_MS = 2500

// ---------------------------------------------------------------------------
// Inline config construction
// ---------------------------------------------------------------------------

function cloneConfigModel(model: RuntimeModelLike): Record<string, unknown> {
  const capabilities = (model.capabilities ?? {}) as Record<string, unknown>
  const cost = model.cost as Record<string, unknown> | undefined
  const limit = model.limit as Record<string, unknown> | undefined
  const entry: Record<string, unknown> = {
    name: model.name,
    reasoning: capabilities["reasoning"] ?? model.reasoning ?? false,
    temperature: capabilities["temperature"] ?? true,
    tool_call: capabilities["toolcall"] ?? capabilities["tool_call"] ?? true,
  }
  if (typeof model.family === "string") entry["family"] = model.family
  if (typeof model.release_date === "string") entry["release_date"] = model.release_date
  if (limit && typeof limit["context"] === "number" && typeof limit["output"] === "number") {
    entry["limit"] = { context: limit["context"], output: limit["output"] }
  }
  if (cost && typeof cost["input"] === "number" && typeof cost["output"] === "number") {
    const cache = (cost["cache"] ?? {}) as Record<string, unknown>
    entry["cost"] = {
      input: cost["input"],
      output: cost["output"],
      ...(typeof cache["read"] === "number" ? { cache_read: cache["read"] } : {}),
      ...(typeof cache["write"] === "number" ? { cache_write: cache["write"] } : {}),
    }
  }
  const input = capabilities["input"]
  const output = capabilities["output"]
  if (Array.isArray(input) || Array.isArray(output)) {
    entry["modalities"] = {
      ...(Array.isArray(input) ? { input } : {}),
      ...(Array.isArray(output) ? { output } : {}),
    }
  }
  if (model.options && Object.keys(model.options).length > 0) entry["options"] = model.options
  if (model.variants) entry["variants"] = model.variants
  return entry
}

export function buildInlineConfig(target: SinkCaptureTarget, sinkBaseURL: string): Record<string, unknown> {
  const providerEntry: Record<string, unknown> = {
    options: {
      baseURL: sinkBaseURL,
      apiKey: "config-studio-sink",
    },
    models: {
      [target.modelID]: cloneConfigModel(target.runtimeModel),
    },
  }
  if (target.providerNpm) providerEntry["npm"] = target.providerNpm

  const agentEntry: Record<string, unknown> = {
    model: `${target.providerID}/${target.modelID}`,
    prompt: "You are a request capture probe. Reply with exactly: ok",
    description: "Config Studio capture probe",
  }
  if (target.agentOverrides?.temperature !== undefined) agentEntry["temperature"] = target.agentOverrides.temperature
  if (target.agentOverrides?.top_p !== undefined) agentEntry["top_p"] = target.agentOverrides.top_p
  if (target.agentOverrides?.options) agentEntry["options"] = target.agentOverrides.options

  return {
    model: `${target.providerID}/${target.modelID}`,
    provider: {
      [target.providerID]: providerEntry,
    },
    agent: {
      "config-studio-sim": agentEntry,
    },
  }
}

// ---------------------------------------------------------------------------
// Sink server
// ---------------------------------------------------------------------------

interface SinkState {
  requests: CapturedRequest[]
  server: Server
  port: number
}

function classifyBody(body: unknown): "anthropic" | "openai" | "other" {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>
    if (record["system"] !== undefined && record["max_tokens"] !== undefined) return "anthropic"
    if (Array.isArray(record["messages"])) return "openai"
  }
  return "other"
}

function openaiSSE(model: string, streamed: boolean): { status: number; headers: Record<string, string>; body: string } {
  if (!streamed) {
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "chatcmpl-config-studio",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    }
  }
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-config-studio",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  return {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    body: `${chunk({ role: "assistant", content: "ok" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
  }
}

function anthropicSSE(model: string, streamed: boolean): { status: number; headers: Record<string, string>; body: string } {
  if (!streamed) {
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "msg-config-studio",
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    }
  }
  const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  return {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    body:
      event("message_start", { type: "message_start", message: { id: "msg-config-studio", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }) +
      event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
      event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
      event("content_block_stop", { type: "content_block_stop", index: 0 }) +
      event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }) +
      event("message_stop", { type: "message_stop" }),
  }
}

async function startSink(): Promise<SinkState> {
  const requests: CapturedRequest[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("error", () => {
      res.destroy()
    })
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8")
      let body: unknown
      try {
        body = JSON.parse(bodyText)
      } catch {
        body = undefined
      }
      const kind = classifyBody(body)
      const streamed = body && typeof body === "object" && (body as Record<string, unknown>)["stream"] === true
      requests.push({
        url: req.url ?? "/",
        method: req.method ?? "POST",
        headers: { ...req.headers } as Record<string, string>,
        bodyText,
        body,
        at: Date.now(),
        streamed: Boolean(streamed),
        kind,
      })

      let response: { status: number; headers: Record<string, string>; body: string }
      const bodyModel = body && typeof body === "object" && typeof (body as Record<string, unknown>)["model"] === "string"
        ? ((body as Record<string, unknown>)["model"] as string)
        : "capture"
      if (kind === "anthropic") {
        response = anthropicSSE(bodyModel, Boolean(streamed))
      } else if (kind === "openai") {
        response = openaiSSE(bodyModel, Boolean(streamed))
      } else {
        response = { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true }) }
      }

      res.writeHead(response.status, response.headers)
      res.end(response.body)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("sink listener failed to bind")
  return { requests, server, port: address.port }
}

// ---------------------------------------------------------------------------
// OpenCode binary resolution
// ---------------------------------------------------------------------------

export function resolveOpencodeBinary(): string {
  const execPath = process.execPath.replace(/\.exe$/i, "")
  const base = execPath.split(/[\\/]/).pop() ?? ""
  if (/opencode/i.test(base)) return process.execPath
  const pathVar = process.env["PATH"] ?? ""
  for (const dir of pathVar.split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue
    for (const name of process.platform === "win32" ? ["opencode.exe", "opencode.cmd", "opencode"] : ["opencode"]) {
      const candidate = join(dir, name)
      try {
        accessSync(candidate, fsConstants.X_OK)
        return candidate
      } catch {
        continue
      }
    }
  }
  return "opencode"
}

// ---------------------------------------------------------------------------
// Capture run
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function fetchJSON(url: string, init: RequestInit, timeoutMs: number, logs: string[]): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const text = await response.text()
    if (!response.ok) logs.push(`HTTP ${response.status} ${url}: ${text.slice(0, 300)}`)
    try {
      return JSON.parse(text)
    } catch {
      return { raw: text }
    }
  } finally {
    clearTimeout(timer)
  }
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed) return
  if (process.platform === "win32" && child.pid) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
      return
    } catch {
      // fall through to kill
    }
  }
  try {
    child.kill("SIGKILL")
  } catch {
    // already dead
  }
}

export async function runCapture(target: SinkCaptureTarget): Promise<CaptureRunResult> {
  const started = Date.now()
  const logs: string[] = []
  let sink: SinkState | undefined
  let child: ChildProcess | undefined
  let tempDir: string | undefined
  let sessionDeleted = false
  const pushLog = (line: string) => {
    logs.push(line)
    if (logs.length > 200) logs.splice(0, logs.length - 200)
  }

  try {
    sink = await startSink()
    tempDir = await mkdtemp(join(tmpdir(), "config-studio-"))
    const inlineConfig = buildInlineConfig(target, `http://127.0.0.1:${sink.port}`)

    const binary = resolveOpencodeBinary()
    pushLog(`binary: ${binary}`)
    child = spawn(binary, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
      cwd: tempDir,
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(inlineConfig),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => pushLog(`[out] ${chunk.trimEnd()}`))
    child.stderr?.on("data", (chunk: string) => pushLog(`[err] ${chunk.trimEnd()}`))
    child.on("exit", (code) => pushLog(`server exited: ${code}`))

    const baseUrl = await withTimeout(
      new Promise<string>((resolve, reject) => {
        const onData = (chunk: string) => {
          const match = /listening on (https?:\/\/\S+)/.exec(chunk)
          if (match) {
            child?.stdout?.off("data", onData)
            resolve(match[1]!.replace(/\/$/, ""))
          }
        }
        child!.stdout!.on("data", onData)
        child!.once("exit", (code) => reject(new Error(`server exited before listening (code ${code})`)))
      }),
      SERVER_START_TIMEOUT_MS,
      "server start",
    )
    pushLog(`temp server: ${baseUrl}`)

    const created = (await fetchJSON(
      `${baseUrl}/session`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
      15_000,
      logs,
    )) as Record<string, unknown> | undefined
    const sessionID = created?.["sessionID"] ?? created?.["id"]
    if (typeof sessionID !== "string") throw new Error("failed to create temp session")
    pushLog(`session: ${sessionID}`)

    const promptPayload: Record<string, unknown> = {
      agent: "config-studio-sim",
      model: { providerID: target.providerID, modelID: target.modelID },
      parts: [{ type: "text", text: "Say ok" }],
    }
    if (target.variant) promptPayload["variant"] = target.variant

    try {
      await fetchJSON(
        `${baseUrl}/session/${sessionID}/message`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(promptPayload) },
        PROMPT_TIMEOUT_MS,
        logs,
      )
    } catch (error) {
      pushLog(`prompt error (continuing): ${error instanceof Error ? error.message : String(error)}`)
    }

    // Grace period so background small-model calls (titles) also land.
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS))

    try {
      await fetchJSON(
        `${baseUrl}/session/${sessionID}`,
        { method: "DELETE" },
        10_000,
        logs,
      )
      sessionDeleted = true
    } catch (error) {
      pushLog(`session delete failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    const meaningful = sink.requests.filter((request) => request.method === "POST" && request.bodyText.length > 0)
    return {
      ok: meaningful.length > 0,
      error: meaningful.length === 0 ? "no request reached the sink" : undefined,
      logs,
      requests: meaningful,
      durationMs: Date.now() - started,
      serverKilled: true,
      sessionDeleted,
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      logs,
      requests: sink?.requests.filter((request) => request.method === "POST" && request.bodyText.length > 0) ?? [],
      durationMs: Date.now() - started,
      serverKilled: false,
      sessionDeleted,
    }
  } finally {
    if (child) killTree(child)
    if (sink) {
      sink.server.close()
      sink.server.closeAllConnections?.()
    }
    if (tempDir) {
      try {
        await rm(tempDir, { recursive: true, force: true })
      } catch {
        // best effort
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Body diffing for A/B captures
// ---------------------------------------------------------------------------

export interface BodyDiffEntry {
  pointer: string
  a: unknown
  b: unknown
  kind: "added" | "removed" | "changed"
}

export function diffBodies(a: unknown, b: unknown, prefix = ""): BodyDiffEntry[] {
  const entries: BodyDiffEntry[] = []
  if (Array.isArray(a) && Array.isArray(b)) {
    const length = Math.max(a.length, b.length)
    for (let index = 0; index < length; index++) {
      const pointer = `${prefix}[${index}]`
      if (index >= a.length) entries.push({ pointer, a: undefined, b: b[index], kind: "added" })
      else if (index >= b.length) entries.push({ pointer, a: a[index], b: undefined, kind: "removed" })
      else entries.push(...diffBodies(a[index], b[index], pointer))
    }
    return entries
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const recordA = a as Record<string, unknown>
    const recordB = b as Record<string, unknown>
    for (const key of new Set([...Object.keys(recordA), ...Object.keys(recordB)])) {
      const pointer = prefix ? `${prefix}.${key}` : key
      if (!(key in recordA)) entries.push({ pointer, a: undefined, b: recordB[key], kind: "added" })
      else if (!(key in recordB)) entries.push({ pointer, a: recordA[key], b: undefined, kind: "removed" })
      else entries.push(...diffBodies(recordA[key], recordB[key], pointer))
    }
    return entries
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    entries.push({ pointer: prefix || "<root>", a, b, kind: "changed" })
  }
  return entries
}
