/** @jsxImportSource @opentui/solid */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { TuiPlugin, TuiPluginApi, TuiDialogSelectOption } from "@opencode-ai/plugin/tui"
import type { RGBA, ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createConfigFile, deleteBackup, editConfigFile, formatPath, getAtPath, applyOpsToData, isPlainObject, loadBackupJournal, parseJsonc, readBackupContent, writeTextAtomic, type EditOp, type JSONPath } from "./jsonc.js"
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
import { DEFAULT_HIDDEN_SECTIONS, loadSettings, saveSettings, settingsPath, type StudioSettings } from "./settings.js"
import { enabledModules, moduleUsesOwnMenu, getModules, type ModuleContext } from "./modules.js"
import { agentVariantsModuleId, setModulePickImplementation } from "./modules/agent-variants.js"
import { findStandaloneAgentVariants, removeStandaloneHits } from "./standalone.js"

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

interface StagedChange {
  id: number
  targetPath: string
  ops: EditOp[]
  reason: string
}

export interface StudioState {
  files: ConfigFileEntry[]
  merge: ProvenancedMerge
  providers: RuntimeProviderLike[]
  defaults: Record<string, string>
  modelsDev: ModelsDevCatalog
  modelsDevError?: string
  providersSource: "provider-list" | "config-providers" | "state"
  targetFilePath: string | undefined
  /** Queued edits, written only on Save & exit (agent-variants save model). */
  pending: StagedChange[]
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
/** Clearing the input swaps back to the full list sooner, but still settled. */
const CLEAR_DEBOUNCE_MS = 350

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
  if (menuProbe?.onMenu) {
    const selection = menuProbe.onMenu(props.title, (props.options as unknown as WizardSelectOption<unknown>[]).map((option) => ({ title: option.title, value: option.value, description: option.description })))
    return Promise.resolve((selection as Value | undefined) ?? undefined)
  }
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
                timer = setTimeout(
                  () => {
                    timer = undefined
                    applyQuery(query)
                  },
                  query.trim() === "" ? CLEAR_DEBOUNCE_MS : DEBOUNCE_MS,
                )
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

// ---------------------------------------------------------------------------
// Menu-tree probe (menu-tree smoke test)
// ---------------------------------------------------------------------------

/**
 * When set, all studio dialogs short-circuit through the probe instead of
 * rendering: menus report their options and optionally return a selection,
 * infos/confirms/prompts auto-resolve. Lets the menu-tree smoke test walk
 * every screen for crashes, duplicate/ambiguous titles, and dead entries.
 */
export type MenuProbe = {
  onMenu?: (title: string, options: WizardSelectOption<unknown>[]) => string | unknown | undefined
  onInfo?: (title: string, message: string) => void
  onPaged?: (title: string, sections: PagedSection[]) => void
  onConfirm?: (title: string, message: string) => boolean
}

let menuProbe: MenuProbe | undefined

export function __setMenuProbe(probe?: MenuProbe): void {
  menuProbe = probe
}

function probeMenuOnce<Value>(props: { title: string; options: WizardSelectOption<Value>[] }): { handled: boolean; selection?: Value } {
  if (!menuProbe?.onMenu) return { handled: false }
  const selection = menuProbe.onMenu(props.title, props.options as WizardSelectOption<unknown>[])
  if (selection === undefined || selection === null) return { handled: true }
  return { handled: true, selection: selection as Value }
}

function showMenuOnce<Value>(api: TuiPluginApi, props: { title: string; options: WizardSelectOption<Value>[]; current?: Value }): Promise<MenuChoice<Value> | undefined> {
  if (menuProbe?.onMenu) {
    const probed = probeMenuOnce(props)
    return Promise.resolve(probed.selection !== undefined ? { action: "select", value: probed.selection } : undefined)
  }
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
  if (menuProbe) return Promise.resolve(undefined)
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
  if (menuProbe) return Promise.resolve(menuProbe.onConfirm?.(props.title, props.message) ?? false)
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
  if (menuProbe) {
    menuProbe.onInfo?.(props.title, props.message)
    return Promise.resolve()
  }
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
        <text fg={isRestartRequired(props.title) ? theme().error : theme().accent}><b>{props.title}</b></text>
        <text fg={theme().textMuted} onMouseUp={props.onDone}>esc</text>
      </box>
      <scrollbox maxHeight={bodyHeight()} ref={(element: ScrollBoxRenderable) => (scroll = element)}>
      <box flexDirection="column" gap={0}>
        {renderContentLines(lines(), theme)}
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
// Paged content dialog (large output: capture bodies, diagnostics, diffs)
// ---------------------------------------------------------------------------

export type PagedSection = { title: string; lines: string[] }

function showPagedInfo(api: TuiPluginApi, props: { title: string; sections: PagedSection[] }): Promise<void> {
  if (menuProbe) {
    menuProbe.onPaged?.(props.title, props.sections)
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
      api.ui.dialog.clear()
    }
    api.ui.dialog.replace(
      () => <PagedDialog api={api} title={props.title} sections={props.sections} onDone={done} />,
      done,
    )
  })
}

type ThemePalette = { accent: RGBA; error: RGBA; success: RGBA; textMuted: RGBA }

/** Restart phrases that make a line or dialog title scream for attention. */
const RESTART_REQUIRED_RE = /restart[^\n]{0,40}required|required[^\n]{0,40}restart|requires? restart|restart opencode to|you restart/i
/** Any other restart mention - still red, but not bold. */
const RESTART_MENTION_RE = /restart/i

function isRestartRequired(text: string): boolean {
  return RESTART_REQUIRED_RE.test(text)
}

function contentLineAttrs(line: string): { fg: "warning" | "positive" | "heading" | "muted"; bold: boolean } {
  if (isRestartRequired(line)) return { fg: "warning", bold: true }
  if (RESTART_MENTION_RE.test(line)) return { fg: "warning", bold: false }
  const heading = line.length > 0 && !line.startsWith(" ") && (line.endsWith(":") || /^[A-Z][A-Za-z0-9 ._-]+$/.test(line))
  const warning = /error|failed|refus|invalid|delete|danger/i.test(line)
  const positive = /config|edited|saved|applied|catalog|success/i.test(line)
  if (warning) return { fg: "warning", bold: false }
  if (positive && !heading) return { fg: "positive", bold: false }
  if (heading) return { fg: "heading", bold: true }
  return { fg: "muted", bold: false }
}

function lineTheme(attrs: { fg: string; bold: boolean }, theme: () => ThemePalette) {
  const fg = attrs.fg === "warning" ? theme().error : attrs.fg === "positive" ? theme().success : attrs.fg === "heading" ? theme().accent : theme().textMuted
  return { fg, bold: attrs.bold }
}

function renderContentLines(lines: string[], theme: () => ThemePalette) {
  return (
    <box flexDirection="column" gap={0}>
      <For each={lines}>
        {(line) => {
          const style = lineTheme(contentLineAttrs(line), theme)
          return line.length === 0
            ? <text> </text>
            : <text fg={style.fg} wrapMode="word">{style.bold ? <b>{line}</b> : line}</text>
        }}
      </For>
    </box>
  )
}

function PagedDialog(props: { api: TuiPluginApi; title: string; sections: PagedSection[]; onDone: () => void }) {
  const theme = () => props.api.theme.current
  useWizardDialogSize(props.api)
  useHidePromptCursor(props.api)
  const dimensions = useTerminalDimensions()
  const popMode = props.api.mode.push("config-studio.dialog")
  const width = dialogContentWidth(props.api)
  const rowsPerPage = createMemo(() => Math.max(6, wizardMaxRows(props.api, dimensions().height, 14, 6)))

  type Page = { sectionIndex: number; lines: string[] }
  const pages = createMemo<Page[]>(() => {
    const result: Page[] = []
    const perPage = rowsPerPage()
    props.sections.forEach((section, sectionIndex) => {
      let current: string[] = []
      let used = 0
      const flush = () => {
        if (current.length > 0) result.push({ sectionIndex, lines: current })
        current = []
        used = 0
      }
      for (const line of section.lines) {
        const rows = Math.max(1, Math.ceil(line.length / Math.max(1, width)))
        if (used + rows > perPage && current.length > 0) flush()
        current.push(line)
        used += rows
      }
      flush()
    })
    return result.length > 0 ? result : [{ sectionIndex: 0, lines: ["(empty)"] }]
  })

  const [pageIndex, setPageIndex] = createSignal(0)
  const page = createMemo(() => pages()[Math.min(pageIndex(), pages().length - 1)]!)
  const sectionTitle = createMemo(() => props.sections[page().sectionIndex]?.title ?? "")
  const jumpKeys = createMemo(() => props.sections.slice(0, 9).map((section, index) => ({ section, key: String(index + 1) })))

  const commandPrefix = `config-studio.paged.${Math.random().toString(36).slice(2)}`
  const unregister = props.api.keymap.registerLayer({
    priority: 10000,
    commands: [
      { name: `${commandPrefix}.close`, title: "Close", run: (ctx: KeyContext) => { blockKey(ctx); props.onDone() } },
      { name: `${commandPrefix}.next`, title: "Next page", run: (ctx: KeyContext) => { blockKey(ctx); setPageIndex(Math.min(pageIndex() + 1, pages().length - 1)) } },
      { name: `${commandPrefix}.prev`, title: "Previous page", run: (ctx: KeyContext) => { blockKey(ctx); setPageIndex(Math.max(pageIndex() - 1, 0)) } },
      { name: `${commandPrefix}.first`, title: "First page", run: (ctx: KeyContext) => { blockKey(ctx); setPageIndex(0) } },
      { name: `${commandPrefix}.last`, title: "Last page", run: (ctx: KeyContext) => { blockKey(ctx); setPageIndex(pages().length - 1) } },
      ...jumpKeys().map(({ key }) => ({
        name: `${commandPrefix}.jump${key}`,
        title: "Jump to section",
        run: (ctx: KeyContext) => {
          blockKey(ctx)
          const target = pages().find((item) => item.sectionIndex === Number(key) - 1)
          if (target) setPageIndex(pages().indexOf(target))
        },
      })),
      { name: `${commandPrefix}.shield`, title: "Block background input", run: blockKey },
    ],
    bindings: [
      { key: "enter", cmd: `${commandPrefix}.close`, desc: "Close" },
      { key: "escape", cmd: `${commandPrefix}.close`, desc: "Close" },
      { key: "n", cmd: `${commandPrefix}.next`, desc: "Next page" },
      { key: "right", cmd: `${commandPrefix}.next`, desc: "Next page" },
      { key: "pagedown", cmd: `${commandPrefix}.next`, desc: "Next page" },
      { key: "p", cmd: `${commandPrefix}.prev`, desc: "Previous page" },
      { key: "left", cmd: `${commandPrefix}.prev`, desc: "Previous page" },
      { key: "pageup", cmd: `${commandPrefix}.prev`, desc: "Previous page" },
      { key: "home", cmd: `${commandPrefix}.first`, desc: "First page" },
      { key: "end", cmd: `${commandPrefix}.last`, desc: "Last page" },
      ...jumpKeys().map(({ key }) => ({ key, cmd: `${commandPrefix}.jump${key}`, desc: "Jump to section" })),
      ...shieldBindings(`${commandPrefix}.shield`, ["home", "end"]),
    ],
  })
  onCleanup(() => {
    unregister()
    popMode()
  })

  const footerHint = createMemo(() => {
    const sections = jumpKeys().map(({ key, section }) => `${key}=${truncate(section.title, 12)}`).join("  ")
    return [
      `p < ${pageIndex() + 1}/${pages().length} > n`,
      props.sections.length > 1 ? sections : "",
    ].filter(Boolean).join("   ")
  })

  return (
    <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" width="100%" marginBottom={1}>
        <text fg={isRestartRequired(props.title) ? theme().error : theme().accent}><b>{props.title}</b></text>
        <text fg={theme().textMuted} onMouseUp={props.onDone}>esc</text>
      </box>
      {props.sections.length > 1 ? (
        <box marginBottom={1}>
          <text fg={theme().textMuted}>section: </text>
          <text fg={theme().accent}><b>{sectionTitle()}</b></text>
        </box>
      ) : undefined}
      <box flexDirection="column" height={rowsPerPage()}>
        {renderContentLines(page().lines, theme)}
      </box>
      <box flexDirection="row" justifyContent="space-between" width="100%" marginTop={1}>
        <text fg={theme().textMuted}>{footerHint()}</text>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme().primary} onMouseUp={props.onDone}>
          <text fg={theme().background}><b>ok</b></text>
        </box>
      </box>
    </box>
  )
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
  const pending = previous?.pending ?? []
  // Staged overlay: pending ops are reflected in parsed file data so every
  // view (provenance, browsers, detail screens) renders the post-save world.
  for (const change of pending) {
    const file = files.find((item) => item.path === change.targetPath)
    if (!file) continue
    file.data = applyOpsToData(file.data, change.ops)
  }
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
    pending,
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

let stagedChangeCounter = 0

/**
 * Stages edits instead of writing them (agent-variants save model): ops are
 * recorded in state.pending and overlaid onto the parsed file data, so all
 * views already render the post-save values. The single disk write happens
 * on Save & exit (saveStagedChanges), followed by exactly one config reload.
 */
async function applyEdits(
  write: WriteContext,
  ops: EditOp[],
  reason: string,
): Promise<boolean> {
  const pointer = ops[0]?.path ?? []
  const target = await resolveTargetFile(write, pointer, reason)
  if (!target) return false
  write.state.pending.push({ id: ++stagedChangeCounter, targetPath: target, ops, reason })
  const updated = await refreshStudio(write.api, write.state)
  Object.assign(write.state, updated)
  write.api.ui.toast({
    variant: "info",
    title: "Staged",
    message: `${reason} - ${write.state.pending.length} pending. Save & exit writes to disk.`,
  })
  return true
}

/** Writes all staged changes; the single config reload happens in saveAndExit. */
async function saveStagedChanges(api: TuiPluginApi, state: StudioState): Promise<{ saved: number; failed?: { change: StagedChange; error: string } }> {
  const byPath = new Map<string, { ops: EditOp[]; reasons: string[] }>()
  for (const change of state.pending) {
    const entry = byPath.get(change.targetPath) ?? { ops: [], reasons: [] }
    entry.ops.push(...change.ops)
    entry.reasons.push(change.reason)
    byPath.set(change.targetPath, entry)
  }
  let saved = 0
  for (const [targetPath, entry] of byPath) {
    const result = editConfigFile(targetPath, entry.ops, { stateDir: studioDataDir(api), reason: entry.reasons.join("; ") })
    if (!result.ok) return { saved, failed: { change: state.pending.find((change) => change.targetPath === targetPath)!, error: result.error ?? "unknown error" } }
    saved++
  }
  state.pending = []
  return { saved }
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
  await checkStandaloneDuplicates(api)
  const editedProviders = analyzeProviders(state.providers, state.defaults, state.merge).filter((provider) => provider.edited).length
  const modules = enabledModuleList()
  const modulePending = modules.some((module) => module.hasPendingChanges(moduleContext(api, state)))
  const pendingCount = state.pending.length + (modulePending ? 1 : 0)
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
      description: "Merge report, hidden layers, modules",
      help: "Cross-checks your files against OpenCode's resolved config and merges module diagnostics (Agent Variants validation, ...).",
    },
    {
      title: "How it works",
      value: "info",
      description: "Requests, variants, precedence, capture",
      help: "Overview of the request pipeline and how this plugin reads and edits config.",
    },
    {
      title: "Modules",
      value: "modules",
      description: `${modules.length} enabled - toggles and layout`,
      help: "Enable or disable feature modules (Agent Variants, ...) and configure how they integrate into the studio. Disabled modules disappear from every menu; their server-side parts stop at the next restart.",
    },
    {
      title: "Advanced",
      value: "ui",
      description: `Dialog sizing, debug tools, module options`,
      help: "Wizard UI sizing for Config Studio screens plus advanced tools contributed by enabled modules (Agent Variants debug mode, logs, backups, ...).",
    },
  ]
  for (const module of modules) {
    if (!moduleUsesOwnMenu(studioSettings, module) || !module.mainMenuEntry) continue
    const entry = module.mainMenuEntry(moduleContext(api, state))
    opts.push({
      title: entry.title,
      value: `module:${module.id}`,
      description: entry.description,
      help: entry.help,
    })
  }
  if (pendingCount > 0) {
    opts.push({
      title: `Review staged changes (${pendingCount})`,
      value: "review",
      description: "Diff view, then save or discard",
      edited: true,
      help: "Edits are queued in memory. Nothing is written until Save & exit; review the diff, discard single changes, or drop everything.",
    })
  }
  opts.push({
    title: pendingCount > 0 ? `Save & exit (${pendingCount})` : "Save & exit",
    value: "save",
    description: pendingCount > 0 ? "Write staged changes to disk" : "Nothing staged - close the studio",
    edited: pendingCount > 0,
    help: pendingCount > 0
      ? "Writes every staged change to its target (with backups), reloads OpenCode config once, and closes the studio."
      : "No changes are staged. Esc also closes the studio.",
  })

  const action = await showMenu(api, { title: "Config Studio", options: opts })
  if (action?.startsWith("module:")) {
    const module = modules.find((item) => item.id === action.slice("module:".length))
    const entry = module && moduleUsesOwnMenu(studioSettings, module) ? module.mainMenuEntry?.(moduleContext(api, state)) : undefined
    if (entry) await entry.run(moduleContext(api, state))
    return mainMenu(api, state)
  }
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
      await showOverview(api)
      return mainMenu(api, state)
    case "modules":
      return modulesScreen(api, state)
    case "ui":
      return uiScreen(api, state)
    case "review":
      return reviewChangesScreen(api, state)
    case "save":
      return saveAndExit(api, state)
    default: {
      const hasModulePending = enabledModuleList().some((module) => module.hasPendingChanges(moduleContext(api, state)))
      if (state.pending.length > 0 || hasModulePending) {
        const discard = await showConfirm(api.ui, {
          title: "Discard staged changes?",
          message: `${state.pending.length} staged file change(s) plus module changes have not been written to disk.\n\nDiscard them and exit?`,
          confirmLabel: "Discard & exit",
        })
        if (!discard) return mainMenu(api, state)
        state.pending = []
        for (const module of enabledModuleList()) module.discard?.()
      }
      return
    }
  }
}

async function showOverview(api: TuiPluginApi): Promise<void> {
  const sections: PagedSection[] = [
    { title: "Requests & config", lines: overviewText().split("\n") },
    ...enabledModuleList().flatMap((module) => module.infoSections?.() ?? []),
  ]
  await showPagedInfo(api, { title: "Config Studio", sections })
}

async function modulesScreen(api: TuiPluginApi, state: StudioState): Promise<void> {
  const dataDir = studioDataDir(api)
  const options: WizardSelectOption<string>[] = getModules().map((module) => {
    const enabled = studioSettings.modules.enabled[module.id] !== false || (studioSettings.modules.enabled[module.id] === undefined && module.defaultEnabled)
    const optionBits: string[] = []
    for (const option of module.options ?? []) {
      const value = studioSettings.modules.options[module.id]?.[option.key]
      optionBits.push(`${option.title}: ${value === true ? "on" : "off"}`)
    }
    return {
      title: `${enabled ? "" : "x "}${module.title}`,
      value: module.id,
      description: [module.description, ...optionBits].join(" - "),
      edited: enabled,
      help: [
        module.description,
        "",
        "Toggle enables or disables this module's menus and server-side parts (server parts stop at the next restart).",
        ...(module.ownMenuOption ? ["", `${module.ownMenuOption.title}: ${module.ownMenuOption.help ?? module.ownMenuOption.description}`] : []),
      ].join("\n"),
    }
  })
  options.push({ title: "< Back", value: "__back__", description: "Return to main menu" })
  const picked = await showMenu(api, { title: "Modules", options })
  if (!picked || picked === "__back__") return mainMenu(api, state)
  const module = getModules().find((item) => item.id === picked)
  if (!module) return modulesScreen(api, state)
  if (module.ownMenuOption) {
    const choice = await showMenu(api, {
      title: module.title,
      options: [
        { title: "Toggle enabled", value: "enabled", description: "Show/hide this module everywhere" },
        { title: `Toggle ${module.ownMenuOption.title}`, value: "layout", description: studioSettings.modules.options[module.id]?.[module.ownMenuOption.key] === true ? "currently: own menu" : "currently: integrated" },
        { title: "< Back", value: "__back__", description: "Return to modules" },
      ],
    })
    if (!choice || choice === "__back__") return modulesScreen(api, state)
    if (choice === "enabled") {
      const nowEnabled = studioSettings.modules.enabled[module.id] !== false || studioSettings.modules.enabled[module.id] === undefined
      setModuleEnabledInSettings(api, dataDir, module.id, !nowEnabled)
    } else if (choice === "layout") {
      const bag = studioSettings.modules.options[module.id] ?? (studioSettings.modules.options[module.id] = {})
      bag[module.ownMenuOption.key] = bag[module.ownMenuOption.key] !== true
      saveSettings(dataDir, studioSettings)
      api.ui.toast({
        variant: "info",
        title: module.title,
        message: bag[module.ownMenuOption.key] === true ? "Module now has its own main-menu entry." : "Module menus are integrated into the studio screens.",
      })
    }
    return modulesScreen(api, state)
  }
  const nowEnabled = studioSettings.modules.enabled[module.id] !== false || studioSettings.modules.enabled[module.id] === undefined
  setModuleEnabledInSettings(api, dataDir, module.id, !nowEnabled)
  return modulesScreen(api, state)
}

function setModuleEnabledInSettings(api: TuiPluginApi, dataDir: string, id: string, enabled: boolean) {
  studioSettings.modules.enabled[id] = enabled
  saveSettings(dataDir, studioSettings)
  api.ui.toast({
    variant: "info",
    title: enabled ? "Module enabled" : "Module disabled",
    message: enabled ? "Its menus are back." : "Its menus disappear; server parts stop at the next restart.",
  })
}

// ---------------------------------------------------------------------------
// Module session state (per studio command run)
// ---------------------------------------------------------------------------

let studioSettings: StudioSettings = loadSettingsDefaultPlaceholder()
let duplicateCheckDone = false
/** Startup duplicate-check delay: lets the initial TUI render settle first. */
const STARTUP_CHECK_DELAY_MS = 1500

function loadSettingsDefaultPlaceholder(): StudioSettings {
  // Replaced at command start; safe default before that.
  return { capture: { hiddenSections: [...DEFAULT_HIDDEN_SECTIONS] }, modules: { enabled: {}, options: {} } }
}

function moduleContext(api: TuiPluginApi, state: StudioState): ModuleContext {
  return {
    api,
    state,
    settings: studioSettings,
    refresh: async () => {
      const updated = await refreshStudio(api, state)
      Object.assign(state, updated)
    },
  }
}

function enabledModuleList() {
  return enabledModules(studioSettings)
}

async function checkStandaloneDuplicates(api: TuiPluginApi): Promise<void> {
  if (duplicateCheckDone) return
  duplicateCheckDone = true
  const moduleIdEnabled = studioSettings.modules.enabled[agentVariantsModuleId] !== false
  if (!moduleIdEnabled) return
  let hits: ReturnType<typeof findStandaloneAgentVariants> = []
  try {
    hits = findStandaloneAgentVariants({
      globalConfigDir: api.state.path.config,
      directory: api.state.path.directory,
      worktree: api.state.path.worktree,
      env: process.env,
    })
  } catch {
    return
  }
  if (hits.length === 0) return

  const files = [...new Set(hits.map((hit) => hit.file))]
  const remove = await showConfirm(api.ui, {
    title: "Standalone Agent Variants detected",
    message: [
      `${hits.length} standalone registration(s) found:`,
      ...files.map((file) => `  - ${file}`),
      "",
      "Config Studio embeds Agent Variants. Keeping both would run the routing logic twice.",
      "Remove the standalone registration(s)? Until you restart, the studio's embedded router stays dormant and the standalone plugin keeps handling routing.",
    ].join("\n"),
    confirmLabel: "Remove standalone",
  })
  if (!remove) return
  const results = removeStandaloneHits(hits, studioDataDir(api))
  const failures = results.filter((result) => result.error)
  const removed = results.filter((result) => !result.error)
  const lines: string[] = []
  if (removed.length > 0) {
    lines.push("Removed standalone Agent Variants from:", ...removed.map((result) => `  - ${result.file}`))
  }
  if (failures.length > 0) {
    lines.push("", "Failed to edit:", ...failures.map((result) => `  - ${result.file}: ${result.error}`))
  }
  lines.push(
    "",
    "RESTART REQUIRED: restart OpenCode so the embedded Agent Variants",
    "module takes over routing. Until then the standalone plugin keeps running.",
  )
  api.ui.toast({ variant: "warning", title: "Standalone Agent Variants removed", message: "Restart OpenCode to activate the embedded module." })
  await showInfo(api, { title: "Standalone removed - restart required", message: lines.join("\n") })
}

function stagedChangeSummary(change: StagedChange): string {
  return change.ops
    .map((op) => `${op.op === "set" ? "set" : "delete"} ${formatPath(op.path)}`)
    .join(", ")
}

function diskDataAt(state: StudioState, targetPath: string, pointer: JSONPath): unknown {
  // Truth from disk (not the staged overlay): used for old-value display.
  const file = state.files.find((item) => item.path === targetPath)
  const overlay = file ? applyOpsToData(file.data, []) : undefined
  if (overlay === undefined) {
    try {
      const text = readFileSync(targetPath, "utf8")
      return getAtPath(parseJsonc(text).data, pointer)
    } catch {
      return undefined
    }
  }
  // Re-parse from disk for truth; fall back to reversing the overlay via ops.
  try {
    const text = readFileSync(targetPath, "utf8")
    return getAtPath(parseJsonc(text).data, pointer)
  } catch {
    return getAtPath(file!.data, pointer)
  }
}

function modulePendingSummaries(ctx: ModuleContext) {
  return enabledModuleList()
    .map((module) => ({ module, summary: module.pendingSummary?.(ctx) }))
    .filter((item): item is { module: (typeof item)["module"]; summary: NonNullable<(typeof item)["summary"]> } => Boolean(item.summary))
}

async function reviewChangesScreen(api: TuiPluginApi, state: StudioState): Promise<void> {
  const moduleSummaries = modulePendingSummaries(moduleContext(api, state))
  const total = state.pending.length + moduleSummaries.length
  if (total === 0) return mainMenu(api, state)
  const options: WizardSelectOption<string>[] = state.pending.map((change) => ({
    title: change.reason,
    value: `view:${change.id}`,
    description: `${fileByPath(state, change.targetPath)?.kind ?? "file"}:${fileByPath(state, change.targetPath)?.label ?? change.targetPath} - ${stagedChangeSummary(change)}`,
    edited: true,
    help: "Select to inspect the full diff for this staged change (old value from disk, new value from the staged edit).",
  }))
  for (const { module, summary } of moduleSummaries) {
    options.push({
      title: summary.title,
      value: `module:${module.id}`,
      description: summary.lines[0] ?? module.title,
      edited: true,
      help: "Module-owned staged changes (written by the studio's Save & exit together with file edits).",
    })
  }
  options.push(
    { title: "Save all & exit", value: "__save__", description: `${state.pending.length} file change(s), ${moduleSummaries.length} module change(s)`, edited: true, help: "Writes every staged change with backup, reloads OpenCode config once, then closes the studio." },
    { title: "Discard all", value: "__discard_all__", description: "Drop every staged change", danger: true, help: "Clears the queue; nothing has been written to disk." },
    { title: "< Back", value: "__back__", description: "Keep changes staged" },
  )
  const picked = await showMenu(api, { title: `Staged changes (${total})`, options })
  if (!picked || picked === "__back__") return mainMenu(api, state)
  if (picked === "__save__") return saveAndExit(api, state)
  if (picked === "__discard_all__") {
    const confirmed = await showConfirm(api.ui, { title: "Discard all staged changes?", message: "Nothing has been written to disk. Drop all staged edits (including module changes)?" })
    if (!confirmed) return reviewChangesScreen(api, state)
    state.pending = []
    for (const module of enabledModuleList()) module.discard?.()
    const updated = await refreshStudio(api, state)
    Object.assign(state, updated)
    return mainMenu(api, state)
  }
  if (picked.startsWith("view:")) {
    const id = Number(picked.slice("view:".length))
    const change = state.pending.find((item) => item.id === id)
    if (change) return stagedChangeDetail(api, state, change)
    return reviewChangesScreen(api, state)
  }
  if (picked.startsWith("module:")) {
    const entry = moduleSummaries.find((item) => item.module.id === picked.slice("module:".length))
    if (entry) await showPagedInfo(api, { title: entry.summary.title, sections: [{ title: entry.summary.title, lines: entry.summary.lines }] })
    return reviewChangesScreen(api, state)
  }
  return mainMenu(api, state)
}

async function stagedChangeDetail(api: TuiPluginApi, state: StudioState, change: StagedChange): Promise<void> {
  const sections: PagedSection[] = change.ops.map((op) => {
    const old = diskDataAt(state, change.targetPath, op.path)
    const isNew = old === undefined
    return {
      title: truncate(op.path[op.path.length - 1] !== undefined ? String(op.path[op.path.length - 1]) : formatPath(op.path), 18),
      lines: [
        `${op.op === "set" ? "Set" : "Delete"} ${formatPath(op.path)}`,
        `File: ${change.targetPath}`,
        `Reason: ${change.reason}`,
        "",
        op.op === "set"
          ? isNew ? "New value (key does not exist on disk yet):" : "Old value (disk):"
          : "Value being deleted (disk):",
        ...prettyJSON(old).split(/\r?\n/).map((line) => `  ${line}`),
        ...(op.op === "set" ? ["", "New value (staged):", ...prettyJSON(op.value).split(/\r?\n/).map((line) => `  ${line}`)] : []),
      ],
    }
  })
  await showPagedInfo(api, { title: `Staged: ${change.reason}`, sections })
  const action = await showMenu(api, {
    title: `Staged change - ${change.reason}`,
    options: [
      { title: "Discard this change", value: "discard", danger: true, description: "Remove from the queue" },
      { title: "< Back", value: "__back__", description: "Return to staged changes" },
    ],
  })
  if (action === "discard") {
    state.pending = state.pending.filter((item) => item.id !== change.id)
    const updated = await refreshStudio(api, state)
    Object.assign(state, updated)
    api.ui.toast({ variant: "info", title: "Staged change discarded", message: change.reason })
    return reviewChangesScreen(api, state)
  }
  return reviewChangesScreen(api, state)
}

async function saveAndExit(api: TuiPluginApi, state: StudioState): Promise<void> {
  const moduleSummaries = modulePendingSummaries(moduleContext(api, state))
  const total = state.pending.length + moduleSummaries.length
  if (total === 0) {
    api.ui.toast({ variant: "info", title: "Nothing staged", message: "No changes to save - closing the studio." })
    return
  }
  const confirmed = await showConfirm(api.ui, {
    title: "Save staged changes",
    message: `Write ${state.pending.length} staged file change(s) and ${moduleSummaries.length} module change(s)?\nEach file write creates a backup first.`,
    confirmLabel: "Save & reload",
  })
  if (!confirmed) return mainMenu(api, state)
  const result = await saveStagedChanges(api, state)
  if (result.failed) {
    await showAlert(api.ui, {
      title: "Save failed",
      message: [
        `Failed writing ${result.failed.change.targetPath}:`,
        result.failed.error,
        "",
        `${result.saved} file(s) saved before the failure. Remaining changes stay staged.`,
      ].join("\n"),
    })
    return mainMenu(api, state)
  }
  const restartReasons: string[] = []
  for (const { module } of moduleSummaries) {
    try {
      const moduleResult = await module.save?.(moduleContext(api, state))
      restartReasons.push(...(moduleResult?.restartReasons ?? []))
    } catch (error) {
      restartReasons.push(`${module.title}: save failed - ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const uniqueReasons = [...new Set(restartReasons)]
  api.ui.toast({ variant: uniqueReasons.length > 0 ? "warning" : "success", title: "Config saved", message: uniqueReasons.length > 0 ? "Restart OpenCode to apply task-list/UI changes." : "All changes written." })
  // Summary dialog BEFORE the config reload: dispose reloads plugins and
  // would tear this dialog down mid-display otherwise.
  if (uniqueReasons.length > 0) {
    await showPagedInfo(api, {
      title: "Saved - restart required",
      sections: [
        {
          title: "Restart",
          lines: [
            `Wrote staged changes to ${result.saved} file(s) plus ${moduleSummaries.length} module change(s).`,
            "",
            "RESTART REQUIRED for these changes:",
            ...uniqueReasons.map((reason) => `  - ${reason}`),
            "",
            "OpenCode config reloads now; running sessions keep their previous settings.",
          ],
        },
      ],
    })
  } else {
    await showInfo(api, {
      title: "Saved",
      message: [
        `Wrote staged changes to ${result.saved} file(s) plus ${moduleSummaries.length} module change(s).`,
        "",
        "OpenCode config reloads now; running sessions keep their previous settings.",
        "Restart OpenCode if anything looks stale.",
      ].join("\n"),
    })
  }
  await reloadOpenCode(api)
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
    const sections: PagedSection[] = [
      {
        title: "Differences",
        lines:
          diff.length === 0
            ? ["The two requests send identical bodies."]
            : [`Differences (${diff.length}):`, ...diff.flatMap((entry) => [
                `  ${entry.pointer}:`,
                `    default: ${truncate(formatValue(entry.a), 90)}`,
                `    ${variantPick}: ${truncate(formatValue(entry.b), 90)}`,
              ])],
      },
      { title: "Default body", lines: prettyJSON(defaultBody).split(/\r?\n/) },
      { title: `Variant ${variantPick}`, lines: prettyJSON(variantBody).split(/\r?\n/) },
    ]
    await showPagedInfo(api, { title: `A/B diff - default vs ${variantPick}`, sections })
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

// ---------------------------------------------------------------------------
// Capture viewer (sectioned, toggleable, persisted)
// ---------------------------------------------------------------------------

type CaptureView = {
  label: string
  url: string
  kind: string
  streamed: boolean
  body: unknown
  bodyText?: string
}

function captureSections(view: CaptureView): PagedSection[] {
  let source: unknown = view.body
  if (source === undefined && view.bodyText !== undefined) {
    try {
      source = JSON.parse(view.bodyText)
    } catch {
      source = undefined
    }
  }
  if (!isPlainObject(source)) {
    return [{ title: "Body", lines: prettyJSON(source ?? view.bodyText ?? "").split(/\r?\n/) }]
  }
  const params: string[] = []
  const sections: PagedSection[] = []
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) || Array.isArray(value)) {
      const text = prettyJSON(value)
      const count = Array.isArray(value) ? value.length : Object.keys(value).length
      sections.push({
        title: key,
        lines: [`${key} - ${count} ${Array.isArray(value) ? "item" : "key"}${count === 1 ? "" : "s"}`, ...text.split(/\r?\n/)],
      })
    } else {
      params.push(`${key}: ${formatValue(value)}`)
    }
  }
  if (params.length > 0) sections.unshift({ title: "Parameters", lines: params })
  return sections
}

async function captureViewerScreen(api: TuiPluginApi, view: CaptureView, background: CaptureView[]): Promise<void> {
  const dataDir = studioDataDir(api)
  const settings = loadSettings(dataDir)
  while (true) {
    const hidden = new Set(settings.capture.hiddenSections)
    const sections = captureSections(view)
    const toggleable = sections.filter((section) => section.title !== "Parameters")
    const options: WizardSelectOption<string>[] = [
      {
        title: "View captured body",
        value: "__view__",
        description: `${sections.filter((section) => !hidden.has(section.title)).length}/${sections.length} section(s) shown`,
        help: "Shows parameters plus every section not hidden. Heavy sections (messages, tools) are hidden by default so the body stays readable.",
      },
      ...toggleable.map((section) => ({
        title: `${hidden.has(section.title) ? "Show" : "Hide"}: ${section.title}`,
        value: `toggle:${section.title}`,
        description: hidden.has(section.title) ? "hidden - enable for this and future captures" : "shown - hide for this and future captures",
        help: `Toggles the ${section.title} section of captured request bodies. The setting is stored in ${settingsPath(dataDir)} and applies to all capture views.`,
      })),
      {
        title: "Reset sections to defaults",
        value: "__reset__",
        description: "Unhide everything, then apply default hidden sections",
        help: "Restores the default hidden-section list (messages, tools, and other large payloads stay hidden).",
      },
      ...(background.length > 0
        ? [{
            title: `Background requests (${background.length})`,
            value: "__bg__",
            description: "Small-model requests (titles, summaries)",
            help: "OpenCode fires extra requests with the small model for session titles and similar background work. Inspect what they send.",
          }]
        : []),
      { title: "< Done", value: "__done__", description: "Return" },
    ]
    const picked = await showMenu(api, { title: `Captured request - ${view.label}`, options })
    if (!picked || picked === "__done__") return
    if (picked === "__view__") {
      const visible = sections.filter((section) => !hidden.has(section.title))
      await showPagedInfo(api, {
        title: `${view.label} - ${view.kind} ${view.streamed ? "streamed" : "non-streamed"}`,
        sections: [
          { title: "Request", lines: [`POST ${view.url}`] },
          ...visible,
        ],
      })
      continue
    }
    if (picked === "__reset__") {
      settings.capture.hiddenSections = [...DEFAULT_HIDDEN_SECTIONS]
      saveSettings(dataDir, settings)
      continue
    }
    if (picked === "__bg__") {
      await backgroundViewer(api, background)
      continue
    }
    if (picked.startsWith("toggle:")) {
      const name = picked.slice("toggle:".length)
      const set = new Set(settings.capture.hiddenSections)
      if (set.has(name)) set.delete(name)
      else set.add(name)
      settings.capture.hiddenSections = [...set]
      saveSettings(dataDir, settings)
      continue
    }
  }
}

async function backgroundViewer(api: TuiPluginApi, background: CaptureView[]): Promise<void> {
  const sections: PagedSection[] = background.map((request, index) => ({
    title: `BG ${index + 1}`,
    lines: [
      `Background request ${index + 1} - ${request.kind} ${request.streamed ? "streamed" : "non-streamed"}`,
      `POST ${request.url}`,
      "",
      ...captureSections(request).filter((section) => section.title === "Parameters").flatMap((section) => section.lines),
    ],
  }))
  await showPagedInfo(api, { title: `Background requests (${background.length})`, sections })
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
  const toView = (request: NonNullable<typeof result>["requests"][number], index: number): CaptureView => ({
    label: index === 0
      ? `${variant ? `Variant ${variant}` : "Default (no variant)"} on ${analysis.providerID}/${analysis.modelID}`
      : `BG ${index}`,
    url: request.url,
    kind: request.kind,
    streamed: request.streamed,
    body: request.body,
    bodyText: request.bodyText,
  })
  const primary = result.requests[0]!
  const background = result.requests.slice(1).map((request, index) => toView(request, index + 1))
  await captureViewerScreen(api, toView(primary, 0), background)
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
  for (const module of enabledModuleList()) {
    if (moduleUsesOwnMenu(studioSettings, module)) continue
    for (const entry of module.agentsScreenEntries?.(moduleContext(api, state)) ?? []) {
      options.push({ title: entry.title, value: `module-agents:${module.id}:${entry.title}`, description: entry.description, help: entry.help, edited: entry.edited })
    }
  }
  options.push({ title: "< Back", value: "__back__", description: "Return to main menu" })

  const picked = await showMenu(api, { title: "Agents", options })
  if (!picked || picked === "__back__") return mainMenu(api, state)
  if (picked.startsWith("module-agents:")) {
    const rest = picked.slice("module-agents:".length)
    const [moduleId, ...titleParts] = rest.split(":")
    const module = enabledModuleList().find((item) => item.id === moduleId)
    const entry = module && !moduleUsesOwnMenu(studioSettings, module)
      ? module.agentsScreenEntries?.(moduleContext(api, state)).find((item) => item.title === titleParts.join(":"))
      : undefined
    if (entry) await entry.run(moduleContext(api, state))
    return agentsScreen(api, state)
  }
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
      title: "Model variant",
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
  ]
  for (const module of enabledModuleList()) {
    if (moduleUsesOwnMenu(studioSettings, module)) continue
    for (const entry of module.agentDetailEntries?.(moduleContext(api, state), agent) ?? []) {
      options.push({ title: entry.title, value: `module-agent:${module.id}:${entry.title}`, description: entry.description, help: entry.help, edited: entry.edited, danger: entry.danger })
    }
  }
  options.push({ title: "< Back", value: "__back__", description: "Return to agent list" })
  const picked = await showMenu(api, { title: `Agent ${agent}`, options })
  if (!picked || picked === "__back__") return agentsScreen(api, state)
  if (picked.startsWith("module-agent:")) {
    const rest = picked.slice("module-agent:".length)
    const [moduleId, ...titleParts] = rest.split(":")
    const module = enabledModuleList().find((item) => item.id === moduleId)
    const entry = module && !moduleUsesOwnMenu(studioSettings, module)
      ? module.agentDetailEntries?.(moduleContext(api, state), agent).find((item) => item.title === titleParts.join(":"))
      : undefined
    if (entry) await entry.run(moduleContext(api, state))
    return agentDetail(api, state, agent)
  }

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
  const mergeLines = [
    `layers discovered: ${state.files.length}`,
    `editable (exist + parse ok): ${editableFiles(state.files).length}`,
    `provider catalog source: ${state.providersSource}`,
    `models.dev metadata: ${state.modelsDevError ? `error - ${state.modelsDevError}` : `${Object.keys(state.modelsDev).length} providers`}`,
    `write target: ${state.targetFilePath ?? "(picked per edit)"}`,
    `staged changes: ${state.pending.length}`,
  ]
  const sections: PagedSection[] = [
    { title: "Merge report", lines: mergeLines },
  ]
  if (parseErrors.length > 0) {
    sections.push({
      title: "Parse errors",
      lines: [
        "Editing is blocked for these files until the syntax error is fixed:",
        ...parseErrors.flatMap((file) => [`  ${file.kind}:${file.label} - ${file.parseErrors[0]}`]),
      ],
    })
  }
  if (uneditable.length > 0) {
    sections.push({
      title: "Non-file layers",
      lines: [
        `${uneditable.length} value(s) come from env content, remote, or managed config and cannot be edited here:`,
        ...uneditable.slice(0, 40).map((finding) => `  ${finding.pointer} = ${truncate(formatValue(finding.resolvedValue), 60)}`),
      ],
    })
  } else {
    sections.push({ title: "Non-file layers", lines: ["No values detected from non-file layers."] })
  }
  for (const module of enabledModuleList()) {
    try {
      const moduleSections = await module.diagnosticsSections?.(moduleContext(api, state))
      if (moduleSections) sections.push(...moduleSections)
    } catch (error) {
      sections.push({ title: module.title, lines: [`diagnostics failed: ${error instanceof Error ? error.message : String(error)}`] })
    }
  }
  await showPagedInfo(api, { title: "Diagnostics", sections })
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
  ]
  for (const module of enabledModuleList()) {
    const entries = module.advancedEntries?.(moduleContext(api, state)) ?? []
    entries.forEach((entry, index) => {
      options.push({
        title: entry.title,
        value: `module-advanced:${module.id}:${index}`,
        description: entry.description,
        help: entry.help,
        danger: entry.danger,
      })
    })
  }
  options.push({ title: "< Back", value: "__back__", description: "Return to main menu" })
  const picked = await showMenu(api, { title: "Advanced", options })
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
  if (picked.startsWith("module-advanced:")) {
    const rest = picked.slice("module-advanced:".length)
    const splitAt = rest.lastIndexOf(":")
    const moduleId = rest.slice(0, splitAt)
    const entryIndex = Number(rest.slice(splitAt + 1))
    const module = enabledModuleList().find((item) => item.id === moduleId)
    const entry = module?.advancedEntries?.(moduleContext(api, state))?.[entryIndex]
    if (entry) await entry.run(moduleContext(api, state))
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

  // Module system: register the picker used by module menus and load settings.
  setModulePickImplementation((moduleApi, props) =>
    showMenu(moduleApi, {
      title: props.title,
      options: props.options.map((option) => ({
        title: option.title,
        value: option.value,
        description: option.description,
        help: option.help,
        danger: option.danger,
      })),
    }),
  )
  studioSettings = loadSettings(studioDataDir(api))

  // Startup duplicate check: the TUI entry runs at OpenCode startup, so this
  // shows the same interactive removal dialog the studio command uses, without
  // the user having to open the studio first. Delayed briefly so the initial
  // TUI render settles; opening the studio re-checks (duplicateCheckDone is
  // reset per command run), which is fine - users should be warned twice
  // rather than never.
  const startupCheckTimer = setTimeout(() => {
    void checkStandaloneDuplicates(api).catch(() => {})
  }, STARTUP_CHECK_DELAY_MS)
  ;(startupCheckTimer as { unref?: () => void }).unref?.()

  const unregister = registerStudioCommand(api, async () => {
    studioSettings = loadSettings(studioDataDir(api))
    duplicateCheckDone = false
    let state: StudioState | undefined
    await showBusy(api, "Loading config layers...", (async () => {
      state = await refreshStudio(api)
    })())
    if (!state) return
    await mainMenu(api, state)
  })

  api.lifecycle.onDispose(() => {
    clearTimeout(startupCheckTimer)
    unregister?.()
  })
}

export default { id: "config-studio", tui }

// Test hooks for the menu-tree smoke test (scripts/menu-tree-smoke.mjs).
export const __testInternals = {
  mainMenu,
  refreshStudio,
  __setMenuProbe,
  setStudioSettings: (settings: StudioSettings) => {
    studioSettings = settings
  },
  resetDuplicateCheck: () => {
    duplicateCheckDone = false
  },
  defaultHiddenSections: () => [...DEFAULT_HIDDEN_SECTIONS],
}
