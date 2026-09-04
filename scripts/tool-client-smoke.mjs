// Ground-truth harness: real @opencode-ai/sdk/v2 client against a mock server
// implementing the tool/mcp endpoints, driving OUR dist/toollist.js exactly
// as the studio does. Exposes param-shape/envelope mismatches instantly.
import { createServer } from "node:http"
import { createOpencodeClient } from "../node_modules/@opencode-ai/sdk/dist/v2/client.js"
import * as toollist from "../dist/toollist.js"

const seen = { toolList: [], toolIds: [], mcp: 0, active: 0 }
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1")
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === "/experimental/tool" && req.method === "GET") {
    seen.toolList.push(Object.fromEntries(url.searchParams.entries()))
    const provider = url.searchParams.get("provider")
    const model = url.searchParams.get("model")
    if (!provider || !model) return json(400, { error: "Bad Request", message: "provider and model are required" })
    return json(200, [
      { id: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string", description: "The command" } }, required: ["command"] } },
      { id: "read", description: "Read a file", parameters: undefined },
      { id: "context7_resolve", description: "Resolve library", parameters: { type: "object" } },
      { id: "magic_compact", description: "Plugin tool", parameters: undefined },
    ])
  }
  if (url.pathname === "/experimental/tool/ids" && req.method === "GET") {
    seen.toolIds.push(Object.fromEntries(url.searchParams.entries()))
    return json(200, ["bash", "read", "context7_resolve", "magic_compact"])
  }
  if (url.pathname === "/mcp" && req.method === "GET") {
    seen.mcp++
    return json(200, { context7: { status: "connected" }, broken: { status: "failed", error: "spawn failed" } })
  }
  if (url.pathname === "/session/active" && req.method === "GET") {
    seen.active++
    return json(200, { data: {} })
  }
  json(404, { error: "Not Found" })
})

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const port = server.address().port
const client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` })
const api = { client }

console.log("--- v2-shaped client (flat params) ---")
const bundle = await toollist.fetchToolBundle(api, "zai-coding-plan/glm-5.3")
console.log("mode:", bundle.mode, "| tools:", bundle.tools.length, "| groups:", bundle.groups.map((g) => `${g.source}=${g.tools.length}`).join(", "), "| serverIds:", bundle.serverIds.join(","))
console.log("list queries seen:", JSON.stringify(seen.toolList))
console.log("status context7:", JSON.stringify(bundle.statuses?.context7), "| broken:", JSON.stringify(bundle.statuses?.broken))

const assert = (condition, message) => { if (!condition) throw new Error(`tool-client smoke: ${message}`) }
assert(bundle.mode === "live", "expected live mode with flat params")
assert(seen.toolList.some((query) => query.provider === "zai-coding-plan" && query.model === "glm-5.3"), "flat params must reach the wire as query strings")
assert(bundle.groups.some((g) => g.source === "builtin" && g.tools.length === 2), "builtin group holds known ids")
assert(bundle.groups.some((g) => g.source === "plugins" && g.tools.length === 1), "plugin tools separate from builtins")
assert(bundle.groups.some((g) => g.source === "context7" && g.tools.length === 1), "MCP tools group under their server")
assert(bundle.statuses?.broken?.error === "spawn failed", "failed server status carries its verbatim error")
const described = toollist.describeToolParameters({ type: "object", properties: { command: { type: "string", description: "The command" } }, required: ["command"] })
assert(described.some((line) => line.includes("command (string, required)")), "parameter schema renders")
console.log("tool-client smoke passed")

await new Promise((resolve) => server.close(resolve))
