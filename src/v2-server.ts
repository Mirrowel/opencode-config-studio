/**
 * OpenCode v2 server plugin setup for Config Studio.
 *
 * v2 changes that matter here:
 * - There is no v1 config hook and no self-wiring need: the v2 TUI discovers
 *   TUI plugins from server-declared registrations automatically, so the
 *   tui.json mirroring from selfwire.ts is a v1-only concern.
 * - The embedded Agent Variants router is composed by invoking the AV server
 *   module's v2 `setup` with this plugin's context (when the module is
 *   enabled and no standalone AV registration exists — same dormancy rules
 *   as the v1 path).
 * - v2 has NO HTTP API for the tool registry, so the studio's tool-inventory
 *   screen would lose its builtin/plugin groups. The setup therefore exposes
 *   a snapshot of the registry through the sanctioned plugin RPC mechanism
 *   (`config-studio.tools`), which the studio TUI calls via the v2 client.
 *
 * All failures are swallowed: the server part must never break the host.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { findStandaloneAgentVariants } from "./standalone.js"
import { loadSettings, moduleEnabled } from "./settings.js"
import type { V2PluginContext, V2Registration, V2ServerSetup } from "./v2-types.js"

export const TOOL_RPC_ID = "config-studio"

/** v2 resolves global roots via env/XDG; honor the same resolution. */
export function v2GlobalConfigDir(): string {
  if (process.env["OPENCODE_CONFIG_DIR"]) return process.env["OPENCODE_CONFIG_DIR"]
  if (process.env["XDG_CONFIG_HOME"]) return join(process.env["XDG_CONFIG_HOME"], "opencode")
  return join(homedir(), ".config", "opencode")
}

const toolInputSchema: Record<string, unknown> = { type: "object", properties: {}, additionalProperties: false }
const toolOutputSchema: Record<string, unknown> = { type: "object" }

/**
 * Tool input schemas arrive as Effect codecs, Standard Schema objects, or
 * plain JSON Schema. Only plain JSON is wire-safe to ship through the RPC —
 * live codec objects would serialize into garbage, so anything else is
 * omitted and the tool list degrades to descriptions (like the ids fallback).
 */
function wireSafeInputSchema(input: unknown): unknown {
  if (!input || typeof input !== "object") return undefined
  const record = input as Record<string, unknown>
  if (typeof record["type"] === "string" || "properties" in record || "$schema" in record) {
    // Shallow-clone so no live codec internals can leak by reference.
    try {
      return JSON.parse(JSON.stringify(input))
    } catch {
      return undefined
    }
  }
  return undefined
}

async function composeEmbeddedAgentVariants(context: V2PluginContext, cleanups: Array<() => void>) {
  const dataDir = join(v2GlobalConfigDir(), "config-studio")
  try {
    const settings = loadSettings(dataDir)
    if (!moduleEnabled(settings, "agent-variants", true)) return
    const standalone = findStandaloneAgentVariants({ globalConfigDir: v2GlobalConfigDir(), env: process.env })
    if (standalone.length > 0) return
    const agentVariants = (await import("@mirrowel/opencode-agent-variants/server")) as {
      default?: { setup?: (context: unknown) => Promise<(() => void) | void> | (() => void) | void }
    }
    const setup = agentVariants.default?.setup
    if (typeof setup !== "function") return
    const cleanup = await setup.call(agentVariants.default, context)
    if (typeof cleanup === "function") cleanups.push(cleanup)
  } catch {
    // Embedded routing is best effort; never break the host.
  }
}

async function registerToolSnapshotRpc(context: V2PluginContext, cleanups: Array<() => void>) {
  try {
    let snapshot: Array<{ id: string; description?: string; parameters?: unknown }> = []
    await context.tool.transform((editor) => {
      // Replayed on every tool-domain reload, so the snapshot stays fresh.
      snapshot = editor.list().map((tool) => ({
        id: tool.id,
        description: tool.description,
        parameters: wireSafeInputSchema(tool.input),
      }))
    })
    const registration: V2Registration = await context.rpc.register(
      {
        id: TOOL_RPC_ID,
        methods: {
          tools: { input: toolInputSchema, output: toolOutputSchema },
          ids: { input: toolInputSchema, output: toolOutputSchema },
        },
        events: {},
      },
      {
        tools: async () => ({ tools: snapshot }),
        ids: async () => ({ ids: snapshot.map((tool) => tool.id) }),
      } as never,
    )
    cleanups.push(() => {
      try {
        void registration.dispose()
      } catch {
        /* disposal must not throw */
      }
    })
  } catch {
    // Without the RPC the tool screen degrades to MCP probes only.
  }
}

export function createStudioV2Setup(): V2ServerSetup {
  return async (context: V2PluginContext) => {
    const cleanups: Array<() => void> = []
    await composeEmbeddedAgentVariants(context, cleanups)
    await registerToolSnapshotRpc(context, cleanups)
    return () => {
      for (const cleanup of cleanups) {
        try {
          cleanup()
        } catch {
          /* cleanup must not throw */
        }
      }
    }
  }
}
