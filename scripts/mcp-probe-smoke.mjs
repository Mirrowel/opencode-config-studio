// MCP probe smoke: drives the real compiled mcpprobe.js against
// - a mock stdio MCP server (spawned as a local "command"),
// - a mock streamable-HTTP server (JSON + SSE-framed variants, session header),
// - failure paths (bad command, auth).
import { createServer } from "node:http"
import { writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const mcpprobe = await import(new URL(`file://${path.join(root, "dist", "mcpprobe.js").replaceAll("\\", "/").replaceAll(" ", "%20")}`).href)

const assert = (condition, message) => { if (!condition) throw new Error(`mcp-probe smoke: ${message}`) }

// --- Mock stdio MCP server script ---
const dir = mkdtempSync(path.join(tmpdir(), "mcp-probe-smoke-"))
const serverScript = path.join(dir, "mock-server.mjs")
writeFileSync(serverScript, `import { createInterface } from "node:readline"
const rl = createInterface({ input: process.stdin })
let page = 0
rl.on("line", (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mock-stdio", version: "1.2.3" } } }) + "\\n")
  } else if (msg.method === "tools/list") {
    if (page === 0) {
      page++
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "search web", description: "Search the web", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }], nextCursor: "p2" } }) + "\\n")
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "fetch/page", description: "Fetch a page" }] } }) + "\\n")
    }
  }
})
`)

// --- stdio probe: pagination + runtime ids + server info + process cleanup ---
const stdioResult = await mcpprobe.probeMcpServer(undefined, "my.server/x", {
  type: "local",
  command: [process.execPath, serverScript],
  environment: { PROBE_TEST_VAR: "expanded" },
})
console.log("stdio:", stdioResult.status, stdioResult.status === "ok" ? stdioResult.tools.map((t) => t.runtimeId).join(", ") : stdioResult.error)
assert(stdioResult.status === "ok", "stdio probe succeeds")
assert(stdioResult.tools.length === 2, "cursor pagination collects both pages")
assert(stdioResult.tools.some((t) => t.runtimeId === "my_server_x_search_web"), "runtime id = sanitize(server)_sanitize(tool)")
assert(stdioResult.tools.some((t) => t.runtimeId === "my_server_x_fetch_page"), "slash in tool name sanitized")
const searchTool = stdioResult.tools.find((t) => t.name === "search web")
assert(searchTool && typeof searchTool.inputSchema === "object", "inputSchema captured")
assert(stdioResult.serverName === "mock-stdio" && stdioResult.serverVersion === "1.2.3", "serverInfo captured")

// --- failure: bad command ---
const bad = await mcpprobe.probeMcpServer(undefined, "bad", { type: "local", command: ["definitely-not-a-real-command-xyz"] })
console.log("bad command:", bad.status, bad.status === "failed" ? bad.error.slice(0, 60) : "")
assert(bad.status === "failed", "bad command fails with an error, not a throw")

// --- HTTP probe: SSE-framed responses + session header ---
let sessionHeaderChecks = { init: 0, list: 0 }
const httpServer = createServer((req, res) => {
  let body = ""
  req.on("data", (chunk) => (body += chunk))
  req.on("end", () => {
    const msg = JSON.parse(body)
    const sse = (payload) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
    }
    if (msg.method === "initialize") {
      sessionHeaderChecks.init++
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "ses-123" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "mock-http", version: "9.9" } } }))
      return
    }
    if (msg.method === "tools/list") {
      sessionHeaderChecks.list++
      if (req.headers["mcp-session-id"] !== "ses-123") {
        res.writeHead(400).end("missing session")
        return
      }
      sse({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "remote_tool", description: "From HTTP", inputSchema: { type: "object" } }] } })
      return
    }
    res.writeHead(202).end()
  })
})
await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve))
const port = httpServer.address().port
const httpResult = await mcpprobe.probeMcpServer(undefined, "remote srv", { type: "remote", url: `http://127.0.0.1:${port}/mcp` })
console.log("http:", httpResult.status, httpResult.status === "ok" ? httpResult.tools.map((t) => t.runtimeId).join(", ") : httpResult.error)
assert(httpResult.status === "ok", "http probe succeeds (SSE body)")
assert(httpResult.tools[0].runtimeId === "remote_srv_remote_tool", "http runtime id sanitized")
assert(sessionHeaderChecks.init === 1 && sessionHeaderChecks.list === 1, "session header flows init -> list")

// --- auth path ---
const authServer = createServer((req, res) => {
  res.writeHead(401, { "www-authenticate": 'Bearer realm="mcp"' }).end()
})
await new Promise((resolve) => authServer.listen(0, "127.0.0.1", resolve))
const authResult = await mcpprobe.probeMcpServer(undefined, "oauthed", { type: "remote", url: `http://127.0.0.1:${authServer.address().port}/mcp` })
console.log("auth:", authResult.status)
assert(authResult.status === "auth", "401 maps to auth status")
assert(authResult.hint === 'Bearer realm="mcp"', "WWW-Authenticate hint captured")

// --- cache semantics ---
mcpprobe.clearMcpProbeCache()
const entry = { type: "local", command: [process.execPath, serverScript] }
const first = await mcpprobe.getMcpProbe(undefined, "cached-srv", entry)
const cached = mcpprobe.cachedMcpProbe("cached-srv", entry)
assert(cached?.status === "ok" && cached.tools.length === first.tools.length, "probe result cached")
const stale = mcpprobe.cachedMcpProbe("cached-srv", { ...entry, command: [process.execPath, serverScript, "--changed"] })
assert(stale === undefined, "config change invalidates cache entry")

// --- grouping merge ---
const { appendProbeGroups, groupToolsBySource } = await import(new URL(`file://${path.join(root, "dist", "toollist.js").replaceAll("\\", "/").replaceAll(" ", "%20")}`).href)
const merged = appendProbeGroups(groupToolsBySource([{ id: "bash" }, { id: "magic_x" }], ["my.server/x"]), { "my.server/x": stdioResult })
assert(merged.map((g) => g.source).join(",") === "builtin,plugins,mcp:my.server/x", `probe group appended (got ${merged.map((g) => g.source).join(",")})`)
assert(merged[2].tools.every((tool) => tool.id.startsWith("my_server_x_")), "probe tools carry runtime ids in the merged group")

await new Promise((resolve) => httpServer.close(resolve))
await new Promise((resolve) => authServer.close(resolve))
console.log("mcp-probe smoke passed")
