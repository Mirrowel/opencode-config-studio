import { pathToFileURL } from "node:url"
import path from "node:path"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"

ensureRuntimePluginSupport()

const caseName = process.argv[2]
if (caseName !== "silent" && caseName !== "duplicate") {
  console.error("usage: bun scripts/.startup-live-test.mjs silent|duplicate")
  process.exit(1)
}

const root = path.resolve(import.meta.dir, "..")
const { default: mod } = await import(pathToFileURL(path.join(root, "dist", "tui.js")).href)
if (mod?.id !== "config-studio" || typeof mod?.tui !== "function") throw new Error("bad tui export")

function makeMockApi(globalDir) {
  let confirmProps = undefined
  const dialogCalls = []
  const clientCalls = { providerList: 0, configProviders: 0 }
  const api = {
    state: {
      path: { config: globalDir, directory: globalDir, worktree: globalDir },
      config: {},
      provider: [],
    },
    kv: { get: () => undefined, set: () => {} },
    theme: { current: { accent: "white", error: "red", success: "green", textMuted: "gray", text: "white", background: "black", primary: "blue", backgroundPanel: "black" } },
    mode: { push: () => () => {} },
    keymap: { registerLayer: () => () => {} },
    command: { register: () => () => {} },
    lifecycle: { onDispose: (fn) => { api.__dispose = fn } },
    renderer: { root: {} },
    client: {
      provider: {
        list: async () => {
          clientCalls.providerList++
          return { data: { all: [], default: {} } }
        },
      },
      config: {
        providers: async () => {
          clientCalls.configProviders++
          return { data: { providers: [] } }
        },
      },
    },
    ui: {
      toast: () => {},
      dialog: {
        setSize: () => {},
        replace: (render, onCancel) => {
          dialogCalls.push(render)
          render()
          setTimeout(() => onCancel?.(), 10)
        },
        clear: () => {},
      },
      DialogConfirm: (props) => {
        confirmProps = props
        return { __confirmProps: props }
      },
      DialogSelect: () => null,
      DialogPrompt: () => null,
    },
  }
  return { api, dialogCalls, clientCalls }
}

const dir = mkdtempSync(path.join(tmpdir(), `studio-startup-${caseName}-`))
const globalDir = path.join(dir, "global")
mkdirSync(path.join(dir, "config-studio"), { recursive: true })
mkdirSync(globalDir, { recursive: true })

try {
  let before = ""
  if (caseName === "duplicate") {
    const avSpec = "file:///C:/Projects/OC%20Plugins/agent-variants"
    before = JSON.stringify({ plugin: [avSpec, "other-plugin"] }, null, 2)
    writeFileSync(path.join(globalDir, "opencode.json"), before, "utf8")
  }

  const { api, dialogCalls, clientCalls } = makeMockApi(globalDir)
  await mod.tui(api)
  await new Promise((resolve) => setTimeout(resolve, 2400))

  if (clientCalls.providerList > 0 || clientCalls.configProviders > 0) {
    throw new Error(`startup must not preload SDK data (provider.list: ${clientCalls.providerList}, config.providers: ${clientCalls.configProviders})`)
  }

  if (caseName === "silent") {
    if (dialogCalls.length !== 0) throw new Error(`expected no dialogs without duplicates, got ${dialogCalls.length}`)
    console.log("startup check silent without duplicates: ok")
  } else {
    if (dialogCalls.length === 0) throw new Error("startup check did not open the duplicate dialog")
    const after = readFileSync(path.join(globalDir, "opencode.json"), "utf8")
    if (after !== before) throw new Error("declining the dialog must not modify files")
    console.log("startup duplicate dialog opens at TUI activation (decline keeps files): ok")
  }
  api.__dispose?.()
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`startup activation test (${caseName}) passed`)
