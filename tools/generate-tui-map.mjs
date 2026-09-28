import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..")
const DOC_PATH = path.join(ROOT, "docs", "TUI_MAP.md")
const CHECK = process.argv.includes("--check")

const RUN_TIMEOUT_MS = 1500
const LOOP_BUDGET = 120
const MAX_NODES = 400
const MAX_RUNS = 2500
const MAX_SECTION_ROWS = 24
const SAMPLED_ROWS = 10
const RENDERER_GAP = "__probe_renderer_unavailable__"
const PROBE_BUDGET = "__probe_budget__"
const PROBE_STOP = "__probe_stop__"
const TIMEOUT = "__timeout__"
const ROOT_MENU_TITLE = "Config Studio"

const SCENARIOS = [
  { id: "integrated/reload-pending", layout: "integrated", pending: true, sidecar: false, label: "integrated layout, config reload pending" },
  { id: "integrated/idle", layout: "integrated", pending: false, sidecar: false, label: "integrated layout, no reload pending" },
  { id: "own-menu/reload-pending", layout: "own-menu", pending: true, sidecar: false, label: "own-menu layout, config reload pending" },
  { id: "own-menu/idle", layout: "own-menu", pending: false, sidecar: false, label: "own-menu layout, no reload pending" },
  { id: "integrated/idle-av-sidecar", layout: "integrated", pending: false, sidecar: true, label: "integrated layout, agent-variants.jsonc sidecar seeded" },
]
const INTEGRATED = SCENARIOS.filter((spec) => spec.layout === "integrated")
const OWN_MENU = SCENARIOS.filter((spec) => spec.layout === "own-menu")
const NAV_VALUES = new Set(["__back__", "__cancel__", "__done__", "__qa_divider__", "__divider__"])
const PICKER_PREFIXES = ["Edit which ", "Create which file?", "tui.json - ", "opencode.json - "]

process.env.HOME = process.env.HOME || tmpdir()
process.env.USERPROFILE = process.env.USERPROFILE || tmpdir()

const dist = await import(pathToFileURL(path.join(ROOT, "dist", "tui.js")).href)
const tui = dist.default
const T = dist.__testInternals
if (tui?.id !== "config-studio" || typeof T?.mainMenu !== "function" || typeof T.__setMenuProbe !== "function") {
  throw new Error("config-studio dist/tui.js is missing the probe seam - run npm run build first")
}

const wizard = await import("@mirrowel/opencode-agent-variants/wizard")
const avConfig = await import("@mirrowel/opencode-agent-variants/config")
const settingsModule = await import(pathToFileURL(path.join(ROOT, "dist", "settings.js")).href)
const PINNABLE_SCREENS = Array.isArray(settingsModule.PINNABLE_SCREENS) ? settingsModule.PINNABLE_SCREENS : []
const PINNABLE_IDS = new Set(PINNABLE_SCREENS.map((screen) => screen.id))

const PIN_TITLES = [
  ["settings:Models & agents", "Models & agents"],
  ["settings:Sharing & updates", "Sharing & updates"],
  ["settings:Providers", "Providers"],
  ["settings:Tools & files", "Tools & files"],
  ["settings:Session behavior", "Session behavior"],
  ["settings:Server", "Server"],
  ["settings:Developer", "Developer"],
  ["settings:Deprecated", "Deprecated"],
  ["settings:Providers:provider", "Providers"],
  ["settings:Providers:disabled_providers", "Disabled providers"],
  ["settings:Providers:enabled_providers", "Enabled providers (allowlist)"],
  ["settings:Tools & files:mcp", "MCP servers"],
  ["settings:Tools & files:command", "Slash commands"],
  ["settings:Tools & files:permission", "Permissions"],
  ["settings:Tools & files:instructions", "Instruction files"],
  ["settings:Tools & files:skills", "Skills"],
  ["settings:Tools & files:references", "References"],
  ["settings:Tools & files:formatter", "Formatter"],
  ["settings:Tools & files:lsp", "LSP servers"],
]

const ANCHORS = [
  { topic: "Default / small model", path: ["Config Studio", "Settings", "Models & agents", "Default model"] },
  { topic: "Default agent", path: ["Config Studio", "Settings", "Models & agents", "Default agent"] },
  { topic: "Provider API key / base URL", path: ["Config Studio", "Providers - edited first", "Provider <provider>", "API key env vars"] },
  { topic: "Provider entries (config)", path: ["Config Studio", "Settings", "Providers"] },
  { topic: "Permissions (root)", path: ["Config Studio", "Settings", "Tools & files", "Permissions"] },
  { topic: "MCP servers", path: ["Config Studio", "Settings", "Tools & files", "MCP servers"] },
  { topic: "Theme / diff / cursor", path: ["Config Studio", "TUI settings (tui.json)", "Theme"] },
  { topic: "Keybinds", path: ["Config Studio", "TUI settings (tui.json)"] },
  { topic: "Agent hidden / disabled", path: ["Config Studio", "Agents", "Agent <agent>", "Agent <agent> - Hidden"] },
  { topic: "AV task-list & calling / variants", path: ["Config Studio", "Agents", "Agent <agent>", "<agent> - Agent Variants"] },
  { topic: "AV profiles / model presets", path: ["Config Studio", "Agents"] },
  { topic: "AV task-id suggestions", path: ["Config Studio", "Tools"] },
  { topic: "Subagent sessions", path: ["Config Studio", "Tools"] },
  { topic: "Plugin management", path: ["Config Studio", "Plugins"] },
  { topic: "Config reload / pending state", path: ["Config Studio", "Advanced"] },
  { topic: "Model variants / default options", path: ["Config Studio", "Providers - edited first", "Models (catalog) - <provider>", "<provider>/<model>", "Variants - <model>"] },
]

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

const PLACEHOLDERS = [
  ["http://127.0.0.1:9/mcp", "<url>"],
  ["zai-coding-plan", "<provider>"],
  ["glm-5.2", "<model>"],
  ["rtprobe", "<server-runtime>"],
  ["localprobe", "<server-local>"],
  ["definitely-not-a-real-mcp-xyz", "<command>"],
  ["127.0.0.1", "<host>"],
  ["general", "<agent>"],
  ["build", "<agent>"],
  ["plan", "<agent>"],
  ["high", "<variant>"],
  ["low", "<variant>"],
]

const PLACEHOLDER_DELIM_LEFT = "[\\s(\\[/'\"|>]"
const PLACEHOLDER_DELIM_RIGHT = "[\\s)\\]/'\"<|]"

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function applyPlaceholders(text) {
  let out = String(text ?? "")
  for (const [needle, token] of PLACEHOLDERS) {
    out = out.replace(new RegExp(`(?<=^|${PLACEHOLDER_DELIM_LEFT})${escapeRegExp(needle)}(?=$|${PLACEHOLDER_DELIM_RIGHT})`, "g"), token)
  }
  return out
}

function normalizeCounts(text) {
  return String(text ?? "")
    .replace(/\(\s*\d+\s*\)/g, "(N)")
    .replace(/:\s*-?\d+(%?)/g, ": N$1")
    .replace(/\b\d+\s+(running|session)/g, "N $1")
}

function normalizeToggle(text) {
  return String(text ?? "").replace(/:\s*(on|off|true|false|enabled|disabled)\s*$/i, ": <state>")
}

const normalizeCache = new Map()

function normalizeText(text) {
  const key = String(text ?? "")
  const cached = normalizeCache.get(key)
  if (cached !== undefined) return cached
  const result = normalizeToggle(normalizeCounts(applyPlaceholders(key))).replace(/\s+/g, " ").trim()
  normalizeCache.set(key, result)
  return result
}

function isNavOption(option) {
  if (NAV_VALUES.has(option.value)) return true
  const title = String(option.title ?? "").trim()
  if (title.startsWith("<")) return true
  return title.length > 0 && /^[─—–\-\s]+$/.test(title)
}

function isPickerTitle(title) {
  return PICKER_PREFIXES.some((prefix) => title.startsWith(prefix))
}

function withTimeout(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

function createSanitizer(needles) {
  const list = []
  for (const needle of needles) {
    if (!needle) continue
    list.push(needle, needle.replace(/\\/g, "/"), pathToFileURL(needle).href, encodeURIComponent(needle))
  }
  list.sort((a, b) => b.length - a.length)
  return (value) => {
    let text = String(value ?? "")
    for (const needle of list) text = text.split(needle).join("<tmp>")
    return text.replace(/\r?\n/g, " ").replace(/\\/g, "/").trim()
  }
}

function makeApi(globalDir, getActiveSink) {
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
      dialog: {
        setSize: () => {},
        replace: () => {
          const stack = new Error().stack ?? ""
          const sink = getActiveSink()
          if (sink) {
            sink.rendererMounts++
            sink.rendererOrigins.push(stack.includes("subagent-explorer") ? "explorer" : stack.includes("wizard.js") ? "wizard" : "studio")
          }
          throw new Error(RENDERER_GAP)
        },
        clear: () => {},
      },
      DialogConfirm: () => null,
      DialogSelect: () => null,
      DialogPrompt: () => null,
    },
  }
}

function makeProbe(script, sink) {
  let calls = 0
  const menus = []
  return {
    menus,
    probe: {
      onMenu: (title, options) => {
        calls++
        if (calls > LOOP_BUDGET) throw new Error(PROBE_BUDGET)
        menus.push({
          title,
          options: options.map((option) => ({
            title: option.title,
            value: option.value,
            description: option.description,
            help: option.help,
            danger: option.danger,
          })),
        })
        if (script.length > 0) return script.shift()
        throw new Error(PROBE_STOP)
      },
      onInfo: (title, message) => sink.infos.push({ title, message }),
      onPaged: (title, sections) => sink.paged.push({ title, sections: (sections ?? []).map((section) => section?.title ?? "") }),
      onConfirm: (title, message) => {
        sink.confirms.push({ title, message })
        return String(title).startsWith("Discard staged changes")
      },
    },
  }
}

function pickIndices(count, max) {
  if (count <= max) return [...Array(count).keys()]
  const set = new Set([0, 1, count - 1, count - 2])
  const rest = max - set.size
  for (let i = 0; i < rest; i++) set.add(2 + Math.floor(((i + 1) * (count - 4)) / (rest + 1)))
  return [...set].filter((index) => index >= 0 && index < count).sort((a, b) => a - b)
}

function recordMenu(menu) {
  return {
    title: menu.title,
    options: menu.options.map((option) => ({
      title: option.title,
      value: option.value,
      description: option.description,
      help: option.help,
      danger: option.danger,
    })),
  }
}

function menuKey(menu, sanitize) {
  return `${normalizeText(sanitize(menu.title))}\u0000${menu.options.map((option) => `${normalizeText(sanitize(option.title))}\u0001${normalizeText(sanitize(option.value))}`).join("\u0002")}`
}

function sanitizeOption(result, option) {
  return {
    title: result.sanitize(option.title),
    value: result.sanitize(option.value),
    description: result.sanitize(option.description),
    help: option.help === undefined ? undefined : result.sanitize(option.help),
    danger: option.danger === true,
  }
}

function mergedOptionKey(option) {
  const value = String(option.value ?? "").trim()
  return value.length > 0 ? value : `title:${normalizeText(option.title)}`
}

async function walkScenario(spec) {
  const dir = mkdtempSync(path.join(tmpdir(), `tui-map-${spec.layout}-${spec.pending ? "pending" : "idle"}-`))
  const home = path.join(dir, "home")
  const globalDir = path.join(dir, "global")
  mkdirSync(path.join(dir, "config-studio"), { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(globalDir, { recursive: true })
  const previousHome = process.env.HOME
  const previousProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
  writeFileSync(
    path.join(globalDir, "opencode.json"),
    JSON.stringify({ plugin: ["@mirrowel/opencode-agent-variants@dev"], mcp: { localprobe: { type: "local", command: ["definitely-not-a-real-mcp-xyz"], enabled: true } } }),
    "utf8",
  )
  writeFileSync(path.join(dir, "config-studio", "models-cache.json"), JSON.stringify({ at: Date.now(), catalog: {} }), "utf8")
  if (spec.sidecar) {
    const sidecarDir = path.join(home, ".config", "opencode")
    mkdirSync(sidecarDir, { recursive: true })
    writeFileSync(
      path.join(sidecarDir, "agent-variants.jsonc"),
      JSON.stringify({ agents: { build: { variants: { low: { model: "zai-coding-plan/glm-5.2" }, high: { model: "zai-coding-plan/glm-5.2" } } } } }),
      "utf8",
    )
  }
  const sanitize = createSanitizer([dir, home, globalDir])
  const norm = (value) => normalizeText(sanitize(value))
  const scenario = {
    spec,
    sanitize,
    nodes: new Map(),
    edges: new Map(),
    leaves: [],
    stats: { runs: 0, budgetHit: false, nodeLimitHit: false, runLimitHit: false, timeouts: 0 },
  }
  const api = makeApi(globalDir, () => activeSink)
  let activeSink = null
  let pristineState = null
  let runs = 0

  async function run(pathArr) {
    const sink = { infos: [], paged: [], confirms: [], rendererMounts: 0, rendererOrigins: [] }
    const { probe, menus } = makeProbe([...pathArr], sink)
    activeSink = sink
    runs++
    scenario.stats.runs = runs
    pristineState.pending = []
    pristineState.targetFilePath = undefined
    pristineState.tuiTargetFilePath = undefined
    T.__setMenuProbe(probe)
    const mainPromise = T.mainMenu(api, pristineState)
    mainPromise.catch(() => {})
    let error = null
    let outcome
    try {
      outcome = await withTimeout(mainPromise, RUN_TIMEOUT_MS)
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    } finally {
      T.__setMenuProbe(undefined)
      activeSink = null
    }
    if (outcome === TIMEOUT) scenario.stats.timeouts++
    if (error && error.includes(PROBE_BUDGET)) scenario.stats.budgetHit = true
    return {
      menus: menus.map((menu) => recordMenu(menu)),
      infos: sink.infos.map((info) => ({ title: norm(info.title) })),
      paged: sink.paged.map((paged) => ({ title: norm(paged.title) })),
      confirms: sink.confirms.map((confirm) => ({ title: norm(confirm.title) })),
      rendererMounts: sink.rendererMounts,
      rendererOrigin: sink.rendererOrigins[0] ?? null,
      error,
      outcome,
    }
  }

  try {
    await tui.tui(api)
    T.setStudioSettings({
      capture: { hiddenSections: ["messages"] },
      modules: { enabled: {}, options: spec.layout === "own-menu" ? { "agent-variants": { ownMenu: true } } : {} },
      quickAccess: ["settings:Providers:disabled_providers"],
    })
    T.resetDuplicateCheck()
    T.suppressDuplicateDialog()
    T.setReloadPendingForTest(spec.pending ? { since: Date.now(), active: 2 } : undefined)

    pristineState = await T.refreshStudio(api)
    if (typeof T.studioExitForTest === "function") {
      T.__setMenuProbe({ onMenu: () => undefined, onConfirm: () => true })
      try {
        await T.studioExitForTest(api, pristineState)
      } catch {
        void 0
      } finally {
        T.__setMenuProbe(undefined)
      }
    }
    const rootRun = await run([])
    const rootMenu = rootRun.menus[0]
    if (!rootMenu || norm(rootMenu.title) !== ROOT_MENU_TITLE) throw new Error(`${spec.id}: root menu "${ROOT_MENU_TITLE}" not recorded (got "${rootMenu?.title ?? "nothing"}")`)
    const rootKey = menuKey(rootMenu, sanitize)
    scenario.nodes.set(rootKey, { key: rootKey, title: norm(rootMenu.title), options: rootMenu.options, expanded: false, newChildren: 0 })
    const root = scenario.nodes.get(rootKey)
    const queue = [root]
    while (queue.length > 0) {
      if (scenario.nodes.size >= MAX_NODES) {
        scenario.stats.nodeLimitHit = true
        break
      }
      if (runs >= MAX_RUNS) {
        scenario.stats.runLimitHit = true
        break
      }
      const node = queue.shift()
      node.expanded = true
      const nodeIsLarge = isDataListMenu(node.options) || node.options.length > MAX_SECTION_ROWS
      const indices = nodeIsLarge ? pickIndices(node.options.length, SAMPLED_ROWS) : [...Array(node.options.length).keys()]
      for (const index of indices) {
        const option = node.options[index]
        if (isNavOption(option) || option.value === "undefined") continue
        if (runs >= MAX_RUNS) break
        const parentPath = node.path ?? []
        const childRun = await run([...parentPath, option.value])
        const target = childRun.menus[parentPath.length + 1] ?? null
        const targetKey = target ? menuKey(target, sanitize) : null
        const earlierKeys = new Set(childRun.menus.slice(0, parentPath.length + 1).map((menu) => menuKey(menu, sanitize)))
        const isLoop = targetKey !== null && earlierKeys.has(targetKey)
        const viewTitle = childRun.infos[0]?.title ?? childRun.paged[0]?.title ?? null
        const edgeKey = `${node.key}\u0000${String(option.value ?? "")}\u0000${norm(option.value) || norm(option.title)}`
        if (!target || isLoop) {
          const rendererOrigin = childRun.rendererMounts > 0 ? childRun.rendererOrigin ?? "studio" : null
          const kind = viewTitle
            ? "view"
            : childRun.error && childRun.error.includes(RENDERER_GAP)
              ? rendererOrigin === "wizard"
                ? "renderer"
                : "dialog"
              : childRun.error && childRun.error.includes(PROBE_BUDGET)
                ? "budget"
                : childRun.outcome === TIMEOUT
                  ? "timeout"
                  : "action"
          scenario.leaves.push({ parentKey: node.key, title: option.title, kind })
          scenario.edges.set(edgeKey, {
            parentKey: node.key,
            option,
            childKey: null,
            kind,
            viewTitle,
            pickerTitle: null,
            rendererOrigin,
            confirms: childRun.confirms.length > 0,
            scenarios: new Set([spec.id]),
          })
          continue
        }
        if (isPickerTitle(target.title)) {
          scenario.leaves.push({ parentKey: node.key, title: option.title, kind: "picker" })
          scenario.edges.set(edgeKey, { parentKey: node.key, option, childKey: null, kind: "picker", viewTitle: null, pickerTitle: target.title, rendererOrigin: null, confirms: false, scenarios: new Set([spec.id]) })
          continue
        }
        const childBudget = nodeIsLarge ? 1 : Infinity
        if (node.newChildren >= childBudget) {
          scenario.edges.set(edgeKey, { parentKey: node.key, option, childKey: null, kind: "data", viewTitle: null, pickerTitle: null, rendererOrigin: null, confirms: false, scenarios: new Set([spec.id]) })
          continue
        }
        let childNode = scenario.nodes.get(targetKey)
        if (!childNode) {
          childNode = { key: targetKey, title: norm(target.title), options: target.options, expanded: false, newChildren: 0 }
          scenario.nodes.set(targetKey, childNode)
        }
        if (!childNode.path) childNode.path = [...parentPath, option.value]
        scenario.edges.set(edgeKey, { parentKey: node.key, option, childKey: targetKey, kind: "menu", viewTitle: null, pickerTitle: null, rendererOrigin: null, confirms: false, scenarios: new Set([spec.id]) })
        if (!childNode.queued) {
          childNode.queued = true
          node.newChildren++
          queue.push(childNode)
        }
      }
    }
  } finally {
    process.env.HOME = previousHome
    process.env.USERPROFILE = previousProfile
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      void 0
    }
  }
  return scenario
}

function clusterKey(cluster) {
  return `${cluster.title}\u0000${cluster.index}`
}

function setEquals(a, b) {
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}

function isStateOption(option) {
  const title = normalizeText(option.title)
  if (/reload|staged|pending|session/i.test(title)) return true
  if (String(option.value ?? "").startsWith("__reload")) return true
  return /^[x*]\s/.test(String(option.title ?? ""))
}

function disambiguate(cluster, clusters, edgeList, nodes) {
  void nodes
  const specs = [...cluster.scenarios].map((id) => SCENARIOS.find((spec) => spec.id === id)).filter(Boolean)
  if (specs.length > 0 && specs.every((spec) => spec.layout === "own-menu")) return "own-menu"
  const incoming = incomingEdges(edgeList, clusterKey(cluster))
  const parentRows = [...new Set(incoming.map((edge) => normalizeText(edge.option.title)))].filter((title) => title && title !== cluster.title)
  const others = clusters.filter((candidate) => candidate !== cluster)
  for (const candidate of parentRows) {
    const short = candidate.includes(": ") ? candidate.slice(0, candidate.indexOf(": ")) : candidate
    const usedElsewhere = others.some((other) => incomingEdges(edgeList, clusterKey(other)).some((edge) => normalizeText(edge.option.title) === candidate))
    if (!usedElsewhere) return truncate(short, 36)
  }
  const otherKeys = new Set(others.flatMap((other) => other.options.map((option) => dedupTitle(option.title))))
  const present = cluster.options.find((option) => !otherKeys.has(dedupTitle(option.title)) && /[\sA-Z]/.test(normalizeText(option.title)))
  if (present) {
    const title = normalizeText(present.title)
    const short = title.includes(": ") ? title.slice(0, title.indexOf(": ")) : title
    return truncate(short, 36)
  }
  const absent = [...otherKeys].filter((title) => !cluster.options.some((option) => dedupTitle(option.title) === title))
  if (absent.length > 0) return `no ${absent.slice(0, 2).join(", ")}`
  return `window ${cluster.index + 1}`
}

function truncate(text, max) {
  const single = String(text ?? "").replace(/\s+/g, " ").trim()
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`
}

function hasPlaceholder(title) {
  return /<(agent|provider|model|variant|server-local|server-runtime|url)>/.test(title)
}

function entityClassOf(options) {
  const values = new Set(options.filter((option) => !isNavOption(option)).map((option) => mergedOptionKey(option)))
  const hasModule = [...values].some((value) => value.startsWith("module-agent:agent-variants:"))
  if (!hasModule) return "no-module"
  return values.has("hidden") || values.has("disable") ? "plain" : "av-managed"
}

function mergeScenarios(results) {
  const clustersByTitle = new Map()
  const instanceMap = new Map()
  for (let index = 0; index < results.length; index++) {
    const result = results[index]
    for (const [key, node] of result.nodes) {
      const options = node.options.map((option) => sanitizeOption(result, option))
      const shape = new Set(options.filter((option) => !isNavOption(option)).map((option) => mergedOptionKey(option)))
      const clusters = clustersByTitle.get(node.title) ?? []
      const placeholder = hasPlaceholder(node.title)
      const entityClass = placeholder ? entityClassOf(options) : null
      let cluster = null
      for (const candidate of clusters) {
        if (placeholder) {
          const compatible = candidate.entityClass === entityClass
            || (entityClass === "no-module" && candidate.entityClass === "plain")
            || (candidate.entityClass === "no-module" && entityClass === "plain")
          if (compatible) {
            cluster = candidate
            break
          }
          continue
        }
        if (setEquals(shape, candidate.shape)) {
          cluster = candidate
          break
        }
        const added = [...shape].filter((value) => !candidate.shape.has(value))
        const removed = [...candidate.shape].filter((value) => !shape.has(value))
        if ((added.length === 0) !== (removed.length === 0)) {
          cluster = candidate
          break
        }
      }
      if (!cluster) {
        cluster = { title: node.title, index: clusters.length, shape: new Set(), options: [], expanded: false, scenarios: new Set(), entityClass }
        clusters.push(cluster)
        clustersByTitle.set(node.title, clusters)
      }
      cluster.scenarios.add(result.spec.id)
      cluster.expanded = cluster.expanded || node.expanded
      for (const option of options) {
        const titleKey = dedupTitle(option.title)
        if (!cluster.options.some((seen) => dedupTitle(seen.title) === titleKey)) cluster.options.push(option)
      }
      for (const value of shape) cluster.shape.add(value)
      instanceMap.set(`${index}\u0000${key}`, cluster)
    }
  }
  const nodes = new Map()
  for (const clusters of clustersByTitle.values()) {
    for (const cluster of clusters) {
      nodes.set(clusterKey(cluster), {
        key: clusterKey(cluster),
        title: cluster.title,
        index: cluster.index,
        label: cluster.title,
        options: cluster.options,
        expanded: cluster.expanded,
        scenarios: cluster.scenarios,
      })
    }
  }
  const edges = new Map()
  for (let index = 0; index < results.length; index++) {
    const result = results[index]
    for (const edge of result.edges.values()) {
      const parentCluster = instanceMap.get(`${index}\u0000${edge.parentKey}`)
      if (!parentCluster) continue
      const childCluster = edge.childKey ? instanceMap.get(`${index}\u0000${edge.childKey}`) ?? null : null
      const option = sanitizeOption(result, edge.option)
      const key = `${clusterKey(parentCluster)}\u0000${mergedOptionKey(option)}\u0000${normalizeText(option.title)}`
      const existing = edges.get(key)
      if (existing) {
        for (const id of edge.scenarios) existing.scenarios.add(id)
        if (childCluster) {
          const childKey = clusterKey(childCluster)
          if (!existing.childKeys.includes(childKey)) existing.childKeys.push(childKey)
          existing.childKey = existing.childKeys[0]
          existing.kind = "menu"
        }
        if (edge.confirms) existing.confirms = true
        if (edge.rendererOrigin && !existing.rendererOrigin) existing.rendererOrigin = edge.rendererOrigin
      } else {
        const childKey = childCluster ? clusterKey(childCluster) : null
        edges.set(key, {
          parentKey: clusterKey(parentCluster),
          option,
          childKey,
          childKeys: childKey ? [childKey] : [],
          kind: edge.kind,
          viewTitle: edge.viewTitle ? result.sanitize(edge.viewTitle) : null,
          rendererOrigin: edge.rendererOrigin ?? null,
          confirms: edge.confirms === true,
          scenarios: new Set(edge.scenarios),
        })
      }
    }
  }
  const edgeList = [...edges.values()]
  for (const [title, clusters] of clustersByTitle) {
    clusters.forEach((cluster, clusterIndex) => {
      const label = clusterIndex === 0 ? title : `${title} (${disambiguate(cluster, clusters, edgeList, nodes)})`
      cluster.label = label
      nodes.get(clusterKey(cluster)).label = label
    })
  }
  return { nodes, edges }
}

function scenarioTags(ids) {
  const specs = [...ids].map((id) => SCENARIOS.find((spec) => spec.id === id)).filter(Boolean)
  if (specs.length === 0) return ""
  const tags = []
  if (specs.every((spec) => spec.layout === "integrated")) tags.push("[integrated only]")
  else if (specs.every((spec) => spec.layout === "own-menu")) tags.push("[own-menu only]")
  if (specs.every((spec) => spec.pending)) tags.push("[reload-pending only]")
  else if (specs.every((spec) => !spec.pending)) tags.push("[no-reload-pending only]")
  if (specs.every((spec) => spec.sidecar)) tags.push("[av-sidecar only]")
  return tags.join(" ")
}

function dedupTitle(title) {
  return normalizeText(title).replace(/^[x*]\s+/, "")
}

function isBareDataRow(option) {
  const title = normalizeCounts(applyPlaceholders(option.title)).replace(/^\+\s*/, "").trim()
  const value = normalizeCounts(applyPlaceholders(option.value)).trim()
  if (!title || !value) return false
  if (!/^[a-z0-9][a-z0-9_.@/-]*$/.test(title)) return false
  return title === value || value.endsWith(`:${title}`)
}

function isDataListMenu(options) {
  let run = 0
  for (const option of options) {
    if (isNavOption(option)) {
      run = 0
      continue
    }
    if (isBareDataRow(option)) {
      run++
      if (run >= 6) return true
    } else {
      run = 0
    }
  }
  return false
}

function rowCategory(item) {
  if (item.childKey || item.kind === "view") return "structural"
  if (/^\+\s+(Add|New|Create)\b/i.test(String(item.option.title ?? ""))) return "structural"
  return "data"
}

function nodeLabel(node) {
  return node.label ?? node.title
}

function pinForNode(node) {
  return PIN_TITLES.some(([, title]) => title === node.title)
}

function isPromptLike(item) {
  if (item.childKey || item.kind !== "action") return false
  const value = normalizeText(item.option.value)
  if (/^(key:|field:)/.test(value)) return true
  const description = String(item.option.description ?? "")
  return /^\((not set|default|uses the default|TUI default|OpenCode default)/i.test(description)
}

function rowGist(item) {
  const help = item.option.help
  if (!help) return null
  const first = normalizeText(help).split(/(?<=[.!?])\s/)[0].replace(/\s+/g, " ").trim()
  if (!first || first.length > 70) return null
  if (/current|keep|default:|body|preview|\{|\}|json/i.test(first)) return null
  const words = normalizeText(item.option.title).replace(/[^\w\s]/g, " ").trim().split(/\s+/).filter(Boolean)
  if (words.length > 2) return null
  return first
}

function rowMarkers(item) {
  const markers = []
  if (item.kind === "renderer" || item.kind === "dialog") markers.push("[dialog]")
  if (item.confirms) markers.push("[confirm]")
  if (isPromptLike(item)) markers.push("[prompt]")
  return markers
}

function incomingEdges(edgeList, nodeKey) {
  return edgeList.filter((edge) => edge.childKey === nodeKey || (edge.childKeys ?? []).includes(nodeKey))
}

function isStateScreen(rows) {
  if (rows.length === 0 || rows.length > 6) return false
  if (rows.some((item) => item.childKey || item.kind === "view")) return false
  const titles = rows.map((item) => item.displayTitle ?? normalizeText(item.option.title))
  if (titles.some((title) => title.includes("<"))) return false
  if (titles.some((title) => title === "(not set - remove)")) return true
  return titles.every((title) => /^[a-z0-9][a-z0-9_.-]*$/.test(title))
}

function isListEditor(rows) {
  if (rows.length === 0) return false
  if (rows.some((item) => item.childKey || item.kind === "view")) return false
  return rows.every((item) => /^\+\s+(Add|New|Create)\b/i.test(item.displayTitle ?? normalizeText(item.option.title)))
}

function commonPrefix(list) {
  let prefix = list[0] ?? ""
  for (const text of list) {
    let index = 0
    while (index < prefix.length && index < text.length && prefix[index] === text[index]) index++
    prefix = prefix.slice(0, index)
  }
  return prefix
}

function displayTitleFor(titles, fallback) {
  const unique = [...new Set(titles)]
  if (unique.length <= 1) return unique[0] ?? normalizeText(fallback.title)
  const prefix = commonPrefix(unique)
  const colon = prefix.lastIndexOf(": ")
  if (colon > 0) return `${prefix.slice(0, colon + 2)}<state>`
  return unique.slice().sort((a, b) => a.length - b.length || cmp(a, b))[0]
}

function combinedRows(node, edgeList) {
  const byValue = new Map()
  const order = []
  for (const option of node.options) {
    if (isNavOption(option)) continue
    const valueKey = mergedOptionKey(option)
    const exact = edgeList.filter((edge) => edge.parentKey === node.key && normalizeText(edge.option.title) === normalizeText(option.title))
    const matches = exact.length > 0 ? exact : edgeList.filter((edge) => edge.parentKey === node.key && mergedOptionKey(edge.option) === mergedOptionKey(option))
    if (matches.length === 0) continue
    const current = byValue.get(valueKey)
    if (current) {
      current.edges.push(...matches)
      current.titles.push(normalizeText(option.title))
      continue
    }
    const entry = { option, edges: [...matches], titles: [normalizeText(option.title)] }
    byValue.set(valueKey, entry)
    order.push(entry)
  }
  return order.map(({ option, edges, titles }) => {
    const childKeys = []
    for (const edge of edges) {
      for (const key of edge.childKeys ?? (edge.childKey ? [edge.childKey] : [])) {
        if (!childKeys.includes(key)) childKeys.push(key)
      }
    }
    const childKey = childKeys[0] ?? null
    const viewEdge = edges.find((edge) => edge.kind === "view")
    const fallback = edges.find((edge) => edge.childKey) ?? edges[0]
    return {
      option,
      displayTitle: displayTitleFor(titles, option),
      childKey,
      childKeys,
      kind: childKey ? "menu" : viewEdge ? "view" : fallback.kind,
      viewTitle: viewEdge?.viewTitle ?? null,
      rendererOrigin: fallback.rendererOrigin ?? null,
      confirms: edges.some((edge) => edge.confirms),
      scenarios: new Set(edges.flatMap((edge) => [...edge.scenarios])),
    }
  })
}

function renderRow(item, nodes, part, nodeTags) {
  void part
  const tags = (scenarioTags(item.scenarios).match(/\[[^\]]+\]/g) ?? []).filter((tag) => !nodeTags.includes(tag))
  const suffix = tags.length > 0 ? ` ${tags.join(" ")}` : ""
  const markers = rowMarkers(item)
  const markerText = markers.length > 0 ? ` ${markers.join(" ")}` : ""
  const gist = rowGist(item)
  const gistText = gist ? ` — ${gist}` : ""
  const title = item.displayTitle ?? normalizeText(item.option.title)
  if (item.kind === "menu" && item.childKeys.length > 0) {
    const targets = item.childKeys.map((key) => `\`${nodes.get(key) ? nodeLabel(nodes.get(key)) : "?"}\``).join(", ")
    return `- \`${title}\`${gistText} → ${targets}${markerText}${suffix}`
  }
  if (item.kind === "view") return `- \`${title}\`${gistText} → [view] \`${normalizeText(item.viewTitle ?? item.option.title)}\`${markerText}${suffix}`
  if (item.kind === "picker") return `- \`${title}\`${gistText} → (config layer picker)${markerText}${suffix}`
  return `- \`${title}\`${gistText}${markerText}${suffix}`
}

function buildPart(merged, partScenarios, part) {
  const { nodes, edges } = merged
  const partIds = new Set(partScenarios.map((spec) => spec.id))
  const edgeList = [...edges.values()]
  const isOwnOnly = (node) => [...node.scenarios].every((id) => SCENARIOS.find((spec) => spec.id === id)?.layout === "own-menu")
  const root = [...nodes.values()].find((node) => node.title === ROOT_MENU_TITLE && node.index === 0 && [...node.scenarios].some((id) => partIds.has(id)))
  if (!root) return { tree: ["(root menu not recorded)"], sections: [], ordered: [] }
  const belongs = part === "integrated" ? (node) => !isOwnOnly(node) : (node) => isOwnOnly(node)
  const tree = []
  const ordered = []
  const visited = new Set()
  const walk = (node, depth, path) => {
    const nodeTags = scenarioTags(node.scenarios).trim()
    if (visited.has(node.key)) {
      tree.push(`${"  ".repeat(depth)}- ↩ \`${nodeLabel(node)}\``)
      return
    }
    visited.add(node.key)
    node.pathLabels = [...path, nodeLabel(node)]
    ordered.push(node)
    tree.push(`${"  ".repeat(depth)}- \`${nodeLabel(node)}\`${nodeTags ? ` ${nodeTags}` : ""}`)
    const seen = new Set()
    for (const item of combinedRows(node, edgeList)) {
      for (const childKey of item.childKeys) {
        if (seen.has(childKey)) continue
        const child = nodes.get(childKey)
        if (!child || !belongs(child)) continue
        seen.add(childKey)
        walk(child, depth + 1, node.pathLabels)
      }
    }
  }
  if (part === "own-menu") {
    const ownNodes = [...nodes.values()].filter((node) => isOwnOnly(node))
    const rootSet = ownNodes.filter((node) => {
      const parentNodes = incomingEdges(edgeList, node.key).map((edge) => nodes.get(edge.parentKey)).filter(Boolean)
      return parentNodes.length === 0 || parentNodes.some((parent) => !isOwnOnly(parent))
    })
    tree.push(`- \`${nodeLabel(root)}\` (shared main menu - see Part 1)`)
    for (const node of rootSet) {
      const parents = incomingEdges(edgeList, node.key).map((edge) => nodes.get(edge.parentKey)).filter(Boolean)
      const sharedParent = parents.find((parent) => !isOwnOnly(parent) && parent.pathLabels)
      walk(node, 1, sharedParent ? sharedParent.pathLabels : [nodeLabel(root)])
    }
  } else {
    walk(root, 0, [])
  }
  const sections = []
  const stateScreens = []
  const listEditors = []
  for (const node of ordered) {
    const rows = combinedRows(node, edgeList)
    const nodeTags = scenarioTags(node.scenarios).trim()
    if (isStateScreen(rows)) {
      stateScreens.push(`- \`${nodeLabel(node)}\`: ${rows.map((item) => `\`${item.displayTitle ?? normalizeText(item.option.title)}\``).join(", ")}`)
      continue
    }
    if (isListEditor(rows)) {
      listEditors.push(`- \`${nodeLabel(node)}\`: ${rows.map((item) => `\`${item.displayTitle ?? normalizeText(item.option.title)}\``).join(", ")}`)
      continue
    }
    const dataList = isDataListMenu(node.options)
    const oversized = node.options.length > MAX_SECTION_ROWS
    let visible = rows
    let overflow = 0
    if (dataList) {
      const first = rows[0]
      visible = rows.filter((item) => item === first || rowCategory(item) === "structural")
      overflow = Math.max(0, node.options.length - visible.length)
    } else if (oversized) {
      visible = rows.length > MAX_SECTION_ROWS ? [...rows.slice(0, 10), { marker: "... ((N) more rows)" }, ...rows.slice(-3)] : rows
    }
    const headerTags = [nodeTags, pinForNode(node) ? "[pin]" : ""].filter(Boolean).join(" ")
    const lines = [`#### \`${nodeLabel(node)}\`${headerTags ? ` ${headerTags}` : ""}`]
    lines.push(`Path: ${node.pathLabels.map((label) => `\`${label}\``).join(" -> ")}`)
    const incoming = incomingEdges(edgeList, node.key)
    const primaryParent = node.pathLabels[node.pathLabels.length - 2]
    const via = [...new Set(incoming.map((edge) => `${nodeLabel(nodes.get(edge.parentKey))}\u0000${normalizeText(edge.option.title)}`))]
      .map((entry) => entry.split("\u0000"))
      .filter(([parent]) => parent && parent !== primaryParent && parent !== nodeLabel(node))
      .map(([parent, row]) => `\`${parent}\` -> \`${row}\``)
    if (via.length > 0) lines.push(`Also via: ${via.slice(0, 3).join("; ")}${via.length > 3 ? ` (+${via.length - 3} more)` : ""}`)
    if (visible.length === 0) lines.push("- (no rows recorded)")
    for (const item of visible) lines.push(item.marker ? `- ${item.marker}` : renderRow(item, nodes, part, nodeTags))
    if (overflow > 0) lines.push("- ... (dynamic list: (N) more rows)")
    sections.push(...lines, "")
  }
  if (stateScreens.length > 0) sections.push("#### State screens", "", "Menus that only pick a state value:", "", ...stateScreens, "")
  if (listEditors.length > 0) sections.push("#### List editors", "", "Menus that only add entries:", "", ...listEditors, "")
  return { tree, sections, ordered }
}

function renderOwnMenuDelta(merged) {
  const byParent = new Map()
  for (const edge of merged.edges.values()) {
    const specs = [...edge.scenarios].map((id) => SCENARIOS.find((spec) => spec.id === id))
    if (!specs.every((spec) => spec.layout === "own-menu")) continue
    const parent = merged.nodes.get(edge.parentKey)
    if (!parent) continue
    const label = nodeLabel(parent)
    if (!byParent.has(label)) byParent.set(label, new Set())
    byParent.get(label).add(normalizeText(edge.option.title))
  }
  return [...byParent.entries()].sort((a, b) => cmp(a[0], b[0])).map(([parent, rows]) => `- \`${parent}\`: ${[...rows].sort(cmp).map((row) => `\`${row}\``).join(", ")}`)
}

function safeLensTitle() {
  try {
    return wizard.lensTitle("Agent Variants", undefined)
  } catch {
    return "(threw)"
  }
}

async function walkStandaloneWizard() {
  const gap = { attempted: false, rendererMounts: 0, error: null, outcome: null, exports: Object.keys(wizard).sort(cmp) }
  const dir = mkdtempSync(path.join(tmpdir(), "tui-map-av-wizard-"))
  const home = path.join(dir, "home")
  mkdirSync(home, { recursive: true })
  const previousHome = process.env.HOME
  const previousProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    const configPath = avConfig.defaultSidecarPath()
    mkdirSync(path.dirname(configPath), { recursive: true })
    writeFileSync(configPath, "{}", "utf8")
    const config = avConfig.loadSidecar(configPath)
    let replaceCalls = 0
    const api = {
      hostVersion: 1,
      app: { version: "tui-map" },
      kv: { get: (_key, fallback) => fallback, set: () => {}, ready: true },
      state: { config: { agent: {} }, provider: [], path: { config: dir, directory: dir, worktree: dir } },
      dialogScope: "standalone",
      theme: { current: { text: "white", textMuted: "gray", background: "black", backgroundPanel: "black", primary: "blue", secondary: "cyan", accent: "magenta", success: "green", warning: "yellow", error: "red", info: "blue" } },
      ui: {
        toast: () => {},
        dialog: {
          replace: () => {
            replaceCalls++
            throw new Error(RENDERER_GAP)
          },
          clear: () => {},
          setSize: () => {},
        },
        DialogConfirm: () => null,
        DialogSelect: () => null,
        DialogPrompt: () => null,
        DialogAlert: () => null,
      },
      mode: { push: () => () => {} },
      keymap: { registerLayer: () => () => {} },
      lifecycle: { onDispose: () => {} },
      renderer: { root: {} },
      client: {},
    }
    gap.attempted = true
    let error = null
    let outcome
    const mainPromise = wizard.mainMenu(api, config, wizard.newWizardSettings(true))
    mainPromise.catch(() => {})
    try {
      outcome = await withTimeout(mainPromise, 500)
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    gap.rendererMounts = replaceCalls
    gap.error = error
    gap.outcome = outcome === TIMEOUT ? "timeout" : "resolved"
  } finally {
    process.env.HOME = previousHome
    process.env.USERPROFILE = previousProfile
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      void 0
    }
  }
  return gap
}

function renderWizardPart(merged, gap) {
  const lines = ["## Part 3 — Agent Variants standalone wizard (root: `Agent Variants`)", ""]
  lines.push(`Status: ${gap.attempted ? "walk attempted" : "not attempted"}. The installed \`@mirrowel/opencode-agent-variants\` bundle exposes ${typeof wizard.mainMenu === "function" ? "`mainMenu`" : "no `mainMenu`"} and no probe seam (\`__setMenuProbe\`: ${typeof wizard.__setMenuProbe === "function" ? "present" : "absent"}); every wizard menu renders through the host dialog layer, so the walker records the entry row but not the menu rows.`)
  lines.push("")
  lines.push(`- Root title from \`lensTitle("Agent Variants", undefined)\`: \`${safeLensTitle()}\``)
  lines.push(`- Attempt: ${gap.attempted ? `${gap.rendererMounts} host dialog mount attempt(s); outcome \`${gap.error ?? gap.outcome ?? "none"}\`` : "not attempted"}`)
  lines.push(`- Exported wizard functions (${gap.exports.length}): ${gap.exports.map((name) => `\`${name}\``).join(", ")}`)
  lines.push("")
  const entries = new Map()
  for (const edge of merged.edges.values()) {
    const rendererBacked = edge.kind === "renderer" || (edge.kind === "dialog" && edge.rendererOrigin === "explorer")
    if (!rendererBacked) continue
    const parent = merged.nodes.get(edge.parentKey)
    const title = normalizeText(edge.option.title)
    const entry = entries.get(title) ?? { parents: new Set(), origins: new Set() }
    entry.parents.add(parent ? nodeLabel(parent) : "?")
    entry.origins.add(edge.rendererOrigin ?? "wizard")
    entries.set(title, entry)
  }
  lines.push("### Renderer-backed leaf flows")
  lines.push("")
  if (entries.size === 0) lines.push("No renderer-backed wizard/explorer entries were recorded.")
  else {
    lines.push("Rows whose follow-up windows are rendered by the agent-variants wizard (`wizard`) or the subagent-explorer (`explorer`) and are not probe-routable; the map stops at the entry row. Studio-rendered dialogs are marked `[dialog]` in the sections instead.")
    lines.push("")
    for (const [title, entry] of [...entries.entries()].sort((a, b) => cmp(a[0], b[0]))) {
      lines.push(`- \`${title}\` (${[...entry.origins].sort(cmp).join(", ")}) — in ${entry.parents.size} menu(s), e.g. ${[...entry.parents].sort(cmp).slice(0, 3).map((parent) => `\`${parent}\``).join(", ")}`)
    }
  }
  lines.push("")
  return lines
}

function validateAnchors(nodes) {
  const titles = new Set([...nodes.values()].flatMap((node) => [node.title, nodeLabel(node)]))
  for (const anchor of ANCHORS) {
    for (const segment of anchor.path) {
      if (!titles.has(segment)) {
        const near = [...titles].filter((title) => title.toLowerCase().includes(String(segment).toLowerCase().split(" ")[0])).slice(0, 8).join(" | ")
        throw new Error(`anchor "${anchor.topic}": menu title "${segment}" not found in the walked map (near: ${near || "(none)"})`)
      }
    }
  }
}

function validatePins(nodes) {
  for (const [id, title] of PIN_TITLES) {
    if (!PINNABLE_IDS.has(id)) throw new Error(`pin id "${id}" is not in PINNABLE_SCREENS`)
    if (![...nodes.values()].some((node) => node.title === title)) throw new Error(`pin title "${title}" not found in the walked map`)
  }
  for (const screen of PINNABLE_SCREENS) {
    if (!PIN_TITLES.some(([id]) => id === screen.id)) throw new Error(`PINNABLE_SCREENS id "${screen.id}" is not mapped by the generator`)
  }
}

async function buildDocument() {
  const results = []
  for (const spec of SCENARIOS) results.push(await walkScenario(spec))
  const merged = mergeScenarios(results)
  validateAnchors(merged.nodes)
  validatePins(merged.nodes)
  const integrated = buildPart(merged, INTEGRATED, "integrated")
  const ownMenu = buildPart(merged, OWN_MENU, "own-menu")
  const wizardGap = await walkStandaloneWizard()
  const lines = []
  lines.push("# Config Studio + Agent Variants — TUI Map")
  lines.push("")
  lines.push("> **GENERATED FILE — DO NOT EDIT.** Regenerate with `npm run tools:generate-tui-map`; `npm run test:tui-map` fails when this file drifts.")
  lines.push("")
  lines.push("## Conventions")
  lines.push("")
  lines.push("- Glyphs in row titles come from the compiled menus: `!` danger, `+` add, `*` current choice, `x` disabled, `●` status, `[i]` inspect/help.")
  lines.push("- Keys: `/` type-to-filter (Config Studio menus), `i` item help, `f` pin (pinnable screens), `enter` select, `Esc` = Back one level.")
  lines.push("- `→ \\`Menu\\`` opens that menu; `→ [view] \\`Title\\`` opens a read-only view; `→ (config layer picker)` is a staged-edit file chooser (not expanded).")
  lines.push("- Row suffixes: `[prompt]` text input, `[confirm]` confirmation-gated, `[dialog]` renderer-backed dialog, `[pin]` section screen is pinnable.")
  lines.push("- `(N)` = any count; `<agent>`, `<provider>`, `<model>`, `<variant>`, `<server-local>`, `<server-runtime>`, `<url>` replace fixture identifiers; no fixture values are quoted.")
  lines.push("- `... (dynamic list: (N) more rows)` collapses auto-filled data rows; `... ((N) more rows)` marks a sampled long menu.")
  lines.push("- State tags (`[integrated only]`, `[own-menu only]`, `[reload-pending only]`, `[no-reload-pending only]`, `[av-sidecar only]`) sit on section headers; rows carry only tags that differ from their section.")
  lines.push("- Every menu ends with a Back/Cancel row; those rows are omitted.")
  lines.push("")
  lines.push("## Part 0 — Where do I edit X?")
  lines.push("")
  lines.push("| I want to change... | Menu path |")
  lines.push("|---|---|")
  for (const anchor of ANCHORS) lines.push(`| ${anchor.topic} | ${anchor.path.map((title) => `\`${title}\``).join(" -> ")} |`)
  lines.push("")
  lines.push("## Part 1 — Config Studio (integrated layout, shared menus)")
  lines.push("")
  lines.push("```")
  lines.push(...integrated.tree)
  lines.push("```")
  lines.push("")
  lines.push(...integrated.sections)
  lines.push("## Part 2 — Config Studio (own-menu layout additions)")
  lines.push("")
  if (ownMenu.ordered.length === 0) {
    lines.push("No own-menu-only windows. These rows exist only in the own-menu layout (inside the shared menus above):")
    lines.push("")
    lines.push(...renderOwnMenuDelta(merged))
    lines.push("")
  } else {
    lines.push("```")
    lines.push(...ownMenu.tree)
    lines.push("```")
    lines.push("")
    lines.push(...ownMenu.sections)
  }
  lines.push(...renderWizardPart(merged, wizardGap))
  lines.push("## Walker limits")
  lines.push("")
  for (const result of results) {
    const bits = []
    if (result.stats.timeouts > 0) bits.push(`${result.stats.timeouts} timeout(s)`)
    if (result.stats.budgetHit) bits.push("probe loop budget reached")
    if (result.stats.nodeLimitHit) bits.push(`node cap ${MAX_NODES} reached`)
    if (result.stats.runLimitHit) bits.push(`run cap ${MAX_RUNS} reached`)
    lines.push(`- \`${result.spec.id}\`: ${result.stats.runs} run(s), ${result.nodes.size} menu(s), ${result.edges.size} edge(s)${bits.length > 0 ? ` — ${bits.join("; ")}` : ""}`)
  }
  const studioDialogs = [...new Set([...merged.edges.values()].filter((edge) => edge.kind === "dialog" && edge.rendererOrigin === "studio").map((edge) => normalizeText(edge.option.title)))].sort(cmp)
  if (studioDialogs.length > 0) lines.push(`- Studio-rendered dialogs (marked \`[dialog]\` in the sections): ${studioDialogs.map((title) => `\`${title}\``).join(", ")}`)
  lines.push("")
  lines.push("Known walker gaps: rows that open a text prompt first (e.g. `Keybinds` search, `+ Add plugin`, `+ New agent...`, `Exact version...`) stop at the prompt; confirm-gated flows (save/review summaries, destructive confirms) answer \"no\" and re-present the menu. Their follow-up windows are not walked.")
  lines.push("")
  lines.push("Future work: adding a `__setMenuProbe` seam to `@mirrowel/opencode-agent-variants` would let this walker map the standalone wizard's internal menus instead of stopping at its entry rows.")
  lines.push("")
  return lines.join("\n")
}

const documentText = await buildDocument()
if (CHECK) {
  let onDisk = ""
  try {
    onDisk = readFileSync(DOC_PATH, "utf8")
  } catch {
    onDisk = ""
  }
  if (onDisk === documentText) {
    console.log("tui-map check passed: docs/TUI_MAP.md matches the generated map")
    process.exit(0)
  }
  const normalizedDisk = onDisk.replace(/\r\n/g, "\n")
  if (normalizedDisk === documentText) {
    console.log("tui-map check passed: docs/TUI_MAP.md matches the generated map (line-ending normalized)")
    process.exit(0)
  }
  const expected = documentText.split("\n")
  const actual = normalizedDisk.split("\n")
  const total = Math.max(expected.length, actual.length)
  const differences = []
  for (let index = 0; index < total && differences.length < 15; index++) {
    if (expected[index] !== actual[index]) differences.push({ line: index + 1, expected: expected[index] ?? "(missing)", actual: actual[index] ?? "(missing)" })
  }
  console.error("tui-map check failed: docs/TUI_MAP.md does not match the generated map")
  console.error(`  generated ${expected.length} line(s), on disk ${actual.length} line(s), ${differences.length}${differences.length === 15 ? "+" : ""} differing line(s)`)
  for (const difference of differences) {
    console.error(`  line ${difference.line}:`)
    console.error(`    on disk:   ${difference.actual}`)
    console.error(`    generated: ${difference.expected}`)
  }
  console.error("  Run: npm run tools:generate-tui-map")
  process.exit(1)
}
writeFileSync(DOC_PATH, documentText, "utf8")
console.log(`tui-map generated: docs/TUI_MAP.md (${documentText.split("\n").length} lines)`)
process.exit(0)
