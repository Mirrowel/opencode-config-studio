import type { Plugin } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { join } from "node:path"
import { ensureTuiRegistration, ourRootDir } from "./selfwire.js"
import { findStandaloneAgentVariants } from "./standalone.js"
import { loadSettings, moduleEnabled } from "./settings.js"

/**
 * Server entry.
 *
 * 1. Self-wiring: OpenCode loads server plugins from opencode.json while TUI
 *    plugins load from tui.json. Registering this plugin in opencode.json
 *    activates this entry, which mirrors the registration into the global
 *    tui.json when no tui.json layer has it (created if absent).
 *
 * 2. Embedded Agent Variants: when the agent-variants module is enabled and
 *    no standalone agent-variants registration exists in any config layer,
 *    the studio runs the agent-variants server plugin (routing) on the
 *    studio's behalf. If a standalone registration exists, it stays
 *    authoritative and the embedded router remains dormant to avoid
 *    double-routing. All failures are swallowed: the server part must never
 *    break the host.
 */
const plugin: Plugin = async (input) => {
  const globalConfigDir = join(homedir(), ".config", "opencode")
  const dataDir = join(globalConfigDir, "config-studio")

  try {
    ensureTuiRegistration({
      globalConfigDir,
      ourRoot: ourRootDir(),
      directory: input.directory ?? undefined,
      worktree: input.worktree ?? undefined,
      env: process.env,
    })
  } catch {
    // Self-wiring is best effort.
  }

  try {
    const settings = loadSettings(dataDir)
    if (moduleEnabled(settings, "agent-variants", true)) {
      const standalone = findStandaloneAgentVariants({
        globalConfigDir,
        directory: input.directory ?? undefined,
        worktree: input.worktree ?? undefined,
        env: process.env,
      })
      if (standalone.length === 0) {
        const agentVariants = await import("@mirrowel/opencode-agent-variants/server")
        const embedded = await agentVariants.default.server(input as unknown as Parameters<typeof agentVariants.default.server>[0])
        // Same hook shape, possibly compiled against a different copy of the
        // plugin SDK types - cast across the boundary.
        return { ...(embedded ?? {}) } as unknown as Awaited<ReturnType<Plugin>>
      }
    }
  } catch {
    // Embedded routing is best effort; never break the host.
  }

  return {}
}

export default { id: "config-studio", server: plugin }
