import type { Plugin } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { join } from "node:path"
import { ensureTuiRegistration, ourRootDir } from "./selfwire.js"

/**
 * Server entry. This plugin is TUI-first, but OpenCode loads server plugins
 * from opencode.json while TUI plugins load from tui.json. Registering the
 * plugin in opencode.json therefore activates this server entry, whose only
 * job is to mirror the registration into the global tui.json so the wizard is
 * available after the next start. All failures are swallowed: the server part
 * must never break the host.
 */
const plugin: Plugin = async (input) => {
  try {
    ensureTuiRegistration({
      globalConfigDir: join(homedir(), ".config", "opencode"),
      ourRoot: ourRootDir(),
      directory: input.directory ?? undefined,
      worktree: input.worktree ?? undefined,
      env: process.env,
    })
  } catch {
    // Self-wiring is best effort.
  }
  return {}
}

export default { id: "config-studio", server: plugin }
