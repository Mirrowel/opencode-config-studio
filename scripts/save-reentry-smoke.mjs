// Repro probe: the full save+exit (deferred reload) -> reopen -> exit cycle
// against real dist + real temp files, exactly as the user drives it.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const root = path.resolve(import.meta.dirname, "..")
const dist = (name) => pathToFileURL(path.join(root, "dist", `${name}.js`)).href
const tuiMod = await import(dist("tui"))
const tui = tuiMod.default.tui
const T = tuiMod.__testInternals

const dir = mkdtempSync(path.join(tmpdir(), "save-reentry-"))
const globalDir = path.join(dir, "global")
mkdirSync(globalDir, { recursive: true })
const configPath = path.join(globalDir, "opencode.json")
writeFileSync(configPath, JSON.stringify({ model: "zai-coding-plan/glm-5.3" }), "utf8")

const calls = { disposes: 0, active: 0, confirms: [], menus: [] }
const api = {
  state: {
    path: { config: globalDir, directory: globalDir, worktree: globalDir },
    config: { model: "zai-coding-plan/glm-5.3" },
    provider: [],
  },
  kv: { get: () => undefined, set: () => {} },
  theme: { current: { accent: "white", error: "red", success: "green", textMuted: "gray", text: "white", background: "black", primary: "blue", backgroundPanel: "black" } },
  mode: { push: () => () => {} },
  keymap: { registerLayer: () => () => {} },
  command: { register: () => () => {} },
  lifecycle: { onDispose: () => {} },
  renderer: { root: {} },
  client: {
    provider: { list: async () => ({ data: { all: [], default: {} } }) },
    global: { dispose: async () => { calls.disposes++ } },
    session: {
      active: async () => { calls.active++; return { data: { ses_long: { type: "running" } } } },
      get: async () => ({ data: { id: "ses_long", title: "Long task", agent: "build", directory: globalDir } }),
    },
  },
  ui: {
    toast: () => {},
    dialog: { setSize: () => {}, replace: () => null, clear: () => {} },
    DialogConfirm: () => null,
    DialogSelect: () => null,
    DialogPrompt: () => null,
  },
}

await tui(api)
T.setStudioSettings({ capture: { hiddenSections: [] }, modules: { enabled: {}, options: {} } })
T.suppressDuplicateDialog()

// Scripted probe: confirm saves, infos just close, menus recorded.
let phase = "save"
T.__setMenuProbe({
  onConfirm: (title) => { calls.confirms.push(title); return true },
  onInfo: () => undefined,
  onPaged: () => undefined,
  onMenu: (title, options) => {
    calls.menus.push(title)
    // Answer the write-target picker (values are file paths); cancel others.
    const fileOption = options.find((option) => typeof option.value === "string" && /^[A-Za-z]:[\\/]/.test(option.value))
    if (fileOption) return fileOption.value
    return undefined
  },
})

// --- Session 1: open, stage an mcp toggle, save & exit (deferred) ---
const state1 = await T.refreshStudio(api)
const staged = await T.applyEditsForTest(api, state1, [{ op: "set", path: ["mcp", "demo", "enabled"], value: false }], "mcp demo disabled")
console.log("staged:", staged, "| pending:", state1.pending.length)

await T.saveAndExitForTest(api, state1)
const written = JSON.parse(readFileSync(configPath, "utf8"))
const savedPending = state1.pending.length
const savedDisposes = calls.disposes

// --- Session 2: reopen, then just exit ---
const state2 = await T.refreshStudio(api)
const reopenPending = state2.pending.length
calls.confirms.length = 0
await T.studioExitForTest(api, state2)
const reopenConfirms = calls.confirms.length
console.log("reopen pending:", reopenPending, "| exit confirms:", reopenConfirms)

T.__setMenuProbe(undefined)

// --- Session 3: module (sidecar) change path ---
T.__setMenuProbe({
  onConfirm: (title) => { calls.confirms.push(title); return true },
  onInfo: () => undefined,
  onPaged: () => undefined,
  onMenu: (title, options) => {
    calls.menus.push(title)
    const fileOption = options.find((option) => typeof option.value === "string" && /^[A-Za-z]:[\\/]/.test(option.value))
    if (fileOption) return fileOption.value
    return undefined
  },
})
const state3 = await T.refreshStudio(api)
T.touchAvDraftForTest()
calls.confirms.length = 0
await T.studioExitForTest(api, state3)
const dirtyConfirms = calls.confirms.length
await T.saveAndExitForTest(api, state3)
const state4 = await T.refreshStudio(api)
calls.confirms.length = 0
await T.studioExitForTest(api, state4)
const afterModuleConfirms = calls.confirms.length
console.log("module path: dirty-exit confirms:", dirtyConfirms, "| post-save reopen confirms:", afterModuleConfirms)

const assert = (condition, message) => { if (!condition) throw new Error(`save-reentry smoke: ${message}`) }
assert(staged === true, "staging lands in the pending queue")
assert(written.mcp?.demo?.enabled === false, "save & exit writes to disk immediately")
assert(savedPending === 0, "pending cleared after save")
assert(savedDisposes === 0, "reload deferred while a session runs")
assert(reopenPending === 0, "reopen starts with an empty queue")
assert(reopenConfirms === 0, "clean reopen must exit without a discard prompt")
assert(dirtyConfirms === 1, "a dirty module draft must prompt on exit")
assert(afterModuleConfirms === 0, "module save+exit must leave a clean reopen")
console.log("save-reentry smoke passed")

process.exit(0)
