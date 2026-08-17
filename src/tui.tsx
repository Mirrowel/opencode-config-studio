/** @jsxImportSource @opentui/solid */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { TuiPlugin, TuiPluginApi, TuiDialogSelectOption } from "@opencode-ai/plugin/tui"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createConfigFile, deleteBackup, editConfigFile, loadBackupJournal, readBackupContent, writeTextAtomic, type EditOp, type JSONPath } from "./jsonc.js"
import {
  discoverConfigFiles,
  editableFiles,
  fileAgentEdits,
  fileModelEdits,
  findUneditableLayers,
  getIn,
  mergeWithProvenance,
  provenanceAt,
  summarizeFile,
  type ConfigFileEntry,
  type ProvenancedMerge,
} from "./discovery.js"
import {
  analyzeModel,
  analyzeProviders,
  bodyOneLine,
  computeBaseDefaults,
  fetchModelsDev,
  type ModelAnalysis,
  type ModelsDevCatalog,
  type ProviderAnalysis,
  type RuntimeProviderLike,
  type VariantAnalysis,
} from "./catalog.js"
import { runCapture, diffBodies, type CaptureRunResult } from "./sink.js"
import { ensureTuiRegistration, ourRootDir } from "./selfwire.js"
import { FIELD_DOCS } from "./docs.js"
import { rankOptions } from "./search.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DisplayColor = string | TuiPluginApi["theme"]["current"]["text"]
type WizardSelectOption<Value = unknown> = TuiDialogSelectOption<Value> & {
  color?: DisplayColor
  danger?: boolean
  help?: string
  edited?: boolean
}
type DialogSize = "medium" | "large" | "xlarge"
type KeyContext = { event?: { preventDefault?: () => void; stopPropagation?: () => void } }

interface StudioState {
  files: ConfigFileEntry[]
  merge: ProvenancedMerge
  providers: RuntimeProviderLike[]
  defaults: Record<string, string>
  modelsDev: ModelsDevCatalog
  modelsDevError?: string
  providersSource: "provider-list" | "config-providers" | "state"
  targetFilePath: string | undefined
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_ID = "config-studio"
const UI_SIZE_KV = "config-studio.ui-width"
const UI_HEIGHT_KV = "config-studio.ui-height"
const UI_HEIGHT_PERCENT_KV = "config-studio.ui-height-percent"
const HEIGHT_PERCENT_MIN = 25
const HEIGHT_PERCENT_MAX = 100
const SHIELDED_KEYS = [
  ..."abcdefghijklmnopqrstuvwxyz".split(""),
  ..."0123456789".split(""),
  "space",
  "tab",
  "backspace",
  "delete",
  "home",
  "end",
  "left",
  "right",
  "/",
  "?",
  ":",
  ";",
  "'",
  '"',
  ",",
  ".",
  "-",
  "=",
  "[",
  "]",
  "\\",
  "`",
] as const

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, Math.max(1, max - 3)) + "..."
}

function formatValue(value: unknown): string {
  if (value === undefined) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function prettyJSON(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function safeStateConfig(api: TuiPluginApi): Record<string, unknown> {
  const config = api.state.config as unknown
  if (config && typeof config === "object") return config as Record<string, unknown>
  return {}
}

// ---------------------------------------------------------------------------
// Dialog sizing (adapted from agent-variants)
// ---------------------------------------------------------------------------

type DialogHeight = "compact" | "normal" | "tall" | "max"
const HEIGHT_PRESETS: Array<{ label: DialogHeight; value: number; key: string }> = [
  { label: "compact", value: 32, key: "1" },
  { label: "normal", value: 50, key: "2" },
  { label: "tall", value: 68, key: "3" },
  { label: "max", value: 100, key: "4" },
]

function wizardDialogSize(api: TuiPluginApi): DialogSize {
  const value = api.kv.get<DialogSize>(UI_SIZE_KV, "large")
  if (value === "medium" || value === "large" || value === "xlarge") return value
  return "large"
}

function setWizardDialogSize(api: TuiPluginApi, size: DialogSize) {
  api.kv.set(UI_SIZE_KV, size)
  api.ui.dialog.setSize(size)
}

function nextWizardDialogSize(api: TuiPluginApi): DialogSize {
  const current = wizardDialogSize(api)
  if (current === "medium") return "large"
  if (current === "large") return "xlarge"
  return "medium"
}

function clampHeightPercent(value: number) {
  return Math.max(HEIGHT_PERCENT_MIN, Math.min(HEIGHT_PERCENT_MAX, Math.round(value)))
}

function wizardDialogHeightPercent(api: TuiPluginApi) {
  const value = api.kv.get<number>(UI_HEIGHT_PERCENT_KV, 50)
  return typeof value === "number" && Number.isFinite(value) ? clampHeightPercent(value) : 50
}

function setWizardDialogHeightPercent(api: TuiPluginApi, value: number) {
  api.kv.set(UI_HEIGHT_PERCENT_KV, clampHeightPercent(value))
}

function useWizardDialogSize(api: TuiPluginApi) {
  createEffect(() => api.ui.dialog.setSize(wizardDialogSize(api)))
}

function useHidePromptCursor(api: TuiPluginApi) {
  const editors = collectEditors(api.renderer.root)
  const previous = editors.map((editor) => ({ editor, showCursor: editor.showCursor }))
  for (const editor of editors) {
    editor.showCursor = false
  }
  onCleanup(() => {
    for (const item of previous) {
      if (item.editor.isDestroyed) continue
      item.editor.showCursor = item.showCursor
    }
  })
}

function collectEditors(root: { getChildren?: () => unknown[] }): Array<{ showCursor: boolean; isDestroyed?: boolean; getChildren?: () => unknown[] }> {
  const children = typeof root.getChildren === "function" ? root.getChildren() : []
  return [
    ...(typeof (root as { showCursor?: unknown }).showCursor === "boolean" ? [root as { showCursor: boolean; isDestroyed?: boolean; getChildren?: () => unknown[] }] : []),
    ...children.flatMap((child) => collectEditors(child as { getChildren?: () => unknown[] })),
  ]
}

function shieldBindings(command: string, except: readonly string[] = []) {
  const allowed = new Set(except)
  return SHIELDED_KEYS
    .filter((key) => !allowed.has(key))
    .map((key) => ({ key, cmd: command, desc: "Keep input inside Config Studio" }))
}

function blockKey(ctx: KeyContext | undefined) {
  ctx?.event?.preventDefault?.()
  ctx?.event?.stopPropagation?.()
}

function cappedHeight(count: number, max: number, min = 1) {
  if (count <= 0) return min
  return Math.max(min, Math.min(count, max))
}

function dialogContentWidth(api: TuiPluginApi) {
  const size = wizardDialogSize(api)
  if (size === "xlarge") return 106
  if (size === "large") return 78
  return 50
}

function estimatedVisualRows(message: string, width: number) {
  return message.split(/\r?\n/).reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / Math.max(1, width))), 0)
}

function wizardMaxRows(api: TuiPluginApi, terminalHeight: number, chromeRows: number, minRows: number) {
  const usable = Math.max(minRows, terminalHeight - chromeRows)
  return Math.max(minRows, Math.min(usable, Math.floor(terminalHeight * (wizardDialogHeightPercent(api) / 100))))
}

function menuTitleWidth(size: DialogSize, options: readonly { title: string }[]) {
  const longest = Math.max(0, ...options.map((option) => option.title.length)) + 3
  if (size === "xlarge") return Math.min(Math.max(24, longest), 36)
  if (size === "large") return Math.min(Math.max(24, longest), 30)
  return Math.min(Math.max(22, longest), 26)
}

// ---------------------------------------------------------------------------
// Core dialogs
// ---------------------------------------------------------------------------

type UI = TuiPluginApi["ui"]

/** Option counts at or above this use debounced external search. */
const DEBOUNCE_THRESHOLD = 100
/** How long the filter input must settle before the query runs once. */
const DEBOUNCE_MS = 1200

function showSelect<Value>(
  ui: UI,
  props: {
    title: string
    options: TuiDialogSelectOption<Value>[]
    placeholder?: string
    current?: Value
    flat?: boolean
  },
): Promise<Value | undefined> {
  const debounced = props.options.length >= DEBOUNCE_THRESHOLD
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastQuery = ""
    // Signal-backed option list: with skipFilter DialogSelect never runs its
    // per-keystroke fuzzysort; it only re-renders when this signal changes,
    // which happens once per settled query.
    const [shown, setShown] = createSignal<TuiDialogSelectOption<Value>[]>(props.options)
    const done = (value: Value | undefined) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    const applyQuery = (query: string) => {
      setShown(rankOptions(props.options, query))
    }
    ui.dialog.replace(() =>
      ui.DialogSelect<Value>({
        get title() {
          return props.title
        },
        get placeholder() {
          return props.placeholder ?? (debounced ? "Type query, pause to search (models + providers)..." : "Type to filter...")
        },
        get options() {
          return shown()
        },
        get current() {
          return props.current
        },
        get flat() {
          return props.flat ?? props.options.length < 15
        },
        ...(debounced
          ? {
              skipFilter: true as const,
              onFilter: (query: string) => {
                if (query === lastQuery) return
                lastQuery = query
                if (timer) clearTimeout(timer)
                if (query.trim() === "") {
                  applyQuery(query)
                  return
                }
                timer = setTimeout(() => {
                  timer = undefined
                  applyQuery(query)
                }, DEBOUNCE_MS)
              },
            }
          : {}),
        onSelect: (opt) => {
          done(opt.value)
          ui.dialog.clear()
        },
      }),
      () => done(undefined),
    )
  })
}

type MenuChoice<Value> = { action: "select" | "inspect"; value: Value }

async function showMenu<Value>(api: TuiPluginApi, props: { title: string; options: WizardSelectOption<Value>[]; current?: Value }): Promise<Value | undefined> {
  let current = props.current
  while (true) {
    const choice = await showMenuOnce(api, { ...props, current })
    if (!choice) return undefined
    current = choice.value
    if (choice.action === "select") return choice.value
    const option = props.options.find((item) => item.value === choice.value)
    await showInfo(api, {
      title: option?.title ?? props.title,
      message: option?.help ?? option?.description ?? "No extra help is available for this option.",
    })
  }
}

function showMenuOnce<Value>(api: TuiPluginApi, props: { title: string; options: WizardSelectOption<Value>[]; current?: Value }): Promise<MenuChoice<Value> | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: MenuChoice<Value> | undefined, clear = true) => {
      if (settled) return
      settled = true
      resolve(value)
      if (clear) api.ui.dialog.clear()
    }
    api.ui.dialog.replace(
      () => <MenuDialog api={api} title={props.title} options={props.options} current={props.current} onDone={done} />,
      () => done(undefined, false),
    )
  })
}

function MenuDialog<Value>(props: {
  api: TuiPluginApi
  title: string
  options: WizardSelectOption<Value>[]
  current?: Value
  onDone: (value: MenuChoice<Value> | undefined) => void
}) {
  const theme = () => props.api.theme.current
  useWizardDialogSize(props.api)
  useHidePromptCursor(props.api)
  const dimensions = useTerminalDimensions()
  const listHeight = createMemo(() => cappedHeight(props.options.length, wizardMaxRows(props.api, dimensions().height, 14, 6)))
  const titleWidth = createMemo(() => menuTitleWidth(wizardDialogSize(props.api), props.options))
  let scroll: ScrollBoxRenderable | undefined
  const popMode = props.api.mode.push("config-studio.dialog")
  const [selected, setSelected] = createSignal(Math.max(0, props.options.findIndex((option) => option.value === props.current)))
  const current = createMemo(() => props.options[selected()] ?? props.options[0])
  const move = (delta: number) => setSelected((value) => {
    const next = Math.max(0, Math.min(props.options.length - 1, value + delta))
    scroll?.scrollTo(Math.max(0, next - 2))
    return next
  })
  const choose = () => {
    const option = current()
    if (!option || option.disabled) return
    props.onDone({ action: "select", value: option.value })
  }
  const inspect = () => {
    const option = current()
    if (!option || option.disabled) return
    props.onDone({ action: "inspect", value: option.value })
  }
  const commandPrefix = `config-studio.menu.${Math.random().toString(36).slice(2)}`
  const unregister = props.api.keymap.registerLayer({
    priority: 10000,
    commands: [
      { name: `${commandPrefix}.up`, title: "Previous item", run: (ctx: KeyContext) => { blockKey(ctx); move(-1) } },
      { name: `${commandPrefix}.down`, title: "Next item", run: (ctx: KeyContext) => { blockKey(ctx); move(1) } },
      { name: `${commandPrefix}.select`, title: "Select item", run: (ctx: KeyContext) => { blockKey(ctx); choose() } },
      { name: `${commandPrefix}.inspect`, title: "Item help", run: (ctx: KeyContext) => { blockKey(ctx); inspect() } },
      { name: `${commandPrefix}.back`, title: "Back", run: (ctx: KeyContext) => { blockKey(ctx); props.onDone(undefined) } },
      { name: `${commandPrefix}.shield`, title: "Block background input", run: blockKey },
    ],
    bindings: [
      { key: "up", cmd: `${commandPrefix}.up`, desc: "Previous item" },
      { key: "ctrl+p", cmd: `${commandPrefix}.up`, desc: "Previous item" },
      { key: "down", cmd: `${commandPrefix}.down`, desc: "Next item" },
      { key: "ctrl+n", cmd: `${commandPrefix}.down`, desc: "Next item" },
      { key: "enter", cmd: `${commandPrefix}.select`, desc: "Select item" },
      { key: "i", cmd: `${commandPrefix}.inspect`, desc: "Item help" },
      { key: "escape", cmd: `${commandPrefix}.back`, desc: "Back" },
      ...shieldBindings(`${commandPrefix}.shield`, ["i"]),
    ],
  })
  onCleanup(() => {
    unregister()
    popMode()
  })

  return (
    <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" width="100%" marginBottom={1}>
        <text fg={theme().text}><b>{props.title}</b></text>
        <text fg={theme().textMuted} onMouseUp={() => props.onDone(undefined)}>esc</text>
      </box>
      <box flexDirection="row" gap={3} marginBottom={1}>
        <text fg={theme().textMuted}>enter select</text>
        <text fg={theme().textMuted}>up/down move</text>
        <text fg={theme().textMuted}>i help</text>
      </box>
      <scrollbox maxHeight={listHeight()} ref={(element: ScrollBoxRenderable) => (scroll = element)}>
      <box flexDirection="column" gap={0}>
        <For each={props.options}>
          {(option, index) => {
            const active = createMemo(() => selected() === index())
            const fg = createMemo(() => active() ? theme().background : option.danger ? theme().error : option.color ?? (option.edited ? theme().success : theme().text))
            const descFg = createMemo(() => active() ? theme().background : option.edited ? theme().success : theme().textMuted)
            return (
              <box
                flexDirection="row"
                width="100%"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={active() ? theme().primary : theme().backgroundPanel}
                onMouseOver={() => setSelected(index())}
                onMouseUp={() => {
                  if (!option.disabled) props.onDone({ action: "select", value: option.value })
                }}
              >
                <text width={titleWidth()} flexShrink={0} fg={fg()} wrapMode="none" overflow="hidden"><b>{option.title}</b></text>
                <text flexGrow={1} fg={descFg()} wrapMode="none" overflow="hidden">{option.description ?? ""}</text>
              </box>
            )
          }}
        </For>
      </box>
      </scrollbox>
    </box>
  )
}

function showPrompt(
  ui: UI,
  props: {
    title: string
    description?: string
    placeholder?: string
    value?: string
  },
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: string | undefined) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    ui.dialog.replace(() =>
      ui.DialogPrompt({
        title: props.title,
        placeholder: props.placeholder,
        value: props.value ?? "",
        onConfirm: (val) => {
          done(val)
          ui.dialog.clear()
        },
        onCancel: () => {
          done(undefined)
          ui.dialog.clear()
        },
      }),
      () => done(undefined),
    )
  })
}

function showConfirm(
  ui: UI,
  props: {
    title: string
    message: string
    confirmLabel?: string
  },
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: boolean) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    ui.dialog.replace(() =>
      ui.DialogConfirm({
        title: props.title,
        message: props.message,
        ...(props.confirmLabel ? { confirmLabel: props.confirmLabel } : {}),
        onConfirm: () => {
          done(true)
          ui.dialog.clear()
        },
        onCancel: () => {
          done(false)
          ui.dialog.clear()
        },
      }),
      () => done(false),
    )
  })
}

function showAlert(ui: UI, props: { title: string; message: string }): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
    }
    ui.dialog.replace(() =>
      ui.DialogAlert({
        title: props.title,
        message: props.message,
        onConfirm: () => {
          done()
          ui.dialog.clear()
        },
      }),
      done,
    )
  })
}

function showInfo(api: TuiPluginApi, props: { title: string; message: string }): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
      api.ui.dialog.clear()
    }
    api.ui.dialog.replace(
      () => <InfoDialog api={api} title={props.title} message={props.message} onDone={done} />,
      done,
    )
  })
}

function InfoDialog(props: { api: TuiPluginApi; title: string; message: string; onDone: () => void }) {
  const theme = () => props.api.theme.current
  useWizardDialogSize(props.api)
  useHidePromptCursor(props.api)
  const dimensions = useTerminalDimensions()
  const popMode = props.api.mode.push("config-studio.dialog")
  const lines = createMemo(() => props.message.split(/\r?\n/))
  const visualRows = createMemo(() => estimatedVisualRows(props.message, dialogContentWidth(props.api)))
  const bodyHeight = createMemo(() => cappedHeight(visualRows() + 1, wizardMaxRows(props.api, dimensions().height, 13, 4), 4))
  let scroll: ScrollBoxRenderable | undefined
  const page = () => Math.max(1, (scroll?.height ?? bodyHeight()) - 1)
  const commandPrefix = `config-studio.info.${Math.random().toString(36).slice(2)}`
  const unregister = props.api.keymap.registerLayer({
    priority: 10000,
    commands: [
      { name: `${commandPrefix}.close`, title: "Close", run: (ctx: KeyContext) => { blockKey(ctx); props.onDone() } },
      { name: `${commandPrefix}.up`, title: "Scroll up", run: (ctx: KeyContext) => { blockKey(ctx); scroll?.scrollBy(-1) } },
      { name: `${commandPrefix}.down`, title: "Scroll down", run: (ctx: KeyContext) => { blockKey(ctx); scroll?.scrollBy(1) } },
      { name: `${commandPrefix}.pageUp`, title: "Page up", run: (ctx: KeyContext) => { blockKey(ctx); scroll?.scrollBy(-page()) } },
      { name: `${commandPrefix}.pageDown`, title: "Page down", run: (ctx: KeyContext) => { blockKey(ctx); scroll?.scrollBy(page()) } },
      { name: `${commandPrefix}.home`, title: "Scroll top", run: (ctx: KeyContext) => { blockKey(ctx); scroll?.scrollTo(0) } },
      { name: `${commandPrefix}.end`, title: "Scroll bottom", run: (ctx: KeyContext) => { blockKey(ctx); scroll?.scrollTo(scroll.scrollHeight) } },
      { name: `${commandPrefix}.shield`, title: "Block background input", run: blockKey },
    ],
    bindings: [
      { key: "enter", cmd: `${commandPrefix}.close`, desc: "Close" },
      { key: "escape", cmd: `${commandPrefix}.close`, desc: "Close" },
      { key: "up", cmd: `${commandPrefix}.up`, desc: "Scroll up" },
      { key: "ctrl+p", cmd: `${commandPrefix}.up`, desc: "Scroll up" },
      { key: "down", cmd: `${commandPrefix}.down`, desc: "Scroll down" },
      { key: "ctrl+n", cmd: `${commandPrefix}.down`, desc: "Scroll down" },
      { key: "pageup", cmd: `${commandPrefix}.pageUp`, desc: "Page up" },
      { key: "ctrl+b", cmd: `${commandPrefix}.pageUp`, desc: "Page up" },
      { key: "pagedown", cmd: `${commandPrefix}.pageDown`, desc: "Page down" },
      { key: "ctrl+f", cmd: `${commandPrefix}.pageDown`, desc: "Page down" },
      { key: "home", cmd: `${commandPrefix}.home`, desc: "Scroll top" },
      { key: "end", cmd: `${commandPrefix}.end`, desc: "Scroll bottom" },
      ...shieldBindings(`${commandPrefix}.shield`, ["home", "end"]),
    ],
  })
  onCleanup(() => {
    unregister()
    popMode()
  })

  return (
    <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" width="100%" marginBottom={1}>
        <text fg={theme().accent}><b>{props.title}</b></text>
        <text fg={theme().textMuted} onMouseUp={props.onDone}>esc</text>
      </box>
      <scrollbox maxHeight={bodyHeight()} ref={(element: ScrollBoxRenderable) => (scroll = element)}>
      <box flexDirection="column" gap={0}>
        <For each={lines()}>
          {(line) => {
            const heading = line.length > 0 && !line.startsWith(" ") && (line.endsWith(":") || /^[A-Z][A-Za-z0-9 ._-]+$/.test(line))
            const warning = /error|failed|refus|invalid|delete|danger/i.test(line)
            const positive = /config|edited|saved|applied|catalog|success/i.test(line)
            return line.length === 0
              ? <text> </text>
              : <text fg={warning ? theme().error : positive && !heading ? theme().success : heading ? theme().accent : theme().textMuted} wrapMode="word">{heading ? <b>{line}</b> : line}</text>
          }}
        </For>
      </box>
      </scrollbox>
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <text fg={theme().textMuted}>{visualRows() > bodyHeight() ? "up/down scroll" : ""}</text>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme().primary} onMouseUp={props.onDone}>
          <text fg={theme().background}><b>ok</b></text>
        </box>
      </box>
    </box>
  )
}

function showBusy(api: TuiPluginApi, title: string, work: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      api.ui.dialog.clear()
      resolve()
    }
    const theme = () => api.theme.current
    api.ui.dialog.replace(
      () => (
        <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={2} paddingBottom={2}>
          <text fg={theme().accent}><b>{title}</b></text>
          <text fg={theme().textMuted}>working... (esc does not cancel)</text>
        </box>
      ),
      () => {},
    )
    work.catch(() => {}).finally(done)
  })
}

// ---------------------------------------------------------------------------
// Studio state
// ---------------------------------------------------------------------------

function studioDataDir(api: TuiPluginApi): string {
  return join(api.state.path.config, PLUGIN_ID)
}

async function fetchProviders(api: TuiPluginApi): Promise<{ providers: RuntimeProviderLike[]; defaults: Record<string, string>; source: StudioState["providersSource"] }> {
  const client = api.client as unknown as {
    provider?: { list?: (params?: unknown) => Promise<unknown> }
    config?: { providers?: (params?: unknown) => Promise<unknown> }
  }
  const unwrap = (result: unknown): Record<string, unknown> | undefined => {
    if (!result || typeof result !== "object") return undefined
    const record = result as Record<string, unknown>
    const data = record["data"]
    if (data && typeof data === "object" && !("error" in record && record["error"])) return data as Record<string, unknown>
    return record
  }
  try {
    if (typeof client.provider?.list === "function") {
      const result = unwrap(await client.provider.list())
      const all = result?.["all"]
      if (Array.isArray(all)) {
        return {
          providers: all as RuntimeProviderLike[],
          defaults: (result?.["default"] as Record<string, string>) ?? {},
          source: "provider-list",
        }
      }
    }
  } catch {
    // fall through
  }
  try {
    if (typeof client.config?.providers === "function") {
      const result = unwrap(await client.config.providers())
      const providers = result?.["providers"]
      if (Array.isArray(providers)) {
        return {
          providers: providers as RuntimeProviderLike[],
          defaults: (result?.["default"] as Record<string, string>) ?? {},
          source: "config-providers",
        }
      }
    }
  } catch {
    // fall through
  }
  return { providers: [...api.state.provider] as RuntimeProviderLike[], defaults: {}, source: "state" }
}

async function refreshStudio(api: TuiPluginApi, previous?: StudioState): Promise<StudioState> {
  const globalConfigDir = api.state.path.config
  const envConfigFile = process.env["OPENCODE_CONFIG"]
  const files = discoverConfigFiles({ globalConfigDir, envConfigFile, directory: api.state.path.directory, worktree: api.state.path.worktree })
  const merge = mergeWithProvenance(files)
  const [providerResult, modelsDevResult] = await Promise.all([
    fetchProviders(api),
    fetchModelsDev(studioDataDir(api)),
  ])
  return {
    files,
    merge,
    providers: providerResult.providers,
    defaults: providerResult.defaults,
    modelsDev: modelsDevResult.catalog,
    modelsDevError: modelsDevResult.error,
    providersSource: providerResult.source,
    targetFilePath: previous?.targetFilePath,
  }
}

async function reloadOpenCode(api: TuiPluginApi): Promise<boolean> {
  const client = api.client as unknown as { global?: { dispose?: () => Promise<unknown> } }
  try {
    if (typeof client.global?.dispose === "function") {
      await client.global.dispose()
      return true
    }
  } catch {
    // fall through
  }
  return false
}

function fileByID(state: StudioState, id: string): ConfigFileEntry | undefined {
  return state.files.find((file) => file.id === id)
}

function fileByPath(state: StudioState, path: string): ConfigFileEntry | undefined {
  return state.files.find((file) => file.path === path)
}

function fileLabel(state: StudioState, id: string | undefined): string {
  if (!id) return "no file"
  const file = fileByID(state, id)
  return file ? `${file.kind}:${file.label}` : id
}

function strongestFileForPointer(state: StudioState, pointer: JSONPath): ConfigFileEntry | undefined {
  const { winner } = provenanceAt(state.merge, pointer)
  if (winner) return fileByID(state, winner)
  // check ancestors: if a stronger file defines the parent object, its keys win too
  for (let depth = pointer.length - 1; depth > 0; depth--) {
    const ancestorWinner = provenanceAt(state.merge, pointer.slice(0, depth)).winner
    if (ancestorWinner) return fileByID(state, ancestorWinner)
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Write plumbing
// ---------------------------------------------------------------------------

interface WriteContext {
  api: TuiPluginApi
  state: StudioState
}

async function pickWriteTarget(write: WriteContext, pointer: JSONPath, suggestedLabel: string): Promise<string | undefined> {
  const strongest = strongestFileForPointer(write.state, pointer)
  const editable = editableFiles(write.state.files)
  if (editable.length === 0) {
    await showAlert(write.api.ui, {
      title: "No editable config file",
      message: "No existing config file could be found to edit.\n\nUse Config files > Create to add one (for example the global opencode.jsonc).",
    })
    return undefined
  }
  const options: WizardSelectOption<string>[] = editable.map((file) => {
    const summary = summarizeFile(file)
    return {
      title: `${file.kind}:${file.label}`,
      value: file.path,
      description: [
        file.path,
        summary.providerCount > 0 ? `${summary.providerCount} provider entrie(s)` : undefined,
        summary.editedModelCount > 0 ? `${summary.editedModelCount} model edit(s)` : undefined,
        summary.agentCount > 0 ? `${summary.agentCount} agent(s)` : undefined,
        strongest?.path === file.path ? "matches current value source" : undefined,
      ].filter(Boolean).join(" - "),
      edited: true,
      help: `Precedence ${file.precedence + 1} of ${write.state.files.length} layers. ${file.path}`,
    }
  })
  const current = write.state.targetFilePath ?? strongest?.path ?? editable[editable.length - 1]?.path
  const picked = await showMenu(write.api, {
    title: `Edit which file? - ${suggestedLabel}`,
    options,
    current,
  })
  return picked
}

async function resolveTargetFile(write: WriteContext, pointer: JSONPath, suggestedLabel: string): Promise<string | undefined> {
  let target = write.state.targetFilePath
  if (target && !editableFiles(write.state.files).some((file) => file.path === target)) target = undefined
  if (!target) {
    target = await pickWriteTarget(write, pointer, suggestedLabel)
    if (!target) return undefined
    write.state.targetFilePath = target
  }
  // Guard: if a stronger file defines this pointer, writing to the weaker file does nothing.
  const strongest = strongestFileForPointer(write.state, pointer)
  if (strongest && strongest.path !== target) {
    const strongerWins = strongest.precedence > (fileByPath(write.state, target)?.precedence ?? -1)
    if (strongerWins) {
      const writeThere = await showConfirm(write.api.ui, {
        title: "Higher-precedence file owns this value",
        message: [
          `${fileLabel(write.state, strongest.id)} (${strongest.path})`,
          `currently provides this value and would override an edit written to`,
          `${target}.`,
          "",
          "Write to the file that currently wins instead?",
        ].join("\n"),
        confirmLabel: "Write to winning file",
      })
      if (writeThere) {
        target = strongest.path
        write.state.targetFilePath = target
      } else {
        const proceed = await showConfirm(write.api.ui, {
          title: "Write anyway?",
          message: "The value from the higher-precedence file will keep winning, so this edit has no visible effect.",
          confirmLabel: "Write anyway",
        })
        if (!proceed) return undefined
      }
    }
  }
  return target
}

async function applyEdits(
  write: WriteContext,
  ops: EditOp[],
  reason: string,
): Promise<boolean> {
  const pointer = ops[0]?.path ?? []
  const target = await resolveTargetFile(write, pointer, reason)
  if (!target) return false
  const result = editConfigFile(target, ops, { stateDir: studioDataDir(write.api), reason })
  if (!result.ok) {
    await showAlert(write.api.ui, { title: "Edit failed", message: result.error ?? "Unknown error" })
    return false
  }
  const reloaded = await reloadOpenCode(write.api)
  write.api.ui.toast({
    variant: "info",
    title: "Config saved",
    message: `${target}${reloaded ? " - OpenCode config reloaded" : " - restart OpenCode to apply"}`,
  })
  // refresh in-place so follow-up screens see the new world
  const updated = await refreshStudio(write.api, write.state)
  Object.assign(write.state, updated)
  return true
}

// ---------------------------------------------------------------------------
// JSON editor
// ---------------------------------------------------------------------------

async function showJSONEditor(api: TuiPluginApi, title: string, value: unknown): Promise<Record<string, unknown> | undefined | "__delete__"> {
  const current = value === undefined ? "" : JSON.stringify(value, null, 2)
  while (true) {
    const input = await showPrompt(api.ui, {
      title,
      placeholder: "{ } - empty removes the entry",
      value: current,
    })
    if (input === undefined) return undefined
    if (input.trim() === "") return "__delete__"
    try {
      const parsed = JSON.parse(input) as unknown
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        await showAlert(api.ui, { title: "Invalid shape", message: "Enter a JSON object ( {...} ), not an array or scalar." })
        continue
      }
      return parsed as Record<string, unknown>
    } catch (error) {
      await showAlert(api.ui, { title: "Invalid JSON", message: error instanceof Error ? error.message : String(error) })
    }
  }
}

// ---------------------------------------------------------------------------
// Info doc helpers
// ---------------------------------------------------------------------------

function docText(docId: string, extra?: string[]): string {
  const doc = FIELD_DOCS[docId]
  const lines: string[] = []
  if (doc) {
    lines.push(doc.summary, "")
    lines.push(...doc.lines)
  } else {
    lines.push("No documentation available.")
  }
  if (extra?.length) {
    lines.push("", "Current:", ...extra)
  }
  return lines.join("\n")
}

function variantInfoText(state: StudioState, analysis: ModelAnalysis, variant: VariantAnalysis): string {
  const lines: string[] = []
  lines.push(`Variant ${variant.name} on ${analysis.providerID}/${analysis.modelID}`, "")
  lines.push(FIELD_DOCS["model.variants"]!.summary, "")
  lines.push(...FIELD_DOCS["model.variants"]!.lines, "")
  lines.push(`Source: ${describeVariantSource(variant)}`)
  lines.push(`Hidden (disabled): ${variant.disabled ? "yes - config sets disabled: true" : "no"}`)
  if (variant.files.length > 0) lines.push(`Config files: ${variant.files.map((id) => fileLabel(state, id)).join(", ")}`)
  lines.push(`Resolved body (what requests send): ${prettyJSON(variant.resolvedBody)}`)
  if (variant.derivedBody) lines.push(`Catalog-derived body: ${prettyJSON(variant.derivedBody)}`)
  if (variant.configBody) lines.push(`Config body (file content incl. disabled flag): ${prettyJSON(variant.configBody)}`)
  if (variant.keyProvenance.some((key) => key.source === "config")) {
    lines.push("", "Config-overridden keys:")
    for (const key of variant.keyProvenance.filter((key) => key.source === "config")) {
      lines.push(`  ${key.key} = ${formatValue(key.value)} (${key.fileIDs.map((id) => fileLabel(state, id)).join(", ")})`)
    }
  }
  const docKeys = Object.keys(variant.resolvedBody).filter((key) => FIELD_DOCS[`variant.${key}`])
  for (const key of docKeys) {
    const doc = FIELD_DOCS[`variant.${key}`]!
    lines.push("", `${doc.title}:`, doc.summary)
  }
  lines.push("", FIELD_DOCS["concept.request"]!.summary)
  return lines.join("\n")
}

function describeVariantSource(variant: VariantAnalysis): string {
  switch (variant.source) {
    case "catalog-effort": return "catalog (models.dev effort tier)"
    case "catalog-budget": return "catalog (models.dev token budget)"
    case "catalog-toggle": return "catalog (models.dev thinking toggle)"
    case "catalog-heuristic": return "catalog (OpenCode SDK heuristic)"
    case "config": return "user config"
    case "disabled": return "hidden by config"
  }
}

function defaultInfoText(state: StudioState, analysis: ModelAnalysis): string {
  const base = computeBaseDefaults(analysis.runtime.api?.npm, analysis.providerID, analysis.runtime)
  const lines: string[] = []
  lines.push(`Default (no variant) for ${analysis.providerID}/${analysis.modelID}`, "")
  lines.push(...FIELD_DOCS["model.options"]!.lines, "")
  lines.push(`Computed base defaults (approximation): ${prettyJSON(base.options)}`)
  for (const note of base.notes) lines.push(note)
  lines.push("")
  lines.push(`Config model options (${analysis.configOptions ? `set - ${analysis.configOptionsFiles.map((id) => fileLabel(state, id)).join(", ")}` : "not set"}):`)
  lines.push(analysis.configOptions ? prettyJSON(analysis.configOptions) : "{} - add options to change what default sends")
  lines.push("")
  lines.push(`Small-model requests (titles/summaries) use the first variant body instead:`)
  lines.push(analysis.smallModelBody ? prettyJSON(analysis.smallModelBody) : "(model has no variants - base defaults only)")
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------------

async function mainMenu(api: TuiPluginApi, state: StudioState): Promise<void> {
  const editedProviders = analyzeProviders(state.providers, state.defaults, state.merge).filter((provider) => provider.edited).length
  const opts: WizardSelectOption<string>[] = [
    {
      title: "Browse providers & models",
      value: "browse",
      description: `${state.providers.length} provider(s), ${editedProviders} edited`,
      help: "Open the model browser. Providers and models edited in any config file are listed first and highlighted.",
    },
    {
      title: "Default model",
      value: "root-model",
      description: "Root model and small_model pickers",
      help: docText("root.model") + "\n\n" + docText("root.small_model"),
    },
    {
      title: "Agents",
      value: "agents",
      description: "Agent model, variant, temperature, top_p",
      help: docText("root.agent"),
    },
    {
      title: "Config files",
      value: "files",
      description: `${editableFiles(state.files).length} editable layer(s)`,
      help: docText("concept.precedence"),
    },
    {
      title: "Diagnostics",
      value: "diagnostics",
      description: "Merge report, hidden layers, backups",
      help: "Cross-checks your files against OpenCode's resolved config and lists keys that come from non-file layers.",
    },
    {
      title: "How it works",
      value: "info",
      description: "Requests, variants, precedence, capture",
      help: "Overview of the request pipeline and how this plugin reads and edits config.",
    },
    {
      title: "Wizard UI",
      value: "ui",
      description: `Width ${wizardDialogSize(api)}, height ${wizardDialogHeightPercent(api)}%`,
      help: "Dialog sizing for Config Studio screens.",
    },
  ]

  const action = await showMenu(api, { title: "Config Studio", options: opts })
  switch (action) {
    case "browse":
      return providerBrowser(api, state)
    case "root-model":
      return rootModelScreen(api, state)
    case "agents":
      return agentsScreen(api, state)
    case "files":
      return configFilesScreen(api, state)
    case "diagnostics":
      return diagnosticsScreen(api, state)
    case "info":
      await showInfo(api, { title: "Config Studio", message: overviewText() })
      return mainMenu(api, state)
    case "ui":
      return uiScreen(api, state)
    default:
      return
  }
}

function overviewText(): string {
  return [
    FIELD_DOCS["concept.request"]!.title + ":",
    ...FIELD_DOCS["concept.request"]!.lines,
    "",
    FIELD_DOCS["concept.precedence"]!.title + ":",
    ...FIELD_DOCS["concept.precedence"]!.lines,
    "",
    FIELD_DOCS["concept.catalog"]!.title + ":",
    ...FIELD_DOCS["concept.catalog"]!.lines,
    "",
    FIELD_DOCS["concept.capture"]!.title + ":",
    ...FIELD_DOCS["concept.capture"]!.lines,
    "",
    FIELD_DOCS["concept.hotreload"]!.title + ":",
    ...FIELD_DOCS["concept.hotreload"]!.lines,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Provider / model browser
// ---------------------------------------------------------------------------

async function providerBrowser(api: TuiPluginApi, state: StudioState): Promise<void> {
  const analyses = analyzeProviders(state.providers, state.defaults, state.merge)
  const options: WizardSelectOption<string>[] = analyses.map((provider) => ({
    title: provider.providerID,
    value: provider.providerID,
    description: [
      provider.name !== provider.providerID ? provider.name : undefined,
      `${provider.modelCount} model(s)`,
      provider.editedModelCount > 0 ? `${provider.editedModelCount} edited` : undefined,
      provider.isDefaultProvider ? "default provider" : undefined,
      provider.source ? `source: ${provider.source}` : undefined,
    ].filter(Boolean).join(" - "),
    edited: provider.edited,
    help: [
      `Provider ${provider.providerID} (${provider.name})`,
      provider.npm ? `Runtime package: ${provider.npm}` : "Runtime package: unknown",
      provider.source ? `Catalog source: ${provider.source}` : undefined,
      provider.edited ? "This provider has config-file edits." : "No config-file edits for this provider.",
    ].filter(Boolean).join("\n"),
  }))
  options.push({ title: "< Back", value: "__back__", description: "Return to main menu" })

  const picked = await showMenu(api, { title: "Providers - edited first", options })
  if (!picked || picked === "__back__") return mainMenu(api, state)
  return modelBrowser(api, state, picked)
}

async function modelBrowser(api: TuiPluginApi, state: StudioState, providerID: string): Promise<void> {
  const provider = state.providers.find((item) => item.id === providerID)
  if (!provider) {
    await showAlert(api.ui, { title: "Provider not found", message: providerID })
    return providerBrowser(api, state)
  }
  const models = Object.entries(provider.models ?? {})
  const options: WizardSelectOption<string>[] = models.map(([modelID, model]) => {
    const editedFiles = provenanceAt(state.merge, ["provider", providerID, "models", modelID]).contributors
    const isDefault = state.defaults[providerID] === modelID
    return {
      title: modelID,
      value: modelID,
      description: [
        model.name !== modelID ? model.name : undefined,
        model.variants ? `${Object.keys(model.variants).length} variant(s)` : "no variants",
        isDefault ? "default model" : undefined,
        editedFiles.length > 0 ? `edited (${editedFiles.map((id) => fileLabel(state, id)).join(", ")})` : undefined,
      ].filter(Boolean).join(" - "),
      edited: editedFiles.length > 0,
      help: [
        `Model ${providerID}/${modelID}`,
        `Name: ${model.name}`,
        model.variants ? `Variants: ${Object.keys(model.variants).join(", ")}` : "Variants: none",
        editedFiles.length > 0 ? `Edited in: ${editedFiles.map((id) => fileLabel(state, id)).join(", ")}` : "Not edited in any config file",
      ].join("\n"),
    }
  })
  options.sort((a, b) => {
    if (a.edited !== b.edited) return a.edited ? -1 : 1
    return a.title.localeCompare(b.title)
  })
  options.push({ title: "< Back", value: "__back__", description: "Return to provider list" })

  const picked = await showMenu(api, { title: `Models - ${providerID}`, options })
  if (!picked || picked === "__back__") return providerBrowser(api, state)
  return modelDetail(api, state, providerID, picked)
}

// ---------------------------------------------------------------------------
// Model detail
// ---------------------------------------------------------------------------

async function modelDetail(api: TuiPluginApi, state: StudioState, providerID: string, modelID: string): Promise<void> {
  const provider = state.providers.find((item) => item.id === providerID)
  const runtime = provider?.models?.[modelID]
  if (!runtime) {
    await showAlert(api.ui, { title: "Model not found", message: `${providerID}/${modelID}` })
    return modelBrowser(api, state, providerID)
  }
  const analysis = analyzeModel(runtime, providerID, modelID, state.merge, state.modelsDev)
  const agentUsage = agentsUsingModel(api, state, providerID, modelID)

  const options: WizardSelectOption<string>[] = [
    {
      title: "Variants",
      value: "variants",
      description: `${analysis.variants.filter((variant) => !variant.disabled).length} active, ${analysis.variants.filter((variant) => variant.disabled).length} hidden`,
      help: docText("model.variants"),
    },
    {
      title: "Default options",
      value: "default",
      description: analysis.configOptions ? bodyOneLine(analysis.configOptions, 50) : "not set - base defaults apply",
      edited: Boolean(analysis.configOptions),
      help: docText("model.options"),
    },
    {
      title: "Capture real request",
      value: "capture",
      description: "Run the pipeline against a local sink",
      help: docText("concept.capture"),
    },
    {
      title: "Agent usage",
      value: "usage",
      description: agentUsage.length > 0 ? `${agentUsage.length} agent(s)` : "no agents target this model",
      help: "Agents that reference this model. Their variant selection applies only with this model.",
    },
    {
      title: "Model info [i]",
      value: "info",
      description: "Metadata, limits, costs",
      help: modelMetaInfo(state, analysis),
    },
    { title: "< Back", value: "__back__", description: "Return to model list" },
  ]

  const picked = await showMenu(api, { title: `${providerID}/${modelID}`, options })
  switch (picked) {
    case "variants":
      return variantList(api, state, analysis)
    case "default":
      return defaultOptionsEditor(api, state, analysis)
    case "capture":
      return captureFlow(api, state, analysis)
    case "usage":
      await showInfo(api, { title: `Agent usage - ${modelID}`, message: agentUsage.length > 0 ? agentUsage.join("\n") : "No agents reference this model." })
      return modelDetail(api, state, providerID, modelID)
    case "info":
      await showInfo(api, { title: `${providerID}/${modelID}`, message: modelMetaInfo(state, analysis) })
      return modelDetail(api, state, providerID, modelID)
    default:
      return modelBrowser(api, state, providerID)
  }
}

function modelMetaInfo(state: StudioState, analysis: ModelAnalysis): string {
  const model = analysis.runtime
  const lines: string[] = [
    `${analysis.providerID}/${analysis.modelID}`,
    "",
    `Name: ${model.name}`,
    model.api?.npm ? `Runtime package: ${model.api.npm}` : "Runtime package: unknown",
    model.api?.id ? `Provider model id: ${model.api.id}` : undefined,
    `Reasoning: ${model.capabilities?.reasoning ? "yes" : "no"}`,
    `Temperature: ${model.capabilities?.temperature === false ? "unsupported" : "supported"}`,
    model.limit ? `Limits: context ${model.limit.context}, output ${model.limit.output}` : undefined,
    model.cost ? `Cost per Mtok: ${formatValue((model.cost as Record<string, unknown>)["input"])}, ${formatValue((model.cost as Record<string, unknown>)["output"])}` : undefined,
  ].filter(Boolean).map(String) as string[]
  const editedFiles = provenanceAt(state.merge, ["provider", analysis.providerID, "models", analysis.modelID]).contributors
  lines.push(`Config edits: ${editedFiles.length > 0 ? editedFiles.map((id) => fileLabel(state, id)).join(", ") : "none"}`)
  return lines.join("\n")
}

function agentsUsingModel(api: TuiPluginApi, state: StudioState, providerID: string, modelID: string): string[] {
  const ref = `${providerID}/${modelID}`
  const result: string[] = []
  const config = safeStateConfig(api)
  const agent = config["agent"]
  if (agent && typeof agent === "object") {
    for (const [name, entry] of Object.entries(agent as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue
      const record = entry as Record<string, unknown>
      if (record["model"] === ref) {
        result.push(`${name}: model ${ref}${typeof record["variant"] === "string" ? `, variant ${record["variant"]}` : ", default variant"}`)
      }
    }
  }
  if (config["model"] === ref) result.push(`root default model: ${ref}`)
  if (config["small_model"] === ref) result.push(`small_model: ${ref}`)
  return result
}

// ---------------------------------------------------------------------------
// Variant list + editor
// ---------------------------------------------------------------------------

async function variantList(api: TuiPluginApi, state: StudioState, analysis: ModelAnalysis): Promise<void> {
  const options: WizardSelectOption<string>[] = analysis.variants.map((variant) => ({
    title: variant.name,
    value: variant.name,
    description: [
      variant.disabled ? "HIDDEN" : describeVariantSource(variant),
      bodyOneLine(variant.resolvedBody, 44),
    ].filter(Boolean).join(" - "),
    edited: variant.files.length > 0,
    danger: variant.disabled,
    help: variantInfoText(state, analysis, variant),
  }))
  options.push({ title: "+ Add variant", value: "__add__", description: "Define a new variant in config", help: docText("model.variants") })
  options.push({ title: "< Back", value: "__back__", description: "Return to model detail" })

  const picked = await showMenu(api, { title: `Variants - ${analysis.modelID}`, options })
  if (!picked || picked === "__back__") return modelDetail(api, state, analysis.providerID, analysis.modelID)
  if (picked === "__add__") return addVariantFlow(api, state, analysis)
  const variant = analysis.variants.find((item) => item.name === picked)!
  return variantDetail(api, state, analysis, variant)
}

async function addVariantFlow(api: TuiPluginApi, state: StudioState, analysis: ModelAnalysis): Promise<void> {
  const name = await showPrompt(api.ui, { title: "New variant name", placeholder: "e.g. medium, fast, deep" })
  if (!name || name.trim() === "") return variantList(api, state, analysis)
  const trimmed = name.trim()
  if (analysis.variants.some((variant) => variant.name === trimmed)) {
    await showAlert(api.ui, { title: "Variant exists", message: `A variant named ${trimmed} already exists on this model.` })
    return variantList(api, state, analysis)
  }
  const body = await showJSONEditor(api, `Variant body - ${trimmed} (flat options object)`, { reasoningEffort: "high" })
  if (body === undefined) return variantList(api, state, analysis)
  if (body === "__delete__") {
    await showAlert(api.ui, { title: "Empty body", message: "A variant needs at least one option key. Nothing was written." })
    return variantList(api, state, analysis)
  }
  const write: WriteContext = { api, state }
  const ok = await applyEdits(write, [{ op: "set", path: ["provider", analysis.providerID, "models", analysis.modelID, "variants", trimmed], value: body }], `add variant ${trimmed}`)
  if (ok) return variantList(api, state, refreshedAnalysis(api, state, analysis))
  return variantList(api, state, analysis)
}

function refreshedAnalysis(api: TuiPluginApi, state: StudioState, previous: ModelAnalysis): ModelAnalysis {
  const provider = state.providers.find((item) => item.id === previous.providerID)
  const runtime = provider?.models?.[previous.modelID]
  if (!runtime) return previous
  return analyzeModel(runtime, previous.providerID, previous.modelID, state.merge, state.modelsDev)
}

async function variantDetail(api: TuiPluginApi, state: StudioState, analysis: ModelAnalysis, variant: VariantAnalysis): Promise<void> {
  const write: WriteContext = { api, state }
  const variantPath: JSONPath = ["provider", analysis.providerID, "models", analysis.modelID, "variants", variant.name]
  const options: WizardSelectOption<string>[] = [
    { title: "Edit body (JSON)", value: "edit", description: bodyOneLine(variant.configBody ?? variant.resolvedBody, 50), help: variantInfoText(state, analysis, variant) },
    {
      title: variant.disabled ? "Enable variant" : "Disable variant",
      value: "toggle-disabled",
      description: variant.disabled ? "Remove the disabled flag from config" : "Set disabled: true - hides it from the picker",
      help: docText("model.variants"),
    },
    { title: "Delete from config", value: "delete", description: "Remove the config entry entirely", danger: true, help: "Deletes the variant entry from the config file. Catalog-derived variants disappear only while disabled; deletion removes any config override." },
    { title: "Copy body to default options", value: "copy-default", description: "Make default send this variant's body", help: docText("model.options") },
    { title: "Capture with this variant", value: "capture", description: "See the exact request it sends", help: docText("concept.capture") },
    { title: "Variant info [i]", value: "info", description: "Full provenance and docs", help: variantInfoText(state, analysis, variant) },
    { title: "< Back", value: "__back__", description: "Return to variant list" },
  ]

  const picked = await showMenu(api, { title: `Variant ${variant.name}`, options })
  switch (picked) {
    case "edit": {
      const body = await showJSONEditor(api, `Variant body - ${variant.name}`, variant.configBody ?? variant.resolvedBody)
      if (body === undefined) return variantDetail(api, state, analysis, variant)
      if (body === "__delete__") {
        const confirmed = await showConfirm(api.ui, { title: "Delete variant", message: `Remove the config entry for ${variant.name}?` })
        if (confirmed) {
          await applyEdits(write, [{ op: "delete", path: variantPath }], `delete variant ${variant.name}`)
          return variantList(api, state, refreshedAnalysis(api, state, analysis))
        }
        return variantDetail(api, state, analysis, variant)
      }
      const ok = await applyEdits(write, [{ op: "set", path: variantPath, value: body }], `edit variant ${variant.name}`)
      if (ok) return variantList(api, state, refreshedAnalysis(api, state, analysis))
      return variantDetail(api, state, analysis, variant)
    }
    case "toggle-disabled": {
      if (variant.disabled) {
        const configBody = variant.configBody ?? {}
        const onlyDisabled = Object.keys(configBody).every((key) => key === "disabled")
        const ok = await applyEdits(
          write,
          onlyDisabled
            ? [{ op: "delete", path: variantPath }]
            : [{ op: "set", path: variantPath, value: { ...configBody, disabled: false } }],
          `enable variant ${variant.name}`,
        )
        if (ok) return variantList(api, state, refreshedAnalysis(api, state, analysis))
      } else {
        const ok = await applyEdits(write, [{ op: "set", path: variantPath, value: { ...(variant.configBody ?? {}), disabled: true } }], `disable variant ${variant.name}`)
        if (ok) return variantList(api, state, refreshedAnalysis(api, state, analysis))
      }
      return variantDetail(api, state, analysis, variant)
    }
    case "delete": {
      const confirmed = await showConfirm(api.ui, {
        title: "Delete variant",
        message: `Delete the config entry for ${variant.name}?\nCatalog-derived variants remain available after deletion of a pure overlay; use Disable to hide them.`,
      })
      if (!confirmed) return variantDetail(api, state, analysis, variant)
      const ok = await applyEdits(write, [{ op: "delete", path: variantPath }], `delete variant ${variant.name}`)
      if (ok) return variantList(api, state, refreshedAnalysis(api, state, analysis))
      return variantDetail(api, state, analysis, variant)
    }
    case "copy-default": {
      const confirmed = await showConfirm(api.ui, {
        title: "Copy variant to default",
        message: `Write the body of ${variant.name} into models.${analysis.modelID}.options?\nDefault (no-variant) requests will then send these keys.`,
      })
      if (!confirmed) return variantDetail(api, state, analysis, variant)
      const ok = await applyEdits(
        write,
        [{ op: "set", path: ["provider", analysis.providerID, "models", analysis.modelID, "options"], value: variant.resolvedBody }],
        `copy variant ${variant.name} to default options`,
      )
      if (ok) return modelDetail(api, state, analysis.providerID, analysis.modelID)
      return variantDetail(api, state, analysis, variant)
    }
    case "capture":
      return captureFlow(api, state, analysis, variant.name)
    case "info":
      await showInfo(api, { title: `Variant ${variant.name}`, message: variantInfoText(state, analysis, variant) })
      return variantDetail(api, state, analysis, variant)
    default:
      return variantList(api, state, analysis)
  }
}

// ---------------------------------------------------------------------------
// Default options editor
// ---------------------------------------------------------------------------

async function defaultOptionsEditor(api: TuiPluginApi, state: StudioState, analysis: ModelAnalysis): Promise<void> {
  const write: WriteContext = { api, state }
  const optionsPath: JSONPath = ["provider", analysis.providerID, "models", analysis.modelID, "options"]
  const options: WizardSelectOption<string>[] = [
    {
      title: "Edit options (JSON)",
      value: "edit",
      description: analysis.configOptions ? bodyOneLine(analysis.configOptions, 50) : "not set",
      edited: Boolean(analysis.configOptions),
      help: defaultInfoText(state, analysis),
    },
    {
      title: "Copy from variant",
      value: "copy",
      description: "Materialize a variant body here",
      help: docText("model.options"),
    },
    {
      title: "Clear options",
      value: "clear",
      description: "Remove the config entry - base defaults apply",
      danger: Boolean(analysis.configOptions),
      help: docText("model.options"),
    },
    {
      title: "View what default sends",
      value: "view",
      description: "Base defaults preview + config options",
      help: defaultInfoText(state, analysis),
    },
    {
      title: "Capture default request",
      value: "capture",
      description: "Ground truth via local sink",
      help: docText("concept.capture"),
    },
    { title: "< Back", value: "__back__", description: "Return to model detail" },
  ]

  const picked = await showMenu(api, { title: `Default options - ${analysis.modelID}`, options })
  switch (picked) {
    case "edit": {
      const body = await showJSONEditor(api, `models.${analysis.modelID}.options`, analysis.configOptions)
      if (body === undefined) return defaultOptionsEditor(api, state, analysis)
      if (body === "__delete__") {
        const confirmed = await showConfirm(api.ui, { title: "Clear default options", message: "Remove the options entry from config?" })
        if (confirmed) {
          await applyEdits(write, [{ op: "delete", path: optionsPath }], "clear default options")
          return modelDetail(api, state, analysis.providerID, analysis.modelID)
        }
        return defaultOptionsEditor(api, state, analysis)
      }
      const ok = await applyEdits(write, [{ op: "set", path: optionsPath, value: body }], `edit default options ${analysis.modelID}`)
      if (ok) return modelDetail(api, state, analysis.providerID, analysis.modelID)
      return defaultOptionsEditor(api, state, analysis)
    }
    case "copy": {
      const active = analysis.variants.filter((variant) => !variant.disabled)
      if (active.length === 0) {
        await showAlert(api.ui, { title: "No variants", message: "This model has no variants to copy from." })
        return defaultOptionsEditor(api, state, analysis)
      }
      const pickedVariant = await showMenu(api, {
        title: "Copy which variant body?",
        options: active.map((variant) => ({
          title: variant.name,
          value: variant.name,
          description: bodyOneLine(variant.resolvedBody, 50),
          edited: variant.files.length > 0,
          help: variantInfoText(state, analysis, variant),
        })),
      })
      if (!pickedVariant) return defaultOptionsEditor(api, state, analysis)
      const variant = active.find((item) => item.name === pickedVariant)!
      const ok = await applyEdits(write, [{ op: "set", path: optionsPath, value: variant.resolvedBody }], `copy variant ${variant.name} to default options`)
      if (ok) return modelDetail(api, state, analysis.providerID, analysis.modelID)
      return defaultOptionsEditor(api, state, analysis)
    }
    case "clear": {
      const confirmed = await showConfirm(api.ui, { title: "Clear default options", message: "Remove the options entry from config?" })
      if (!confirmed) return defaultOptionsEditor(api, state, analysis)
      const ok = await applyEdits(write, [{ op: "delete", path: optionsPath }], "clear default options")
      if (ok) return modelDetail(api, state, analysis.providerID, analysis.modelID)
      return defaultOptionsEditor(api, state, analysis)
    }
    case "view":
      await showInfo(api, { title: `Default sends - ${analysis.modelID}`, message: defaultInfoText(state, analysis) })
      return defaultOptionsEditor(api, state, analysis)
    case "capture":
      return captureFlow(api, state, analysis)
    default:
      return modelDetail(api, state, analysis.providerID, analysis.modelID)
  }
}

// ---------------------------------------------------------------------------
// Capture flow
// ---------------------------------------------------------------------------

async function captureFlow(api: TuiPluginApi, state: StudioState, analysis: ModelAnalysis, presetVariant?: string): Promise<void> {
  const provider = state.providers.find((item) => item.id === analysis.providerID)
  if (!provider) {
    await showAlert(api.ui, { title: "Provider missing", message: analysis.providerID })
    return modelDetail(api, state, analysis.providerID, analysis.modelID)
  }
  const active = analysis.variants.filter((variant) => !variant.disabled)
  const options: WizardSelectOption<string>[] = [
    { title: "Capture default (no variant)", value: "__default__", description: "What requests send without a variant", help: docText("concept.capture") },
    ...active.map((variant) => ({
      title: `Capture variant ${variant.name}`,
      value: variant.name,
      description: bodyOneLine(variant.resolvedBody, 50),
      edited: variant.files.length > 0,
      help: variantInfoText(state, analysis, variant),
    })),
  ]
  if (active.length > 0) {
    options.push({
      title: "A/B: default vs variant",
      value: "__ab__",
      description: "Capture both and diff",
      help: "Runs two captures and shows the exact body differences.",
    })
  }
  options.push({ title: "< Back", value: "__back__", description: "Return" })

  const picked = await showMenu(api, {
    title: `Capture request - ${analysis.providerID}/${analysis.modelID}`,
    options,
    current: presetVariant,
  })
  if (!picked || picked === "__back__") return modelDetail(api, state, analysis.providerID, analysis.modelID)

  if (picked === "__ab__") {
    const variantPick = await showMenu(api, {
      title: "Compare default against which variant?",
      options: active.map((variant) => ({ title: variant.name, value: variant.name, description: bodyOneLine(variant.resolvedBody, 50) })),
    })
    if (!variantPick) return captureFlow(api, state, analysis)
    let defaultResult: CaptureRunResult | undefined
    let variantResult: CaptureRunResult | undefined
    await showBusy(api, `Capturing default and ${variantPick}...`, (async () => {
      defaultResult = await runCapture(captureTargetFor(analysis, provider, undefined))
      variantResult = await runCapture(captureTargetFor(analysis, provider, variantPick))
    })())
    if (!defaultResult?.ok || !variantResult?.ok) {
      const failed = !defaultResult?.ok ? defaultResult : variantResult
      await showAlert(api.ui, {
        title: "Capture failed",
        message: [failed?.error ?? "unknown error", "", "Logs (tail):", ...(failed?.logs ?? []).slice(-20)].join("\n"),
      })
      return modelDetail(api, state, analysis.providerID, analysis.modelID)
    }
    const defaultBody = defaultResult.requests[0]?.body
    const variantBody = variantResult!.requests[0]?.body
    const diff = diffBodies(defaultBody, variantBody)
    const lines: string[] = [
      `A/B diff - default vs variant ${variantPick} on ${analysis.providerID}/${analysis.modelID}`,
      "",
      "Default body:",
      prettyJSON(defaultBody),
      "",
      `Variant ${variantPick} body:`,
      prettyJSON(variantBody),
      "",
      diff.length === 0 ? "The two requests send identical bodies." : `Differences (${diff.length}):`,
    ]
    for (const entry of diff) {
      lines.push(`  ${entry.pointer}:`)
      lines.push(`    default: ${truncate(formatValue(entry.a), 90)}`)
      lines.push(`    ${variantPick}: ${truncate(formatValue(entry.b), 90)}`)
    }
    await showInfo(api, { title: `A/B diff - ${variantPick}`, message: lines.join("\n") })
    return modelDetail(api, state, analysis.providerID, analysis.modelID)
  }

  const variantName = picked === "__default__" ? undefined : picked
  await runAndShowCapture(api, analysis, provider, variantName)
  return modelDetail(api, state, analysis.providerID, analysis.modelID)
}

function captureTargetFor(analysis: ModelAnalysis, provider: RuntimeProviderLike, variant: string | undefined) {
  const npm = analysis.runtime.api?.npm ?? provider.models?.[analysis.modelID]?.api?.npm
  return {
    providerID: analysis.providerID,
    modelID: analysis.modelID,
    runtimeModel: analysis.runtime,
    providerNpm: npm,
    variant,
  }
}

async function runAndShowCapture(api: TuiPluginApi, analysis: ModelAnalysis, provider: RuntimeProviderLike, variant: string | undefined): Promise<void> {
  let result: CaptureRunResult | undefined
  await showBusy(api, `Capturing ${variant ? `variant ${variant}` : "default"} request...`, (async () => {
    result = await runCapture(captureTargetFor(analysis, provider, variant))
  })())
  if (!result) return
  if (!result.ok) {
    await showAlert(api.ui, {
      title: "Capture failed",
      message: [
        result.error ?? "unknown error",
        "",
        "Logs (tail):",
        ...result.logs.slice(-20),
      ].join("\n"),
    })
    return
  }
  const primary = result.requests[0]!
  const background = result.requests.slice(1)
  const lines: string[] = [
    `${variant ? `Variant ${variant}` : "Default (no variant)"} on ${analysis.providerID}/${analysis.modelID}`,
    `Captured ${result.requests.length} request(s) in ${result.durationMs}ms - ${primary.kind} shape, ${primary.streamed ? "streamed" : "non-streamed"}`,
    "",
    `POST ${primary.url}`,
    "Body:",
    prettyJSON(primary.body ?? primary.bodyText),
  ]
  if (background.length > 0) {
    lines.push("", `Background requests (small-model titles etc.): ${background.length}`)
    for (const request of background.slice(0, 3)) {
      lines.push(`- POST ${request.url}: ${truncate(prettyJSON(request.body ?? request.bodyText), 160)}`)
    }
  }
  await showInfo(api, { title: `Captured request - ${variant ?? "default"}`, message: lines.join("\n") })
}

// ---------------------------------------------------------------------------
// Root model screen
// ---------------------------------------------------------------------------

async function rootModelScreen(api: TuiPluginApi, state: StudioState): Promise<void> {
  const write: WriteContext = { api, state }
  const resolved = safeStateConfig(api)
  const currentModel = typeof resolved["model"] === "string" ? resolved["model"] : "(not set)"
  const currentSmall = typeof resolved["small_model"] === "string" ? resolved["small_model"] : "(auto)"
  const options: WizardSelectOption<string>[] = [
    {
      title: "Set default model",
      value: "model",
      description: `current: ${currentModel}`,
      help: docText("root.model", [`Current merged value: ${currentModel}`, provenanceLine(state, ["model"])]),
    },
    {
      title: "Set small_model",
      value: "small_model",
      description: `current: ${currentSmall}`,
      help: docText("root.small_model", [`Current merged value: ${currentSmall}`, provenanceLine(state, ["small_model"])]),
    },
    { title: "< Back", value: "__back__", description: "Return to main menu" },
  ]
  const picked = await showMenu(api, { title: "Default model", options })
  if (!picked || picked === "__back__") return mainMenu(api, state)

  const modelPick = await pickAnyModel(api, state, picked === "model" ? "Pick default model" : "Pick small_model")
  if (!modelPick) return rootModelScreen(api, state)
  const ok = await applyEdits(write, [{ op: "set", path: [picked], value: `${modelPick.providerID}/${modelPick.modelID}` }], `set ${picked}`)
  if (ok) return rootModelScreen(api, state)
  return rootModelScreen(api, state)
}

function provenanceLine(state: StudioState, pointer: JSONPath): string {
  const { winner } = provenanceAt(state.merge, pointer)
  return winner ? `From: ${fileLabel(state, winner)}` : "From: OpenCode default (no config file sets it)"
}

async function refreshedState(api: TuiPluginApi, state: StudioState): Promise<StudioState> {
  const updated = await refreshStudio(api, state)
  Object.assign(state, updated)
  return state
}

async function pickAnyModel(api: TuiPluginApi, state: StudioState, title: string): Promise<{ providerID: string; modelID: string } | undefined> {
  // Grouped, searchable picker (same pattern as OpenCode's native model
  // picker): DialogSelect groups by provider category and its built-in filter
  // searches both option titles (model IDs) and categories (providers).
  const providerAnalyses = analyzeProviders(state.providers, state.defaults, state.merge)
  const options: TuiDialogSelectOption<string>[] = []
  for (const analysis of providerAnalyses) {
    const provider = state.providers.find((item) => item.id === analysis.providerID)
    if (!provider) continue
    const category = analysis.edited ? `${provider.name || analysis.providerID} *` : (provider.name || analysis.providerID)
    for (const [modelID, model] of Object.entries(provider.models ?? {})) {
      const edited = provenanceAt(state.merge, ["provider", analysis.providerID, "models", modelID]).contributors.length > 0
      const isDefault = state.defaults[analysis.providerID] === modelID
      options.push({
        title: modelID,
        value: `${analysis.providerID}/${modelID}`,
        description: [
          model.name !== modelID ? model.name : undefined,
          isDefault ? "default model" : undefined,
          edited ? "config-edited" : undefined,
        ].filter(Boolean).join(" - "),
        category,
      })
    }
  }
  options.push({ title: "< Cancel", value: "__cancel__", description: "Do not change", category: "" })

  const picked = await showSelect(api.ui, {
    title,
    options,
    flat: false,
    placeholder: "Search models or providers...",
  })
  if (!picked || picked === "__cancel__") return undefined
  const [providerID, ...rest] = picked.split("/")
  return { providerID: providerID!, modelID: rest.join("/") }
}

// ---------------------------------------------------------------------------
// Agents screen
// ---------------------------------------------------------------------------

async function agentsScreen(api: TuiPluginApi, state: StudioState): Promise<void> {
  const agentConfig = safeStateConfig(api)["agent"]
  const agents = new Map<string, Record<string, unknown>>()
  for (const name of ["build", "plan", "general"]) agents.set(name, {})
  if (agentConfig && typeof agentConfig === "object") {
    for (const [name, entry] of Object.entries(agentConfig as Record<string, unknown>)) {
      agents.set(name, entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {})
    }
  }
  const options: WizardSelectOption<string>[] = [...agents.entries()].map(([name, entry]) => {
    const hasEdits = state.files.some((file) => fileAgentEdits(file).some((agent) => agent.agentID === name))
    return {
      title: name,
      value: name,
      description: [
        typeof entry["model"] === "string" ? entry["model"] : "session model",
        typeof entry["variant"] === "string" ? `variant ${entry["variant"]}` : "default variant",
        entry["temperature"] !== undefined ? `temp ${entry["temperature"]}` : undefined,
        entry["top_p"] !== undefined ? `top_p ${entry["top_p"]}` : undefined,
      ].filter(Boolean).join(" - "),
      edited: hasEdits,
      help: agentHelpText(state, name, entry),
    }
  })
  options.push({ title: "< Back", value: "__back__", description: "Return to main menu" })

  const picked = await showMenu(api, { title: "Agents", options })
  if (!picked || picked === "__back__") return mainMenu(api, state)
  return agentDetail(api, state, picked)
}

function agentHelpText(state: StudioState, name: string, entry: Record<string, unknown>): string {
  return [
    docText("root.agent"),
    "",
    `Current ${name}:`,
    `  model: ${typeof entry["model"] === "string" ? entry["model"] : "(session model)"}`,
    `  variant: ${typeof entry["variant"] === "string" ? entry["variant"] : "(default)"}`,
    `  temperature: ${entry["temperature"] !== undefined ? entry["temperature"] : "(model default)"}`,
    `  top_p: ${entry["top_p"] !== undefined ? entry["top_p"] : "(model default)"}`,
    "",
    provenanceLine(state, ["agent", name, "model"]),
  ].join("\n")
}

async function agentDetail(api: TuiPluginApi, state: StudioState, agent: string): Promise<void> {
  const write: WriteContext = { api, state }
  const options: WizardSelectOption<string>[] = [
    {
      title: "Model",
      value: "model",
      description: String(getIn(safeStateConfig(api), ["agent", agent, "model"]) ?? "(session model)"),
      help: docText("agent.model", [provenanceLine(state, ["agent", agent, "model"])]),
    },
    {
      title: "Variant",
      value: "variant",
      description: String(getIn(safeStateConfig(api), ["agent", agent, "variant"]) ?? "(default)"),
      help: docText("agent.variant"),
    },
    {
      title: "Temperature",
      value: "temperature",
      description: String(getIn(safeStateConfig(api), ["agent", agent, "temperature"]) ?? "(model default)"),
      help: docText("agent.temperature"),
    },
    {
      title: "Top P",
      value: "top_p",
      description: String(getIn(safeStateConfig(api), ["agent", agent, "top_p"]) ?? "(model default)"),
      help: docText("agent.top_p"),
    },
    { title: "< Back", value: "__back__", description: "Return to agent list" },
  ]
  const picked = await showMenu(api, { title: `Agent ${agent}`, options })
  if (!picked || picked === "__back__") return agentsScreen(api, state)

  if (picked === "model") {
    const modelPick = await pickAnyModel(api, state, `Model for agent ${agent}`)
    if (!modelPick) return agentDetail(api, state, agent)
    const ok = await applyEdits(write, [{ op: "set", path: ["agent", agent, "model"], value: `${modelPick.providerID}/${modelPick.modelID}` }], `agent ${agent} model`)
    if (ok) return agentDetail(api, await refreshedState(api, state), agent)
    return agentDetail(api, state, agent)
  }

  if (picked === "variant") {
    const modelRef = getIn(safeStateConfig(api), ["agent", agent, "model"])
    let providerID: string | undefined
    let modelID: string | undefined
    if (typeof modelRef === "string" && modelRef.includes("/")) {
      const [pid, ...rest] = modelRef.split("/")
      providerID = pid
      modelID = rest.join("/")
    } else {
      const pick = await pickAnyModel(api, state, `Agent ${agent} has no model set. Pick the model whose variants to list`)
      if (!pick) return agentDetail(api, state, agent)
      providerID = pick.providerID
      modelID = pick.modelID
    }
    const runtime = state.providers.find((item) => item.id === providerID)?.models?.[modelID!]
    const variantNames = runtime?.variants ? Object.keys(runtime.variants) : []
    const variantPick = await showMenu(api, {
      title: `Variant for ${agent} (on ${providerID}/${modelID})`,
      options: [
        { title: "Default (no variant)", value: "__remove__", description: "Remove the agent variant override" },
        ...variantNames.map((name) => ({ title: name, value: name, description: "catalog variant" })),
        { title: "< Cancel", value: "__cancel__", description: "" },
      ],
    })
    if (!variantPick || variantPick === "__cancel__") return agentDetail(api, state, agent)
    const ok = await applyEdits(
      write,
      variantPick === "__remove__"
        ? [{ op: "delete", path: ["agent", agent, "variant"] }]
        : [{ op: "set", path: ["agent", agent, "variant"], value: variantPick }],
      `agent ${agent} variant`,
    )
    if (ok) return agentDetail(api, await refreshedState(api, state), agent)
    return agentDetail(api, state, agent)
  }

  if (picked === "temperature" || picked === "top_p") {
    const label = picked === "temperature" ? "Temperature" : "Top P"
    const input = await showPrompt(api.ui, {
      title: `Agent ${agent} - ${label}`,
      placeholder: picked === "temperature" ? "0.0 - 2.0 (empty removes)" : "0.0 - 1.0 (empty removes)",
      value: getIn(safeStateConfig(api), ["agent", agent, picked]) !== undefined ? String(getIn(safeStateConfig(api), ["agent", agent, picked])) : "",
    })
    if (input === undefined) return agentDetail(api, state, agent)
    let ok = false
    if (input.trim() === "") {
      ok = await applyEdits(write, [{ op: "delete", path: ["agent", agent, picked] }], `agent ${agent} ${picked} remove`)
    } else {
      const num = Number(input)
      if (!Number.isFinite(num)) {
        await showAlert(api.ui, { title: "Invalid number", message: `"${input}" is not a number.` })
        return agentDetail(api, state, agent)
      }
      ok = await applyEdits(write, [{ op: "set", path: ["agent", agent, picked], value: num }], `agent ${agent} ${picked}`)
    }
    if (ok) return agentDetail(api, await refreshedState(api, state), agent)
    return agentDetail(api, state, agent)
  }
  return agentsScreen(api, state)
}

// ---------------------------------------------------------------------------
// Config files screen
// ---------------------------------------------------------------------------

async function configFilesScreen(api: TuiPluginApi, state: StudioState): Promise<void> {
  const options: WizardSelectOption<string>[] = state.files.map((file) => {
    const summary = summarizeFile(file)
    return {
      title: `${file.kind}:${file.label}`,
      value: file.path,
      description: [
        file.exists ? (file.parseErrors.length > 0 ? "PARSE ERRORS" : "ok") : "missing",
        summary.providerCount > 0 ? `${summary.providerCount} provider(s)` : undefined,
        summary.editedModelCount > 0 ? `${summary.editedModelCount} model edit(s)` : undefined,
        summary.agentCount > 0 ? `${summary.agentCount} agent(s)` : undefined,
        state.targetFilePath === file.path ? "WRITE TARGET" : undefined,
      ].filter(Boolean).join(" - "),
      edited: file.exists && file.parseErrors.length === 0,
      danger: file.parseErrors.length > 0,
      help: fileHelpText(file),
    }
  })
  const missingGlobals = state.files.filter((file) => file.kind === "global" && !file.exists)
  if (missingGlobals.length > 0) {
    options.push({
      title: "+ Create a missing config file",
      value: "__create__",
      description: missingGlobals.map((file) => file.label).join(", "),
      help: "Creates the file with a $schema header. Global files are the usual place for model and variant edits.",
    })
  }
  options.push({
    title: "Backups",
    value: "__backups__",
    description: `${loadBackupJournal(studioDataDir(api)).entries.length} snapshot(s)`,
    help: "Every Config Studio edit writes a snapshot of the file before changing it. Restore or delete snapshots here.",
  })
  options.push({ title: "< Back", value: "__back__", description: "Return to main menu" })

  const picked = await showMenu(api, { title: `Config files (${state.files.length} layers, weakest first)`, options })
  if (!picked || picked === "__back__") return mainMenu(api, state)
  if (picked === "__create__") {
    const createPick = await showMenu(api, {
      title: "Create which file?",
      options: missingGlobals.map((file) => ({ title: file.path, value: file.path, description: "global config file" })),
    })
    if (!createPick) return configFilesScreen(api, state)
    const result = createConfigFile(createPick)
    if (result.ok) {
      api.ui.toast({ variant: "info", title: "File created", message: createPick })
      await refreshedState(api, state)
    } else {
      await showAlert(api.ui, { title: "Create failed", message: result.error ?? "unknown error" })
    }
    return configFilesScreen(api, state)
  }
  if (picked === "__backups__") return backupsScreen(api, state)
  const file = fileByPath(state, picked)
  if (!file) return configFilesScreen(api, state)
  return fileDetail(api, state, file)
}

function fileHelpText(file: ConfigFileEntry): string {
  const summary = summarizeFile(file)
  const lines = [
    `${file.kind}:${file.label}`,
    file.path,
    `Layer ${file.precedence + 1} of the merge order (higher wins).`,
    "",
  ]
  if (!file.exists) {
    lines.push("This file does not exist yet.", "It can be created from the Config files screen.")
    return lines.join("\n")
  }
  if (file.parseErrors.length > 0) {
    lines.push("PARSE ERRORS (editing blocked):", ...file.parseErrors.slice(0, 5))
    return lines.join("\n")
  }
  lines.push(`Top-level keys: ${summary.topKeys.join(", ") || "(empty)"}`)
  const modelEdits = fileModelEdits(file)
  if (modelEdits.length > 0) {
    lines.push("", "Model edits:")
    for (const edit of modelEdits.slice(0, 20)) {
      lines.push(`  ${edit.providerID}/${edit.modelID}: ${Object.keys(edit.entry).join(", ") || "(empty)"}`)
    }
  }
  const agentEdits = fileAgentEdits(file)
  if (agentEdits.length > 0) {
    lines.push("", "Agent entries:")
    for (const edit of agentEdits.slice(0, 20)) {
      lines.push(`  ${edit.agentID}: ${Object.keys(edit.entry).join(", ")}`)
    }
  }
  return lines.join("\n")
}

async function fileDetail(api: TuiPluginApi, state: StudioState, file: ConfigFileEntry): Promise<void> {
  const options: WizardSelectOption<string>[] = [
    { title: "Inspect file [i]", value: "inspect", description: "Keys, model edits, agent entries", help: fileHelpText(file) },
    {
      title: state.targetFilePath === file.path ? "Write target (current)" : "Set as write target",
      value: "target",
      description: "New edits will be written here",
      edited: state.targetFilePath === file.path,
      help: "Config Studio writes edits to one file at a time. Higher-precedence files still win when they define the same keys.",
    },
    { title: "Raw content", value: "raw", description: "View the file text", help: "Shows the raw file content." },
    { title: "< Back", value: "__back__", description: "Return to file list" },
  ]
  const picked = await showMenu(api, { title: `${file.kind}:${file.label}`, options })
  if (!picked || picked === "__back__") return configFilesScreen(api, state)
  if (picked === "inspect") {
    await showInfo(api, { title: `${file.kind}:${file.label}`, message: fileHelpText(file) })
    return fileDetail(api, state, file)
  }
  if (picked === "target") {
    state.targetFilePath = file.path
    api.ui.toast({ variant: "info", title: "Write target set", message: file.path })
    return fileDetail(api, state, file)
  }
  if (picked === "raw") {
    try {
      const text = existsSync(file.path) ? readFileSync(file.path, "utf8") : "(missing)"
      await showInfo(api, { title: file.path, message: truncate(text, 20000) })
    } catch (error) {
      await showAlert(api.ui, { title: "Read failed", message: error instanceof Error ? error.message : String(error) })
    }
    return fileDetail(api, state, file)
  }
  return fileDetail(api, state, file)
}

async function backupsScreen(api: TuiPluginApi, state: StudioState): Promise<void> {
  const journal = loadBackupJournal(studioDataDir(api))
  const options: WizardSelectOption<string>[] = journal.entries.slice().reverse().map((entry) => ({
    title: new Date(entry.timestamp).toLocaleString(),
    value: entry.id,
    description: truncate(entry.target, 40) + " - " + entry.reason,
    help: `Backup of ${entry.target}\nReason: ${entry.reason}\nTaken: ${new Date(entry.timestamp).toISOString()}`,
  }))
  if (options.length === 0) {
    await showAlert(api.ui, { title: "No backups", message: "Backups are created automatically before every edit." })
    return configFilesScreen(api, state)
  }
  const picked = await showMenu(api, { title: "Config Studio backups", options })
  if (!picked) return configFilesScreen(api, state)
  const entry = journal.entries.find((item) => item.id === picked)!
  const choice = await showMenu(api, {
    title: `Backup ${new Date(entry.timestamp).toLocaleString()}`,
    options: [
      { title: "View content", value: "view", description: "Inspect the snapshot" },
      { title: "Restore", value: "restore", description: "Write the snapshot back over the file", danger: true },
      { title: "Delete snapshot", value: "delete", description: "Remove it from the journal", danger: true },
      { title: "< Back", value: "__back__", description: "" },
    ],
  })
  if (!choice || choice === "__back__") return backupsScreen(api, state)
  if (choice === "view") {
    const content = readBackupContent(entry)
    await showInfo(api, { title: entry.target, message: content ? truncate(content, 20000) : "(snapshot file missing)" })
    return backupsScreen(api, state)
  }
  if (choice === "restore") {
    const content = readBackupContent(entry)
    if (!content) {
      await showAlert(api.ui, { title: "Snapshot missing", message: entry.file })
      return backupsScreen(api, state)
    }
    const confirmed = await showConfirm(api.ui, {
      title: "Restore backup",
      message: `Overwrite ${entry.target} with the snapshot from ${new Date(entry.timestamp).toLocaleString()}?`,
      confirmLabel: "Restore",
    })
    if (!confirmed) return backupsScreen(api, state)
    try {
      writeTextAtomic(entry.target, content)
      await reloadOpenCode(api)
      api.ui.toast({ variant: "info", title: "Restored", message: entry.target })
      await refreshedState(api, state)
    } catch (error) {
      await showAlert(api.ui, { title: "Restore failed", message: error instanceof Error ? error.message : String(error) })
    }
    return backupsScreen(api, state)
  }
  if (choice === "delete") {
    const confirmed = await showConfirm(api.ui, { title: "Delete snapshot", message: entry.file })
    if (confirmed) {
      deleteBackup(studioDataDir(api), entry.id)
      api.ui.toast({ variant: "info", title: "Snapshot deleted", message: entry.id })
    }
    return backupsScreen(api, state)
  }
  return backupsScreen(api, state)
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

async function diagnosticsScreen(api: TuiPluginApi, state: StudioState): Promise<void> {
  const resolved = safeStateConfig(api)
  const uneditable = findUneditableLayers(state.merge.merged, resolved)
  const parseErrors = state.files.filter((file) => file.parseErrors.length > 0)
  const lines: string[] = [
    "Merge report:",
    `  layers discovered: ${state.files.length}`,
    `  editable (exist + parse ok): ${editableFiles(state.files).length}`,
    `  provider catalog source: ${state.providersSource}`,
    `  models.dev metadata: ${state.modelsDevError ? `error - ${state.modelsDevError}` : `${Object.keys(state.modelsDev).length} providers`}`,
    "",
  ]
  if (parseErrors.length > 0) {
    lines.push("Parse errors (editing blocked for these files):")
    for (const file of parseErrors) {
      lines.push(`  ${file.kind}:${file.label} - ${file.parseErrors[0]}`)
    }
    lines.push("")
  }
  if (uneditable.length > 0) {
    lines.push(`Values from non-file layers (${uneditable.length}, first 15):`)
    lines.push("  These come from env content, remote, or managed config and cannot be edited here.")
    for (const finding of uneditable.slice(0, 15)) {
      lines.push(`  ${finding.pointer} = ${truncate(formatValue(finding.resolvedValue), 60)}`)
    }
  } else {
    lines.push("No values detected from non-file layers.")
  }
  lines.push("")
  lines.push("Write target: " + (state.targetFilePath ?? "(picked per edit)"))
  await showInfo(api, { title: "Diagnostics", message: lines.join("\n") })
  return mainMenu(api, state)
}

// ---------------------------------------------------------------------------
// UI options
// ---------------------------------------------------------------------------

async function uiScreen(api: TuiPluginApi, state: StudioState): Promise<void> {
  const options: WizardSelectOption<string>[] = [
    {
      title: `Dialog width: ${wizardDialogSize(api)}`,
      value: "width",
      description: "Cycle medium / large / xlarge",
      help: "OpenCode exposes fixed dialog widths: medium = 60 columns, large = 88, xlarge = 116.",
    },
    {
      title: `Dialog height: ${wizardDialogHeightPercent(api)}%`,
      value: "height",
      description: "Adjust with presets or a custom percent",
      help: "Maximum height of Config Studio screens. Presets: compact=32%, normal=50%, tall=68%, max=100%.",
    },
    { title: "< Back", value: "__back__", description: "Return to main menu" },
  ]
  const picked = await showMenu(api, { title: "Wizard UI", options })
  if (!picked || picked === "__back__") return mainMenu(api, state)
  if (picked === "width") {
    setWizardDialogSize(api, nextWizardDialogSize(api))
    return uiScreen(api, state)
  }
  if (picked === "height") {
    const input = await showPrompt(api.ui, { title: "Height percent", placeholder: `${HEIGHT_PERCENT_MIN}-${HEIGHT_PERCENT_MAX}`, value: String(wizardDialogHeightPercent(api)) })
    if (input !== undefined) {
      const num = Number(input)
      if (Number.isFinite(num)) setWizardDialogHeightPercent(api, num)
    }
    return uiScreen(api, state)
  }
  return mainMenu(api, state)
}

// ---------------------------------------------------------------------------
// Plugin entrypoint
// ---------------------------------------------------------------------------

function registerStudioCommand(api: TuiPluginApi, run: () => Promise<void>) {
  const command = {
    namespace: "palette",
    name: "config-studio.configure",
    title: "Config Studio: Models & Variants",
    desc: "Inspect and edit model variants and request defaults",
    category: "Plugins",
    slashName: "config-studio",
    run,
  }
  const apiWithKeymap = api as TuiPluginApi & {
    keymap?: {
      registerLayer?: (layer: { commands: Array<typeof command>; bindings: unknown[] }) => () => void
    }
  }
  if (typeof apiWithKeymap.keymap?.registerLayer === "function") {
    return apiWithKeymap.keymap.registerLayer({ commands: [command], bindings: [] })
  }
  return api.command?.register(() => [
    {
      title: "Config Studio: Models & Variants",
      value: "config-studio.configure",
      description: "Inspect and edit model variants and request defaults",
      category: "Plugins",
      slash: {
        name: "config-studio",
      },
      onSelect: run,
    },
  ])
}

const tui: TuiPlugin = async (api) => {
  // Belt-and-braces: if this plugin got registered in opencode.json but not in
  // any tui.json layer, mirror the registration (normally done by the server
  // entry; no-op when the TUI part is already properly wired).
  try {
    const wired = ensureTuiRegistration({
      globalConfigDir: api.state.path.config,
      ourRoot: ourRootDir(),
      directory: api.state.path.directory,
      worktree: api.state.path.worktree,
      env: process.env,
    })
    if (wired.status === "wired") {
      api.ui.toast({
        variant: "info",
        title: "Config Studio",
        message: `Added ${wired.spec} to tui.json - restart OpenCode to load the TUI part.`,
      })
    }
  } catch {
    // never block activation on self-wiring
  }

  const unregister = registerStudioCommand(api, async () => {
    let state: StudioState | undefined
    await showBusy(api, "Loading config layers...", (async () => {
      state = await refreshStudio(api)
    })())
    if (!state) return
    await mainMenu(api, state)
  })

  api.lifecycle.onDispose(() => {
    unregister?.()
  })
}

export default { id: "config-studio", tui }
