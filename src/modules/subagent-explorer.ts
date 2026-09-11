/**
 * Subagent Explorer studio module.
 *
 * Wraps the subagent-explorer wizard library as a Config Studio module: the
 * explorer appears as a Tools entry when the module is enabled. The module
 * screen offers the same treatment as Agent Variants: enable/disable, open
 * the NATIVE explorer TUI (standalone sizing scope with its own size
 * picker), and an embedded/standalone source switcher (the standalone
 * plugin's wizard.js is loaded directly when selected).
 *
 * The standalone plugin's own selfwire stands down when the studio is
 * registered, so there is exactly one entry either way.
 */

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { TuiHostApi } from "@mirrowel/opencode-subagent-explorer/tui-host"
import { se } from "../se-source.js"
import { registerModule, type ModuleContext, type StudioModule } from "../modules.js"

function explorerHost(api: TuiPluginApi, scope: "standalone" | "embedded") {
  // The v1 studio api satisfies the explorer's TuiHostApi structurally;
  // enrich it with the router's current-session signal and the sizing scope.
  const withRoute = api as TuiPluginApi & { route?: { current?: { name: string; params?: { sessionID?: string } } } }
  const host = withRoute as unknown as TuiHostApi & {
    currentSessionID?: () => string | undefined
    dialogScope?: "standalone" | "embedded"
  }
  host.currentSessionID = () => (withRoute.route?.current?.name === "session" ? withRoute.route.current.params?.sessionID : undefined)
  host.dialogScope = scope
  return host
}

/** Runs the explorer with the module's configured implementation source. */
export async function runExplorer(ctx: ModuleContext, scope: "standalone" | "embedded" = "embedded"): Promise<void> {
  return se().wizard.mainMenu(explorerHost(ctx.api, scope))
}

export const subagentExplorerModule: StudioModule = {
  id: "subagent-explorer",
  title: "Subagent Explorer",
  version: "embedded",
  description:
    "Browse the current session's subagent tree (nested children and hidden background agents included), inspect sessions, delete them, or clean up every idle one.",
  defaultEnabled: true,
  hasPendingChanges: () => false,
  toolsEntries: () => [
    {
      title: "Subagent sessions",
      description: "Explore and delete subagent sessions of this session",
      help:
        "Opens the Subagent Explorer on the current session's subagent tree: per-session details, single deletion (running sessions ask twice), and a cleanup that removes every idle session. The parent session keeps task result text; only jump targets are lost. Sizing follows Config Studio's dialog settings.",
      run: (ctx) => runExplorer(ctx, "embedded"),
    },
  ],
}

registerModule(subagentExplorerModule)

export const subagentExplorerModuleId = subagentExplorerModule.id
