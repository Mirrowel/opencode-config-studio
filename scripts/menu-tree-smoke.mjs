/**
 * Menu-tree simulator: walks the compiled Config Studio TUI with a probe
 * instead of a terminal, driving every menu option to catch crashes,
 * duplicate/ambiguous titles, dead entries, and missing back options.
 * Runs both module layouts (integrated + own-menu).
 *
 * Usage: bun --conditions=browser scripts/menu-tree-smoke.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"

ensureRuntimePluginSupport()

const root = path.resolve(import.meta.dir, "..")
const dist = await import(pathToFileURL(path.join(root, "dist", "tui.js")).href)
const tui = dist.default
const T = dist.__testInternals
if (tui?.id !== "config-studio" || typeof T?.mainMenu !== "function") throw new Error("tui entry or test internals missing")

const RUN_TIMEOUT_MS = 1200
const MAX_DEPTH = 4
const MAX_RUNS = 140

const failures = []
const treeLines = []
let runs = 0

function fail(path, message) {
  failures.push(`[${path.join(" > ") || "(root)"}] ${message}`)
}

function normalizeTitle(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function validateMenu(path, menu, isRoot) {
  const titles = menu.options.map((option) => option.title ?? "")
  if (titles.some((title) => title.trim().length === 0)) fail(path, `menu "${menu.title}" has an empty option title`)
  const valueStrings = menu.options.map((option) => String(option.value ?? ""))
  const duplicateValues = valueStrings.filter((value, index) => valueStrings.indexOf(value) !== index)
  if (duplicateValues.length > 0) fail(path, `menu "${menu.title}" has duplicate values: ${[...new Set(duplicateValues)].join(", ")}`)
  const byNormalized = new Map()
  for (const title of titles) {
    const key = normalizeTitle(title)
    if (byNormalized.has(key)) fail(path, `ambiguous option titles in "${menu.title}": "${byNormalized.get(key)}" vs "${title}"`)
    else byNormalized.set(key, title)
  }
  if (!isRoot) {
    const hasBack = menu.options.some((option) => option.title.startsWith("<") || option.value === "__back__" || option.value === "__cancel__")
    if (!hasBack) fail(path, `submenu "${menu.title}" has no back/cancel option`)
  }
}

const ROOT_MENU_TITLE = "Config Studio"

function makeProbe(script) {
  const menus = []
  return {
    menus,
    probe: {
      onMenu: (title, options) => {
        menus.push({ title, options: options.map((option) => ({ title: option.title, value: option.value, description: option.description })) })
        if (script.length > 0) return script.shift()
        return undefined
      },
      onConfirm: () => false,
    },
  }
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve("__timeout__"), ms))])
}

/** Drives the path then presses Back on the target menu; reports the menu
 * that the Back press landed on (the recording at index path.length + 1 -
 * later recordings cascade from the exhausted script treating prompts as Esc
 * and are not part of the Back navigation itself). */
async function runBack(api, state, path) {
  const { probe, menus } = makeProbe([...path])
  T.__setMenuProbe(probe)
  try {
    await withTimeout(T.mainMenu(api, state), RUN_TIMEOUT_MS)
  } catch {
    // crashes are reported by the main walk
  } finally {
    T.__setMenuProbe(undefined)
  }
  const target = menus[path.length - 1]
  const landedMenu = menus[path.length]
  return { target: target?.title, landed: landedMenu?.title }
}

async function walk(api, state, path) {
  if (runs >= MAX_RUNS) return
  runs++
  const { probe, menus } = makeProbe([...path])
  T.__setMenuProbe(probe)
  let result
  try {
    result = await withTimeout(T.mainMenu(api, state), RUN_TIMEOUT_MS)
  } catch (error) {
    fail(path, `crash: ${error instanceof Error ? error.message : String(error)}`)
    return
  } finally {
    T.__setMenuProbe(undefined)
  }
  if (result === "__timeout__") {
    // Interactive leaf (e.g. wizard-internal flows that don't route through
    // the studio probe). Not a failure by itself.
    return
  }
  // Every menu rendered during the run gets validated; the main menu
  // re-appears whenever a screen returns to it, so root detection is by
  // title, not position.
  menus.forEach((menu) => validateMenu(path, menu, menu.title === ROOT_MENU_TITLE))
  const rootMenu = menus[0]
  if (rootMenu && path.length === 0) {
    if (!rootMenu.options.some((option) => option.title.startsWith("Save & exit"))) fail(path, "main menu is missing the always-visible Save & exit")
  }

  // The menu opened by the LAST path value sits at index path.length (menus[0]
  // is the root, menus[i] was opened by path[i-1]). Parent pickers may
  // RE-RENDER after that (when a value misses and a loop re-presents), so
  // reverse-search over all recordings picks a stale parent - use the index.
  const expandMenu = menus[Math.min(path.length, menus.length - 1)] ?? rootMenu
  const deepest = expandMenu
  if (!expandMenu || path.length >= MAX_DEPTH) return

  // Navigation contract: activating the Back option on the target menu must
  // return to the PARENT menu, never all the way to the root (unless the
  // target is a direct child of root).
  if (path.length >= 2 && deepest.title !== ROOT_MENU_TITLE) {
    const backOption = deepest.options.find((option) => option.title.startsWith("<") && (option.value === "__back__" || option.value === "__cancel__"))
    if (backOption) {
      const backRun = await runBack(api, state, [...path, backOption.value])
      if (backRun.landed === ROOT_MENU_TITLE) {
        fail(path, `"${backOption.title}" on "${deepest.title}" went ALL THE WAY BACK to the main menu - must return one level`)
      }
    }
  }  const seen = new Set()
  for (const option of expandMenu.options) {
    const value = String(option.value ?? "")
    if (value.startsWith("__") || value === "undefined") continue
    if (seen.has(value)) continue
    seen.add(value)
    treeLines.push(`${"  ".repeat(path.length)}${path.map(String).join(">") || "(root)"} -> ${option.title} [${value}]`)
    await walk(api, state, [...path, option.value])
  }
}

function makeApi(globalDir) {
  const providersFixture = {
    data: {
      all: [
        {
          id: "zai-coding-plan",
          name: "z.ai",
          api: { npm: "@ai-sdk/openai-compatible" },
          models: {
            "glm-5.2": {
              id: "glm-5.2",
              name: "GLM 5.2",
              reasoning: true,
              limit: { context: 200000, output: 128000 },
              variants: {
                low: { reasoningEffort: "low" },
                high: { reasoningEffort: "high" },
              },
            },
          },
        },
      ],
      default: { "zai-coding-plan": "glm-5.2" },
    },
  }
  return {
    state: {
      path: { config: globalDir, directory: globalDir, worktree: globalDir },
      // Runtime-contributed MCP server (plugin config() hook pattern, e.g.
      // closedrouter): no file entry; bogus port so probes fail instantly.
      config: { mcp: { rtprobe: { type: "remote", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer x" } } } },
      provider: [],
    },
    kv: { get: () => undefined, set: () => {} },
    theme: { current: { accent: "white", error: "red", success: "green", textMuted: "gray", text: "white", background: "black", primary: "blue", backgroundPanel: "black" } },
    mode: { push: () => () => {} },
    keymap: { registerLayer: () => () => {} },
    command: { register: () => () => {} },
    lifecycle: { onDispose: () => {} },
    renderer: { root: {} },
    client: { provider: { list: async () => providersFixture } },
    ui: {
      toast: () => {},
      dialog: { setSize: () => {}, replace: () => null, clear: () => {} },
      DialogConfirm: () => null,
      DialogSelect: () => null,
      DialogPrompt: () => null,
    },
  }
}

async function runLayout(label, ownMenu) {
  const dir = mkdtempSync(path.join(tmpdir(), `menu-tree-${label}-`))
  const globalDir = path.join(dir, "global")
  mkdirSync(path.join(dir, "config-studio"), { recursive: true })
  mkdirSync(globalDir, { recursive: true })
  // Seed a global config carrying the standalone AV plugin entry so the walker
  // exercises the Source & channel single-hit flow (the old TypeError path).
  writeFileSync(path.join(globalDir, "opencode.json"), JSON.stringify({ plugin: ["@mirrowel/opencode-agent-variants@dev"] }), "utf8")
  // Seed models.dev cache so the walk never touches the network.
  writeFileSync(path.join(dir, "config-studio", "models-cache.json"), JSON.stringify({ at: Date.now(), catalog: {} }), "utf8")
  try {
    const api = makeApi(globalDir)
    await tui.tui(api)
    T.setStudioSettings({
      capture: { hiddenSections: ["messages"] },
      modules: { enabled: {}, options: ownMenu ? { "agent-variants": { ownMenu: true } } : {} },
      quickAccess: ["settings:Providers:disabled_providers"],
    })
    T.resetDuplicateCheck()
    T.suppressDuplicateDialog()
    // Render the deferred-reload pending row so the walker exercises the
    // Reload-now / Cancel auto-reload flow (the bundled reload copy).
    T.setReloadPendingForTest({ since: Date.now(), active: 2 })
    const state = await T.refreshStudio(api)
    runs = 0
    await walk(api, state, [])
    console.log(`${label}: ${runs} walk run(s), ${treeLines.length} edges`)
    treeLines.length = 0
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

await runLayout("integrated", false)
await runLayout("own-menu", true)

if (failures.length > 0) {
  console.error(`\nmenu-tree failures (${failures.length}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log("menu-tree smoke passed")

// Cleanup scanner checks (runs here because it lives in the TUI bundle).
{
  const scan = T.scanCleanupFindings
  if (typeof scan !== "function") throw new Error("scanCleanupFindings not exported")
  const fakeState = (data) => ({
    files: [{ path: "C:/fake/opencode.json", data, exists: true, parseErrors: [] }],
    tuiFiles: [],
    markdownAgents: [],
  })
  const findings = scan(
    fakeState({
      mode: { reviewer: { prompt: "review" } },
      tools: { bash: true, read: false },
      autoshare: true,
      reference: { docs: "owner/repo" },
      layout: "auto",
      logLevel: "INFO",
      theme: "dracula",
      agent: { general: { tools: { edit: true }, maxSteps: 40 } },
    }),
  )
  const rules = findings.map((finding) => finding.rule)
  for (const expected of ["mode", "tools", "autoshare", "reference", "layout", "logLevel", "tui-migrate", "agent.tools", "agent.maxSteps"]) {
    if (!rules.includes(expected)) throw new Error(`cleanup finds ${expected} (got ${rules.join(",")})`)
  }
  const modeFinding = findings.find((finding) => finding.rule === "mode")
  const modeSet = modeFinding.ops.find((op) => op.path.join(".") === "agent.reviewer")
  if (!modeSet || modeSet.value.mode !== "primary") throw new Error("mode migration forces primary")
  const toolsFinding = findings.find((finding) => finding.rule === "tools")
  const permSet = toolsFinding.ops.find((op) => op.path.join(".") === "permission")
  if (!permSet || permSet.value.bash !== "allow" || permSet.value.read !== "deny") throw new Error("tools migration converts actions")
  const clean = scan(fakeState({ model: "zai-coding-plan/glm-5.2", share: "auto" }))
  if (clean.length !== 0) throw new Error("no false positives on a clean config")
  console.log("cleanup scanner checks passed")
}
