/** @jsxImportSource @opentui/solid */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { TuiPlugin, TuiPluginApi, TuiDialogSelectOption } from "@opencode-ai/plugin/tui"
import type { BoxRenderable, RGBA, ScrollBoxRenderable } from "@opentui/core"
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
  providerUniverse,
  type ModelAnalysis,
  type ModelsDevCatalog,
  type ProviderAnalysis,
  type RuntimeProviderLike,
  type VariantAnalysis,
} from "./catalog.js"
import { runCapture, diffBodies, type CaptureRunResult } from "./sink.js"
import { ensureTuiRegistration, ourRootDir } from "./selfwire.js"
import { agentMode as avAgentMode, showFieldList as avShowFieldList, type FieldListOption as AVFieldListOption, type FieldListChoice as AVFieldListChoice } from "@mirrowel/opencode-agent-variants/wizard"
import { FIELD_DOCS } from "./docs.js"
import { rankOptions } from "./search.js"
import { computeDialogRows } from "./size.js"
import { currentPaletteCategory, declarePaletteCategory, schedulePaletteReconcile } from "./palette-category.js"
import { discoverMarkdownAgents, discoverTuiFiles, type MarkdownAgent } from "./discovery.js"
import { CLEANUP_RULES, TUI_KEYS, keybindGroupsMatching, toolsToPermission, type ObjectFieldSpec } from "./keymeta.js"
import { fieldEditor as kitFieldEditor, permissionEditor as kitPermissionEditor, providerEntryScreen, providerModelsScreen, settingsGroupDirect as kitDrillSettingsGroup, settingsFieldDirect as kitDrillSettings, settingsScreen as kitSettingsScreen, type EditorKit } from "./editors.js"
import { providerCacheKey, getCachedProviders, setCachedProviders, providerCacheState, detectOutsideChanges, type OutsideChange } from "./providercache.js"
import { buildMigrationPlan, savableParentFields, CONFIG_SAVABLE_PARENT_FIELDS } from "./migration.js"
import { DEFAULT_HIDDEN_SECTIONS, loadSettings, moduleOption, saveSettings, setModuleOption, settingsPath, PINNABLE_SCREENS, screenTitle, type StudioSettings } from "./settings.js"
import { avOrigin, refreshAvSource } from "./av-source.js"
import { beginStudioFlow, cancelPendingReload, endStudioFlow, fetchActiveSessions, fetchRunningSessions, pendingReload, reloadNow, requestReload, __testSetPending as setReloadPendingForTest, type RunningSession } from "./reload.js"
import { enabledModules, moduleUsesOwnMenu, getModules, type ModuleContext } from "./modules.js"
import { agentVariantsModuleId, agentVariantsHiddenAliases, resetAgentVariantsLens, setModuleAlertImplementation, setModulePickImplementation } from "./modules/agent-variants.js"
import { findStandaloneAgentVariants, removeStandaloneHits } from "./standalone.js"

// ---------------------------------------------------------------------------
// Editor kit: dialog primitives + staging for the value-editors module
// ---------------------------------------------------------------------------

function makeEditorKit(api: TuiPluginApi, state: StudioState): EditorKit {
  return {
    state,
    showMenu: (props) => showMenu(api, { ...props, pin: props.pinId ? pinPropsFor(props.pinId) : undefined }),
    showPrompt: (props) => showPrompt(api.ui, props),
    showConfirm: (props) => showConfirm(api.ui, props),
    showAlert: (props) => showAlert(api.ui, props),
    showInfo: (props) => showInfo(api, props),
    showJSONEditor: (title, value) => showJSONEditor(api, title, value),
    pickModel: (title) => pickAnyModel(api, state, title),
    stage: (ops, reason) => applyEdits({ api, state }, ops, reason),
    valueAt: (pointer) => getAtPath(state.merge.merged, pointer),
    sourceLabel: (pointer) => {
      const { winner } = provenanceAt(state.merge, pointer)
      return winner ? fileLabel(state, winner) : "OpenCode default"
    },
    agentNames: () => {
      const names = new Set<string>(["build", "plan", "general"])
      for (const name of Object.keys((state.merge.merged as { agent?: Record<string, unknown> })["agent"] ?? {})) names.add(name)
      for (const agent of state.markdownAgents) names.add(agent.name)
      return [...names].sort()
    },
    providerUniverse: () => providerUniverse(state.providers, state.modelsDev, state.merge).map((row) => ({ ...row })),
    openPlugins: () => pluginManagerScreen(api, state),
    openAgents: () => agentsScreen(api, state),
    openPluginsFrom: (returnTo) => pluginManagerScreen(api, state, returnTo),
    openAgentsFrom: (returnTo) => agentsScreen(api, state, returnTo),
    variantsFor: (modelRef) => {
      const [providerID, ...rest] = modelRef.split("/")
      const modelID = rest.join("/")
      if (!modelID) return []
      const runtime = state.providers.find((item) => item.id === providerID)?.models?.[modelID]
      return runtime?.variants ? Object.keys(runtime.variants) : []
    },
    modelFamilies: () => {
      const families = new Set<string>()
      for (const provider of state.providers) {
        for (const model of Object.values(provider.models ?? {})) {
          const family = (model as unknown as { family?: unknown }).family
          if (typeof family === "string" && family) families.add(family)
        }
      }
      for (const entry of Object.values(state.modelsDev ?? {})) {
        for (const model of Object.values((entry as { models?: Record<string, unknown> }).models ?? {})) {
          const family = (model as unknown as { family?: unknown }).family
          if (typeof family === "string" && family) families.add(family)
        }
      }
      return [...families].sort()
    },
  }
}

// ---------------------------------------------------------------------------
// tui.json staging + TUI settings
// ---------------------------------------------------------------------------

async function applyTuiEdits(write: WriteContext, ops: EditOp[], reason: string): Promise<boolean> {
  let target = write.state.tuiTargetFilePath
  const existing = write.state.tuiFiles.filter((file) => file.exists && file.parseErrors.length === 0)
  if (!target || !existing.some((file) => file.path === target)) {
    const globalTui = existing.find((file) => file.label === "global tui.json") ?? existing.find((file) => file.path.includes("tui.json"))
    const options: WizardSelectOption<string>[] = existing.map((file) => ({
      title: file.label,
      value: file.path,
      description: file.path,
      edited: true,
    }))
    if (existing.length === 0) {
      options.push({ title: "+ Create global tui.json", value: "__create__", description: join(write.api.state.path.config, "tui.json"), edited: true })
    }
    options.push({ title: "< Cancel", value: "__cancel__", description: "" })
    const picked = await showMenu(write.api, { title: `tui.json - ${reason}`, options, current: target ?? globalTui?.path })
    if (!picked || picked === "__cancel__") return false
    if (picked === "__create__") {
      const created = createConfigFile(join(write.api.state.path.config, "tui.json"))
      if (!created.ok) {
        await showAlert(write.api.ui, { title: "Could not create tui.json", message: created.error ?? "unknown error" })
        return false
      }
      target = join(write.api.state.path.config, "tui.json")
      const updated = await refreshStudio(write.api, write.state)
      Object.assign(write.state, updated)
    } else {
      target = picked
    }
    write.state.tuiTargetFilePath = target
  }
  if (!stagedBases.has(target)) {
    try {
      stagedBases.set(target, existsSync(target) ? readFileSync(target, "utf8") : "")
    } catch {
      stagedBases.set(target, "")
    }
  }
  write.state.pending.push({ id: ++stagedChangeCounter, targetPath: target, ops, reason })
  const updated = await refreshStudio(write.api, write.state)
  Object.assign(write.state, updated)
  write.api.ui.toast({ variant: "info", title: "Staged", message: `${reason} - ${write.state.pending.length} pending. Save & exit writes to disk.` })
  return true
}

function makeTuiEditorKit(api: TuiPluginApi, state: StudioState): EditorKit {
  const kit = makeEditorKit(api, state)
  return {
    ...kit,
    stage: (ops, reason) => applyTuiEdits({ api, state }, ops, reason),
    valueAt: (pointer) => {
      const target = state.tuiTargetFilePath ?? state.tuiFiles.find((file) => file.exists)?.path
      const file = state.tuiFiles.find((item) => item.path === target)
      return getAtPath(file?.data ?? {}, pointer)
    },
    sourceLabel: (pointer) => {
      for (const file of state.tuiFiles) {
        if (getAtPath(file.data, pointer) !== undefined) return file.label
      }
      return "TUI default"
    },
  }
}

async function tuiSettingsScreen(api: TuiPluginApi, state: StudioState): Promise<void> {
  const kit = makeTuiEditorKit(api, state)
  const target = state.tuiTargetFilePath ?? state.tuiFiles.find((file) => file.exists)?.path
  const targetFile = state.tuiFiles.find((item) => item.path === target)
  const keybinds = kit.valueAt(["keybinds"])

  const options: WizardSelectOption<string>[] = [
    {
      title: "Target file",
      value: "__target__",
      description: targetFile ? `${targetFile.label} - ${targetFile.path}` : "none - pick on first edit",
      help: "tui.json layers merge like opencode.json (global lowest, closest project file wins). Pick which layer receives your edits.",
    },
  ]
  for (const meta of TUI_KEYS) {
    if (meta.key === "keybinds") {
      options.push({
        title: "Keybinds",
        value: "keybinds",
        description: `${Object.keys(typeof keybinds === "object" && keybinds !== null ? (keybinds as Record<string, unknown>) : {}).length} override(s) - browser`,
        help: meta.doc,
      })
      continue
    }
    const spec: ObjectFieldSpec = { key: meta.key, title: meta.title, kind: meta.kind, options: meta.options, placeholder: meta.placeholder, doc: meta.doc, fields: meta.fields }
    const value = kit.valueAt([meta.key])
    options.push({
      title: meta.title,
      value: `key:${meta.key}`,
      description: `${value === undefined ? "(default)" : String(value)} (${kit.sourceLabel([meta.key])})`,
      help: meta.doc,
      edited: value !== undefined,
    })
    void spec
  }
  options.push({ title: "! Restart note", value: "__restart__", description: "ALL tui.json changes need a TUI restart", danger: true })
  options.push({ title: "< Back", value: "__back__", description: "" })

  const picked = await showMenu(api, { title: "TUI settings (tui.json)", options })
  if (!picked || picked === "__back__") return mainMenu(api, state)
  if (picked === "__restart__") {
    await showInfo(api, {
      title: "RESTART REQUIRED",
      message: "TUI config is read once at process start. Every tui.json change (theme, keybinds, cursor, sounds, ...) takes effect only after OpenCode restarts.",
    })
    return tuiSettingsScreen(api, state)
  }
  if (picked === "__target__") {
    const existing = state.tuiFiles.filter((file) => file.exists && file.parseErrors.length === 0)
    const targetOptions: WizardSelectOption<string>[] = existing.map((file) => ({ title: file.label, value: file.path, description: file.path, edited: true }))
    targetOptions.push({ title: "< Cancel", value: "__cancel__", description: "" })
    const chosen = await showMenu(api, { title: "Edit which tui.json?", options: targetOptions, current: state.tuiTargetFilePath })
    if (chosen && chosen !== "__cancel__") {
      state.tuiTargetFilePath = chosen
    }
    return tuiSettingsScreen(api, state)
  }
  if (picked === "keybinds") {
    await keybindBrowser(api, state)
    return tuiSettingsScreen(api, state)
  }
  if (picked.startsWith("key:")) {
    const key = picked.slice(4)
    const meta = TUI_KEYS.find((item) => item.key === key)
    if (!meta) return tuiSettingsScreen(api, state)
    const spec: ObjectFieldSpec = { key: meta.key, title: meta.title, kind: meta.kind, options: meta.options, placeholder: meta.placeholder, doc: meta.doc, fields: meta.fields }
    await kitFieldEditor(kit, spec, [meta.key])
    return tuiSettingsScreen(api, state)
  }
  return tuiSettingsScreen(api, state)
}

async function keybindBrowser(api: TuiPluginApi, state: StudioState): Promise<void> {
  const write: WriteContext = { api, state }
  const query = await showPrompt(api.ui, { title: "Keybind search (empty = browse all)", placeholder: "e.g. session, diff, input" })
  if (query === undefined) return
  const groups = keybindGroupsMatching(query)
  if (groups.length === 0) {
    await showAlert(api.ui, { title: "No matches", message: `No keybind names match "${query}".` })
    return
  }
  const groupPick = await showMenu(api, {
    title: "Keybind groups",
    options: [...groups.map((group) => ({ title: group.group, value: group.group, description: `${group.names.length} binding(s)` })), { title: "< Cancel", value: "__cancel__", description: "" }],
  })
  if (!groupPick || groupPick === "__cancel__") return
  const group = groups.find((item) => item.group === groupPick)!
  const currentMap = (() => {
    const target = state.tuiTargetFilePath ?? state.tuiFiles.find((file) => file.exists)?.path
    const file = state.tuiFiles.find((item) => item.path === target)
    const value = getAtPath(file?.data ?? {}, ["keybinds"])
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
  })()

  const options: WizardSelectOption<string>[] = group.names.map((name) => ({
    title: name,
    value: name,
    description: currentMap[name] === undefined ? "(built-in default)" : String(currentMap[name]),
    edited: currentMap[name] !== undefined,
    help: "Binding value: combo string (\"ctrl+x,ctrl+d\"), \"none\" or false to unbind, or a key-stroke object via JSON.",
  }))
  options.push({ title: "< Back", value: "__back__", description: "" })
  const picked = await showMenu(api, { title: `${groupPick} bindings`, options })
  if (!picked || picked === "__back__") return
  const current = currentMap[picked]

  const action = await showMenu(api, {
    title: picked,
    options: [
      { title: "Set binding", value: "set", description: current === undefined ? "(built-in default)" : `current: ${String(current)}` },
      { title: "Clear override", value: "clear", description: "remove - fall back to built-in default", danger: current !== undefined },
      { title: "Unbind (none)", value: "none", description: "disable this key entirely" },
      { title: "Edit as JSON", value: "json", description: "key-stroke / binding objects" },
      { title: "< Cancel", value: "__cancel__", description: "" },
    ],
  })
  if (!action || action === "__cancel__") return
  if (action === "clear") {
    await applyTuiEdits(write, [{ op: "delete", path: ["keybinds", picked] }], `keybind ${picked} cleared`)
    return
  }
  if (action === "none") {
    await applyTuiEdits(write, [{ op: "set", path: ["keybinds", picked], value: "none" }], `keybind ${picked} = none`)
    return
  }
  if (action === "set") {
    const binding = await showPrompt(api.ui, { title: `Binding for ${picked}`, placeholder: "e.g. ctrl+alt+d, <leader>r", value: typeof current === "string" ? current : "" })
    if (binding === undefined || binding.trim() === "") return
    await applyTuiEdits(write, [{ op: "set", path: ["keybinds", picked], value: binding.trim() }], `keybind ${picked} = ${binding.trim()}`)
    return
  }
  const body = await showJSONEditor(api, `Binding object - ${picked}`, typeof current === "object" && current !== null ? current : {})
  if (body === undefined) return
  if (body === "__delete__") {
    await applyTuiEdits(write, [{ op: "delete", path: ["keybinds", picked] }], `keybind ${picked} cleared`)
    return
  }
  await applyTuiEdits(write, [{ op: "set", path: ["keybinds", picked], value: body }], `keybind ${picked} set`)
}

// ---------------------------------------------------------------------------
// Plugin manager (unified opencode.json + tui.json arrays)
// ---------------------------------------------------------------------------

async function pluginManagerScreen(api: TuiPluginApi, state: StudioState, returnTo?: () => Promise<void>): Promise<void> {
  const write: WriteContext = { api, state }
  while (true) {
    const rows: Array<{ spec: string; file: string; isTui: boolean; index: number; hasOptions: boolean }> = []
    for (const file of state.files) {
      if (!file.exists || file.parseErrors.length > 0) continue
      const plugins = file.data["plugin"]
      if (!Array.isArray(plugins)) continue
      plugins.forEach((entry, index) => {
        if (typeof entry === "string") rows.push({ spec: entry, file: file.path, isTui: false, index, hasOptions: false })
        else if (Array.isArray(entry) && typeof entry[0] === "string") rows.push({ spec: entry[0], file: file.path, isTui: false, index, hasOptions: true })
      })
    }
    for (const file of state.tuiFiles) {
      if (!file.exists || file.parseErrors.length > 0) continue
      const plugins = file.data["plugin"]
      if (!Array.isArray(plugins)) continue
      plugins.forEach((entry, index) => {
        if (typeof entry === "string") rows.push({ spec: entry, file: file.path, isTui: true, index, hasOptions: false })
        else if (Array.isArray(entry) && typeof entry[0] === "string") rows.push({ spec: entry[0], file: file.path, isTui: true, index, hasOptions: true })
      })
    }

    const options: WizardSelectOption<string>[] = rows.map((row, i) => ({
      title: row.spec + (row.hasOptions ? " [options]" : ""),
      value: `row:${i}`,
      description: `${row.isTui ? "tui.json" : "opencode.json"} - ${row.file}`,
      edited: true,
      help: "Plugin entry. Restart required after add/remove.",
    }))
    options.push({ title: "+ Add plugin", value: "add", description: "npm spec or file:// path" })
    options.push({ title: "< Back", value: "__back__", description: rows.length === 0 ? "(no plugins configured in any file)" : "" })

    const picked = await showMenu(api, { title: "Plugins", options })
    if (!picked || picked === "__back__") return returnTo ? returnTo() : mainMenu(api, state)

    if (picked === "add") {
      const spec = await showPrompt(api.ui, { title: "Plugin spec", placeholder: "package@version or file:///C:/path (or package@tag)" })
      if (spec === undefined || spec.trim() === "") continue
      const withOptions = await showConfirm(api.ui, { title: "Plugin options", message: "Attach an options object? (the [spec, options] tuple form)", confirmLabel: "Add options" })
      let entry: unknown = spec.trim()
      if (withOptions) {
        const body = await showJSONEditor(api, `Options - ${spec.trim()}`, {})
        if (body === undefined || body === "__delete__") continue
        entry = [spec.trim(), body]
      }
      const targetFiles: WizardSelectOption<string>[] = [
        ...state.files.filter((file) => file.exists && file.parseErrors.length === 0).map((file) => ({ title: `opencode.json - ${file.label}`, value: `oc:${file.path}`, description: file.path, edited: true })),
        ...state.tuiFiles.filter((file) => file.exists && file.parseErrors.length === 0).map((file) => ({ title: `tui.json - ${file.label}`, value: `tui:${file.path}`, description: `${file.path} (TUI-side plugins only)`, edited: true })),
      ]
      targetFiles.push({ title: "< Cancel", value: "__cancel__", description: "" })
      const chosen = await showMenu(api, { title: "Add to which file?", options: targetFiles })
      if (!chosen || chosen === "__cancel__") continue
      const isTui = chosen.startsWith("tui:")
      const path = chosen.slice(4)
      const current = (() => {
        const entry = (isTui ? state.tuiFiles : state.files).find((file) => file.path === path)
        return Array.isArray(entry?.data["plugin"]) ? entry!.data["plugin"] as unknown[] : []
      })()
      const next = [...current, entry]
      const ok = isTui
        ? await applyTuiEdits(write, [{ op: "set", path: ["plugin"], value: next }], `plugin add ${spec.trim()}`)
        : await stageInFile(api, state, path, [{ op: "set", path: ["plugin"], value: next }], `plugin add ${spec.trim()}`)
      if (ok) {
        await showInfo(api, { title: "RESTART REQUIRED", message: `Plugin "${spec.trim()}" staged.\n\nNew plugins load only after OpenCode restarts.` })
      }
      continue
    }

    if (picked.startsWith("row:")) {
      const row = rows[Number(picked.slice(4))]!
      const action = await showMenu(api, {
        title: row.spec,
        options: [
          ...(row.hasOptions ? [{ title: "Edit options", value: "options", description: "the [spec, options] tuple" } as WizardSelectOption<string>] : []),
          { title: "Remove", value: "remove", description: "", danger: true },
          { title: "< Cancel", value: "__cancel__", description: "" },
        ],
      })
      if (!action || action === "__cancel__") continue
      if (action === "remove") {
        if (!(await showConfirm(api.ui, { title: "Remove plugin", message: `Remove ${row.spec} from\n${row.file}\n\nand restart?`, confirmLabel: "Remove" }))) continue
        const ok = row.isTui
          ? await applyTuiEdits(write, [{ op: "delete", path: ["plugin", row.index] }], `plugin remove ${row.spec}`)
          : await stageInFile(api, state, row.file, [{ op: "delete", path: ["plugin", row.index] }], `plugin remove ${row.spec}`)
        if (ok) {
          await showInfo(api, { title: "RESTART REQUIRED", message: `Plugin "${row.spec}" removal staged.\n\nOpenCode must restart to unload it.` })
        }
        continue
      }
      if (action === "options") {
        const fileEntry = (row.isTui ? state.tuiFiles : state.files).find((file) => file.path === row.file)
        const list = fileEntry?.data["plugin"] as unknown[] | undefined
        const tuple = list?.[row.index] as [string, Record<string, unknown>] | undefined
        const body = await showJSONEditor(api, `Options - ${row.spec}`, tuple?.[1] ?? {})
        if (body === undefined) continue
        if (body === "__delete__") {
          const ok = row.isTui
            ? await applyTuiEdits(write, [{ op: "set", path: ["plugin", row.index], value: row.spec }], `plugin options removed ${row.spec}`)
            : await stageInFile(api, state, row.file, [{ op: "set", path: ["plugin", row.index], value: row.spec }], `plugin options removed ${row.spec}`)
          void ok
          continue
        }
        const ok = row.isTui
          ? await applyTuiEdits(write, [{ op: "set", path: ["plugin", row.index], value: [row.spec, body] }], `plugin options updated ${row.spec}`)
          : await stageInFile(api, state, row.file, [{ op: "set", path: ["plugin", row.index], value: [row.spec, body] }], `plugin options updated ${row.spec}`)
        void ok
        continue
      }
    }
  }
}

/** Stage ops against one explicit file (bypasses the generic target picker). */
async function stageInFile(api: TuiPluginApi, state: StudioState, filePath: string, ops: EditOp[], reason: string): Promise<boolean> {
  if (!stagedBases.has(filePath)) {
    try {
      stagedBases.set(filePath, existsSync(filePath) ? readFileSync(filePath, "utf8") : "")
    } catch {
      stagedBases.set(filePath, "")
    }
  }
  state.pending.push({ id: ++stagedChangeCounter, targetPath: filePath, ops, reason })
  const updated = await refreshStudio(api, state)
  Object.assign(state, updated)
  api.ui.toast({ variant: "info", title: "Staged", message: `${reason} - ${state.pending.length} pending. Save & exit writes to disk.` })
  return true
}

// ---------------------------------------------------------------------------
// Cleanup & migrations
// ---------------------------------------------------------------------------

interface CleanupFinding {
  rule: string
  file: string
  detail: string
  ops: EditOp[]
}

function scanCleanupFindings(state: StudioState): CleanupFinding[] {
  const findings: CleanupFinding[] = []
  for (const file of state.files) {
    if (!file.exists || file.parseErrors.length > 0) continue
    const data = file.data

    const mode = data["mode"]
    if (isPlainObjectData(mode)) {
      const ops: EditOp[] = []
      for (const [name, entry] of Object.entries(mode)) {
        const existingAgentEntry = (data["agent"] as Record<string, unknown> | undefined)?.[name]
        const merged = { ...(isPlainObjectData(existingAgentEntry) ? existingAgentEntry : {}), ...(isPlainObjectData(entry) ? entry : {}), mode: "primary" as const }
        ops.push({ op: "set", path: ["agent", name], value: merged })
      }
      ops.push({ op: "delete", path: ["mode"] })
      findings.push({ rule: "mode", file: file.path, detail: `${Object.keys(mode).length} mode entrie(s) -> agent`, ops })
    }

    const tools = data["tools"]
    if (isPlainObjectData(tools) && Object.keys(tools).length > 0) {
      const existingPermission = isPlainObjectData(data["permission"]) ? (data["permission"] as Record<string, unknown>) : {}
      const converted = toolsToPermission(tools as Record<string, unknown>)
      findings.push({
        rule: "tools",
        file: file.path,
        detail: `${Object.keys(tools).length} tool toggle(s) -> permission`,
        ops: [
          { op: "set", path: ["permission"], value: { ...converted, ...existingPermission } },
          { op: "delete", path: ["tools"] },
        ],
      })
    }

    if (data["autoshare"] !== undefined) {
      const ops: EditOp[] = data["autoshare"] === true ? [{ op: "set", path: ["share"], value: "auto" }] : []
      ops.push({ op: "delete", path: ["autoshare"] })
      findings.push({ rule: "autoshare", file: file.path, detail: `autoshare: ${String(data["autoshare"])} -> share: "auto"`, ops })
    }

    const reference = data["reference"]
    if (isPlainObjectData(reference)) {
      const existingReferences = isPlainObjectData(data["references"]) ? (data["references"] as Record<string, unknown>) : {}
      findings.push({
        rule: "reference",
        file: file.path,
        detail: `${Object.keys(reference).length} reference entrie(s) -> references`,
        ops: [
          { op: "set", path: ["references"], value: { ...reference, ...existingReferences } },
          { op: "delete", path: ["reference"] },
        ],
      })
    }

    if (data["layout"] !== undefined) findings.push({ rule: "layout", file: file.path, detail: `layout: ${String(data["layout"])} (dead)`, ops: [{ op: "delete", path: ["layout"] }] })
    if (data["logLevel"] !== undefined) findings.push({ rule: "logLevel", file: file.path, detail: `logLevel: ${String(data["logLevel"])} (dead in files)`, ops: [{ op: "delete", path: ["logLevel"] }] })

    // theme/keybinds/tui in opencode.json -> migrate to tui.json
    const tuiKeysPresent = (["theme", "keybinds", "tui"] as const).filter((key) => data[key] !== undefined)
    if (tuiKeysPresent.length > 0) {
      findings.push({
        rule: "tui-migrate",
        file: file.path,
        detail: `${tuiKeysPresent.join(", ")} stripped at load - OpenCode auto-migrates them to tui.json`,
        ops: tuiKeysPresent.map((key) => ({ op: "delete" as const, path: [key] })),
      })
    }

    const agent = data["agent"]
    if (isPlainObjectData(agent)) {
      for (const [name, entry] of Object.entries(agent)) {
        if (!isPlainObjectData(entry)) continue
        const agentTools = entry["tools"]
        if (isPlainObjectData(agentTools) && Object.keys(agentTools).length > 0) {
          const existingPermission = isPlainObjectData(entry["permission"]) ? (entry["permission"] as Record<string, unknown>) : {}
          findings.push({
            rule: "agent.tools",
            file: file.path,
            detail: `agent "${name}": ${Object.keys(agentTools).length} tool toggle(s) -> permission`,
            ops: [
              { op: "set", path: ["agent", name, "permission"], value: { ...toolsToPermission(agentTools as Record<string, unknown>), ...existingPermission } },
              { op: "delete", path: ["agent", name, "tools"] },
            ],
          })
        }
        if (entry["maxSteps"] !== undefined) {
          findings.push({
            rule: "agent.maxSteps",
            file: file.path,
            detail: `agent "${name}": maxSteps -> steps`,
            ops: [
              { op: "set", path: ["agent", name, "steps"], value: entry["maxSteps"] },
              { op: "delete", path: ["agent", name, "maxSteps"] },
            ],
          })
        }
      }
    }
  }
  return findings
}

function isPlainObjectData(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function cleanupScreen(api: TuiPluginApi, state: StudioState): Promise<void> {
  const findings = scanCleanupFindings(state)
  const byRule = new Map(CLEANUP_RULES.map((rule) => [rule.target, rule]))
  while (true) {
    if (findings.length === 0) {
      await showInfo(api, {
        title: "Cleanup",
        message: "No deprecated keys found in any config file.\n\nThe scanner checks: mode, tools, autoshare, reference, layout, logLevel, per-agent tools/maxSteps, and theme/keybinds/tui misplaced in opencode.json.",
      })
      return mainMenu(api, state)
    }
    const options: WizardSelectOption<string>[] = findings.map((finding, i) => ({
      title: `${byRule.get(finding.rule)?.title ?? finding.rule} - ${fileLabel(state, state.files.find((file) => file.path === finding.file)?.id)}`,
      value: `fix:${i}`,
      description: finding.detail,
      danger: true,
      help: `${finding.file}\n\n${byRule.get(finding.rule)?.detail ?? ""}`,
    }))
    options.push({ title: "Apply all", value: "apply-all", description: `${findings.length} migration(s)` })
    options.push({ title: "< Back", value: "__back__", description: "" })
    const picked = await showMenu(api, { title: "Cleanup & migrations", options })
    if (!picked || picked === "__back__") return mainMenu(api, state)
    if (picked === "apply-all") {
      for (const finding of findings) {
        await stageInFile(api, state, finding.file, finding.ops, `cleanup ${finding.rule}`)
      }
      await showInfo(api, { title: "Staged", message: `${findings.length} migration(s) staged.\n\nReview them in Save & exit before writing.` })
      return mainMenu(api, state)
    }
    if (picked.startsWith("fix:")) {
      const finding = findings[Number(picked.slice(4))]!
      await stageInFile(api, state, finding.file, finding.ops, `cleanup ${finding.rule}`)
      findings.splice(Number(picked.slice(4)), 1)
      continue
    }
  }
}


type DisplayColor = string | TuiPluginApi["theme"]["current"]["text"]
export type WizardSelectOption<Value = unknown> = TuiDialogSelectOption<Value> & {
  color?: DisplayColor
  danger?: boolean
  help?: string
  edited?: boolean
  /** Non-interactive section separator row (never focusable, clickable, or filtered). */
  divider?: boolean
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
  /** tui.json layers (own precedence family; never merged into opencode.json). */
  tuiFiles: ConfigFileEntry[]
  /** Selected tui.json write target for the TUI settings screens. */
  tuiTargetFilePath: string | undefined
  /** Markdown-defined agents (.opencode/agent and agents dirs, recursive md). */
  markdownAgents: MarkdownAgent[]
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

// ---------------------------------------------------------------------------
// Dialog size picker (AV-style slider with a live mini preview)
// ---------------------------------------------------------------------------

type SizeSliderChoice = { action: "save" | "custom-height" } & { height: number }

async function showSizeSlider(api: TuiPluginApi): Promise<SizeSliderChoice | undefined> {
  let current = wizardDialogHeightPercent(api)
  while (true) {
    const choice = await showSizeSliderOnce(api, current)
    if (!choice) return undefined
    current = choice.height
    if (choice.action === "save") return choice

    const input = await showPrompt(api.ui, {
      title: "Dialog height percent",
      placeholder: `${HEIGHT_PERCENT_MIN}-${HEIGHT_PERCENT_MAX}`,
      value: String(current),
    })
    if (input === undefined) continue
    const value = Number(input)
    if (!Number.isFinite(value)) {
      await showAlert(api.ui, { title: "Invalid height", message: `Enter a number from ${HEIGHT_PERCENT_MIN} to ${HEIGHT_PERCENT_MAX}.` })
      continue
    }
    current = clampHeightPercent(value)
  }
}

function showSizeSliderOnce(api: TuiPluginApi, current: number): Promise<SizeSliderChoice | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: SizeSliderChoice | undefined, clear = true) => {
      if (settled) return
      settled = true
      resolve(value)
      if (clear) api.ui.dialog.clear()
    }
    api.ui.dialog.replace(
      () => <SizeSliderDialog api={api} current={current} onDone={done} />,
      () => done(undefined, false),
    )
  })
}

const DIALOG_WIDTH_COLUMNS: Record<DialogSize, number> = { medium: 60, large: 88, xlarge: 116 }

function SizeSliderDialog(props: { api: TuiPluginApi; current: number; onDone: (value: SizeSliderChoice | undefined) => void }) {
  const theme = () => props.api.theme.current
  useWizardDialogSize(props.api)
  useHidePromptCursor(props.api)
  const dimensions = useTerminalDimensions()
  const [height, setHeight] = createSignal(clampHeightPercent(props.current))
  const popMode = props.api.mode.push("config-studio.dialog")
  const commandPrefix = `config-studio.size.${Math.random().toString(36).slice(2)}`

  const cycleWidth = () => setWizardDialogSize(props.api, nextWizardDialogSize(props.api))

  const setPreset = (preset: DialogHeight) => {
    const found = HEIGHT_PRESETS.find((item) => item.label === preset)
    if (found) setHeight(found.value)
  }
  const move = (delta: number) => setHeight((value) => clampHeightPercent(value + delta))

  const sliderWidth = createMemo(() => (wizardDialogSize(props.api) === "xlarge" ? 64 : wizardDialogSize(props.api) === "large" ? 48 : 34))
  const sliderCells = createMemo(() => {
    const width = sliderWidth()
    const selected = Math.round(((height() - HEIGHT_PERCENT_MIN) / (HEIGHT_PERCENT_MAX - HEIGHT_PERCENT_MIN)) * (width - 1))
    const presetPositions = new Map(HEIGHT_PRESETS.map((preset) => [Math.round(((preset.value - HEIGHT_PERCENT_MIN) / (HEIGHT_PERCENT_MAX - HEIGHT_PERCENT_MIN)) * (width - 1)), preset.label]))
    return Array.from({ length: width }, (_, index) => {
      const isCurrent = index === selected
      const preset = presetPositions.get(index)
      return {
        char: isCurrent ? "●" : preset ? "│" : index < selected ? "━" : "─",
        color: isCurrent ? theme().primary : preset ? theme().accent : index < selected ? theme().success : theme().textMuted,
      }
    })
  })

  /** Live mini preview: a mock dialog box scaled to the current settings.
   * Uses dialogMetrics so the preview shows the TRUE capped height (what
   * real dialogs will do), not the raw percent math. */
  const preview = createMemo(() => {
    const widthColumns = DIALOG_WIDTH_COLUMNS[wizardDialogSize(props.api)]
    const previewWidth = Math.max(10, Math.min(sliderWidth() + 4, 72))
    const scale = previewWidth / widthColumns
    // Same math the real dialogs use (dialogMetrics shares this budget).
    const metrics = dialogMetrics(props.api, dimensions().height, 6, 4)
    const effective = metrics.targetRows
    const requested = Math.floor((dimensions().height * Math.min(100, Math.max(25, height()))) / 100)
    const rows = Math.max(4, Math.round(effective * scale))
    const fill = (text: string, width: number) => {
      const inner = width - 2
      const slice = text.length > inner ? text.slice(0, inner - 1) + "…" : text
      return `│${slice}${" ".repeat(Math.max(0, inner - slice.length))}│`
    }
    const lines: string[] = []
    lines.push(`┌${"─".repeat(previewWidth - 2)}┐`)
    lines.push(fill(`Config Studio (preview)${effective < requested ? " [capped]" : ""}`, previewWidth))
    for (let index = 0; index < rows - 3; index++) lines.push(fill("", previewWidth))
    lines.push(`└${"─".repeat(previewWidth - 2)}┘`)
    return lines
  })

  const unregister = props.api.keymap.registerLayer({
    priority: 10000,
    commands: [
      { name: `${commandPrefix}.width`, title: "Cycle width", run: (ctx: KeyContext) => { blockKey(ctx); cycleWidth() } },
      { name: `${commandPrefix}.left`, title: "Lower height", run: (ctx: KeyContext) => { blockKey(ctx); move(-1) } },
      { name: `${commandPrefix}.right`, title: "Raise height", run: (ctx: KeyContext) => { blockKey(ctx); move(1) } },
      { name: `${commandPrefix}.down`, title: "Lower height faster", run: (ctx: KeyContext) => { blockKey(ctx); move(-5) } },
      { name: `${commandPrefix}.up`, title: "Raise height faster", run: (ctx: KeyContext) => { blockKey(ctx); move(5) } },
      { name: `${commandPrefix}.compact`, title: "Compact preset", run: (ctx: KeyContext) => { blockKey(ctx); setPreset("compact") } },
      { name: `${commandPrefix}.normal`, title: "Normal preset", run: (ctx: KeyContext) => { blockKey(ctx); setPreset("normal") } },
      { name: `${commandPrefix}.tall`, title: "Tall preset", run: (ctx: KeyContext) => { blockKey(ctx); setPreset("tall") } },
      { name: `${commandPrefix}.max`, title: "Max preset", run: (ctx: KeyContext) => { blockKey(ctx); setPreset("max") } },
      { name: `${commandPrefix}.custom`, title: "Custom percent", run: (ctx: KeyContext) => { blockKey(ctx); props.onDone({ action: "custom-height", height: height() }) } },
      { name: `${commandPrefix}.save`, title: "Save", run: (ctx: KeyContext) => { blockKey(ctx); setWizardDialogHeightPercent(props.api, height()); props.onDone({ action: "save", height: height() }) } },
      { name: `${commandPrefix}.back`, title: "Back", run: (ctx: KeyContext) => { blockKey(ctx); props.onDone(undefined) } },
      { name: `${commandPrefix}.shield`, title: "Block background input", run: blockKey },
    ],
    bindings: [
      { key: "w", cmd: `${commandPrefix}.width`, desc: "Cycle width" },
      { key: "left", cmd: `${commandPrefix}.left`, desc: "Lower height" },
      { key: "right", cmd: `${commandPrefix}.right`, desc: "Raise height" },
      { key: "down", cmd: `${commandPrefix}.down`, desc: "Lower height faster" },
      { key: "up", cmd: `${commandPrefix}.up`, desc: "Raise height faster" },
      { key: "1", cmd: `${commandPrefix}.compact`, desc: "Compact preset" },
      { key: "2", cmd: `${commandPrefix}.normal`, desc: "Normal preset" },
      { key: "3", cmd: `${commandPrefix}.tall`, desc: "Tall preset" },
      { key: "4", cmd: `${commandPrefix}.max`, desc: "Max preset" },
      { key: "c", cmd: `${commandPrefix}.custom`, desc: "Custom percent" },
      { key: "enter", cmd: `${commandPrefix}.save`, desc: "Save" },
      { key: "escape", cmd: `${commandPrefix}.back`, desc: "Back" },
      ...shieldBindings(`${commandPrefix}.shield`, ["w", "1", "2", "3", "4", "c"]),
    ],
  })
  onCleanup(() => {
    unregister()
    popMode()
  })

  return (
    <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" width="100%" marginBottom={1}>
        <text fg={theme().accent}><b>Dialog size</b></text>
        <text fg={theme().textMuted} onMouseUp={() => props.onDone(undefined)}>esc</text>
      </box>
      <box flexDirection="row" gap={0} width="100%" marginBottom={1}>
        <text fg={theme().textMuted}>Width: </text>
        <text fg={theme().primary}><b>{wizardDialogSize(props.api)}</b></text>
        <text fg={theme().textMuted}> ({DIALOG_WIDTH_COLUMNS[wizardDialogSize(props.api)]} cols, w to cycle)   Height: </text>
        <text fg={theme().primary}><b>{height()}%</b></text>
      </box>
      <box flexDirection="row" width="100%" marginBottom={1}>
        <text fg={theme().textMuted}>{HEIGHT_PERCENT_MIN}% </text>
        <For each={sliderCells()}>{(cell) => <text fg={cell.color}>{cell.char}</text>}</For>
        <text fg={theme().textMuted}> {HEIGHT_PERCENT_MAX}%</text>
      </box>
      <box flexDirection="row" gap={2} marginBottom={1}>
        <box flexDirection="column" gap={0}>
          <For each={HEIGHT_PRESETS}>
            {(preset) => <text fg={height() === preset.value ? theme().primary : theme().textMuted}>{preset.key} {preset.label}: {preset.value}%</text>}
          </For>
          <text fg={theme().textMuted}> </text>
          <text fg={theme().textMuted}>left/right 1%</text>
          <text fg={theme().textMuted}>up/down 5%</text>
          <text fg={theme().textMuted}>c custom</text>
        </box>
        <box flexDirection="column" gap={0}>
          <For each={preview()}>
            {(line) => <text fg={theme().textMuted}>{line}</text>}
          </For>
        </box>
      </box>
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <text fg={theme().textMuted}>enter save</text>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme().primary} onMouseUp={() => { setWizardDialogHeightPercent(props.api, height()); props.onDone({ action: "save", height: height() }) }}>
          <text fg={theme().background}><b>save</b></text>
        </box>
      </box>
    </box>
  )
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

/**
 * TRUE dialog container budget. OpenCode's dialog backdrop reserves
 * paddingTop = terminalHeight / 4 and the panel grows with content, so a
 * dialog taller than 75% of the terminal overflows the bottom edge.
 * Preview + every dialog consume this ONE function - they cannot diverge.
 */
export function dialogMetrics(api: TuiPluginApi, terminalHeight: number, chromeRows: number, minRows: number) {
  return computeDialogRows(wizardDialogHeightPercent(api), terminalHeight, chromeRows, minRows)
}

function wizardMaxRows(api: TuiPluginApi, terminalHeight: number, chromeRows: number, minRows: number) {
  return dialogMetrics(api, terminalHeight, chromeRows, minRows).targetRows
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

async function showMenu<Value>(api: TuiPluginApi, props: { title: string; options: WizardSelectOption<Value>[]; current?: Value; pin?: { id: string; onToggle: () => void } }): Promise<Value | undefined> {
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
/** Most recent TuiPluginApi (pin toggling needs host access from dialogs). */
let activeApi: TuiPluginApi | undefined

function currentApi(): TuiPluginApi | undefined {
  return activeApi
}

export function __setMenuProbe(probe?: MenuProbe): void {
  menuProbe = probe
}

function probeMenuOnce<Value>(props: { title: string; options: WizardSelectOption<Value>[] }): { handled: boolean; selection?: Value } {
  if (!menuProbe?.onMenu) return { handled: false }
  const selection = menuProbe.onMenu(props.title, props.options as WizardSelectOption<unknown>[])
  if (selection === undefined || selection === null) return { handled: true }
  return { handled: true, selection: selection as Value }
}

function showMenuOnce<Value>(api: TuiPluginApi, props: { title: string; options: WizardSelectOption<Value>[]; current?: Value; pin?: { id: string; onToggle: () => void } }): Promise<MenuChoice<Value> | undefined> {
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
      () => <MenuDialog api={api} title={props.title} options={props.options} current={props.current} pin={props.pin} onDone={done} />,
      () => done(undefined, false),
    )
  })
}

function MenuDialog<Value>(props: {
  api: TuiPluginApi
  title: string
  options: WizardSelectOption<Value>[]
  current?: Value
  pin?: { id: string; onToggle: () => void }
  onDone: (value: MenuChoice<Value> | undefined) => void
}) {
  const theme = () => props.api.theme.current
  useWizardDialogSize(props.api)
  useHidePromptCursor(props.api)
  const dimensions = useTerminalDimensions()
  const [filtering, setFiltering] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const visibleOptions = createMemo(() => {
    const text = query().trim()
    // Filter on the QUERY, not the input-mode flag: Enter saves the query and
    // unlocks shortcuts while the list stays filtered; Esc clears it.
    // Dividers are structural and always visible (never matched, never hidden).
    if (text === "") return props.options
    return rankOptions(
      props.options.filter((option) => !option.divider).map((option) => ({ title: String(option.title), description: option.description ?? "", value: option.value, option })),
      text,
    ).map((ranked) => (ranked as { option: WizardSelectOption<Value> }).option)
  })
  const listHeight = createMemo(() => cappedHeight(visibleOptions().length, wizardMaxRows(props.api, dimensions().height, 6, 6)))
  const titleWidth = createMemo(() => menuTitleWidth(wizardDialogSize(props.api), props.options))
  let scroll: ScrollBoxRenderable | undefined
  const popMode = props.api.mode.push("config-studio.dialog")
  const [selected, setSelected] = createSignal((() => {
    const initial = Math.max(0, props.options.findIndex((option) => option.value === props.current))
    let index = initial
    while (index < props.options.length && props.options[index]?.divider) index++
    return index < props.options.length ? index : initial
  })())
  const current = createMemo(() => visibleOptions()[selected()] ?? visibleOptions()[0])
  /** Move one step, skipping divider rows (they can never hold the selection). */
  const move = (delta: number) => setSelected((value) => {
    const list = visibleOptions()
    const count = list.length
    let next = Math.max(0, Math.min(count - 1, value + delta))
    while (next >= 0 && next < count && list[next]?.divider) next += delta >= 0 ? 1 : -1
    if (next < 0 || next >= count || list[next]?.divider) return value
    scroll?.scrollTo(Math.max(0, next - 2))
    return next
  })
  const choose = () => {
    const option = current()
    if (!option || option.disabled || option.divider) return
    props.onDone({ action: "select", value: option.value })
  }
  const inspect = () => {
    const option = current()
    if (!option || option.disabled || option.divider) return
    props.onDone({ action: "inspect", value: option.value })
  }
  const commandPrefix = `config-studio.menu.${Math.random().toString(36).slice(2)}`
  const typeFilterChar = (char: string) => {
    setQuery((value) => value + char)
    setSelected(0)
    scroll?.scrollTo(0)
  }
  const clearFilter = () => {
    setFiltering(false)
    setQuery("")
    setSelected(0)
  }
  const unregister = props.api.keymap.registerLayer({
    priority: 10000,
    commands: [
      { name: `${commandPrefix}.up`, title: "Previous item", run: (ctx: KeyContext) => { blockKey(ctx); move(-1) } },
      { name: `${commandPrefix}.down`, title: "Next item", run: (ctx: KeyContext) => { blockKey(ctx); move(1) } },
      { name: `${commandPrefix}.select`, title: "Select item", run: (ctx: KeyContext) => { blockKey(ctx); choose() } },
      { name: `${commandPrefix}.inspect`, title: "Item help", run: (ctx: KeyContext) => { blockKey(ctx); inspect() } },
      { name: `${commandPrefix}.back`, title: "Back", run: (ctx: KeyContext) => {
        blockKey(ctx)
        if (filtering() || query() !== "") {
          clearFilter()
          return
        }
        props.onDone(undefined)
      } },
      { name: `${commandPrefix}.filter`, title: "Search list", run: (ctx: KeyContext) => { blockKey(ctx); setFiltering(true) } },
      { name: `${commandPrefix}.pin`, title: "Pin/unpin to Quick access", run: (ctx: KeyContext) => { blockKey(ctx); props.pin?.onToggle() } },
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
      { key: "/", cmd: `${commandPrefix}.filter`, desc: "Search list" },
      ...(props.pin ? [{ key: "f", cmd: `${commandPrefix}.pin`, desc: "Pin to Quick access" }] : []),
      ...shieldBindings(`${commandPrefix}.shield`, ["i", "f"]),
    ],
  })
  onCleanup(() => {
    unregister()
    popMode()
  })

  // Filter-input layer: exists ONLY while filtering. Sits above the menu
  // layer so every printable key types into the query box instead of
  // triggering menu shortcuts; enter saves the query, escape clears it.
  createEffect(() => {
    if (!filtering()) return
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789 -_."
    const commands: Array<{ name: string; title: string; run: (ctx: KeyContext) => void }> = []
    const bindings: Array<{ key: string; cmd: string; desc: string }> = []
    for (const char of chars) {
      const cmdName = `${commandPrefix}.type.${char.codePointAt(0)}`
      commands.push({ name: cmdName, title: "Type into search", run: (ctx: KeyContext) => { blockKey(ctx); typeFilterChar(char) } })
      bindings.push({ key: char === " " ? "space" : char, cmd: cmdName, desc: "Type into search" })
    }
    commands.push({ name: `${commandPrefix}.filterAccept`, title: "Save search", run: (ctx: KeyContext) => { blockKey(ctx); setFiltering(false); setSelected(0) } })
    bindings.push({ key: "enter", cmd: `${commandPrefix}.filterAccept`, desc: "Save search" })
    commands.push({ name: `${commandPrefix}.filterClear`, title: "Clear search", run: (ctx: KeyContext) => { blockKey(ctx); clearFilter() } })
    bindings.push({ key: "escape", cmd: `${commandPrefix}.filterClear`, desc: "Clear search" })
    commands.push({ name: `${commandPrefix}.filterBackspace`, title: "Delete search char", run: (ctx: KeyContext) => { blockKey(ctx); setQuery((value) => value.slice(0, -1)) } })
    bindings.push({ key: "backspace", cmd: `${commandPrefix}.filterBackspace`, desc: "Delete search char" })
    const unregisterFilter = props.api.keymap.registerLayer({ priority: 10001, commands, bindings })
    onCleanup(() => unregisterFilter())
  })

  return (
    <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" width="100%" marginBottom={1}>
        <text fg={theme().text}><b>{props.title}</b></text>
        <text fg={theme().textMuted} onMouseUp={() => props.onDone(undefined)}>esc</text>
      </box>
      <box flexDirection="row" gap={3} marginBottom={1}>
        <Show when={filtering()}>
          <text fg={theme().accent}>/ </text>
          <text fg={theme().text}>{query()}</text>
          <text fg={theme().textMuted}>{query() === "" ? "type to search - enter saves - esc clears" : "|"}</text>
        </Show>
        <Show when={!filtering()}>
          <Show when={query().trim() !== ""}>
            <text fg={theme().accent}>filter: {query()}</text>
            <text fg={theme().textMuted}>(esc clears, / edits)</text>
          </Show>
          <text fg={theme().textMuted}>enter select</text>
          <text fg={theme().textMuted}>up/down move</text>
          <text fg={theme().textMuted}>i help</text>
          <Show when={props.pin}>
            <text fg={theme().textMuted}>f pin</text>
          </Show>
          <text fg={theme().accent}>/ search</text>
        </Show>
      </box>
      <scrollbox maxHeight={listHeight()} ref={(element: ScrollBoxRenderable) => (scroll = element)}>
      <box flexDirection="column" gap={0}>
        <For each={visibleOptions()}>
          {(option, index) => {
            const active = createMemo(() => selected() === index())
            return (
              <Show
                when={!option.divider}
                fallback={
                  <box flexDirection="row" width="100%" paddingLeft={1} paddingRight={1}>
                    <text flexGrow={1} fg={theme().textMuted} wrapMode="none" overflow="hidden">{option.title}</text>
                  </box>
                }
              >
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
                  <text width={titleWidth()} flexShrink={0} fg={active() ? theme().background : option.danger ? theme().error : option.color ?? (option.edited ? theme().success : theme().text)} wrapMode="none" overflow="hidden"><b>{option.title}</b></text>
                  <text flexGrow={1} fg={active() ? theme().background : option.edited ? theme().success : theme().textMuted} wrapMode="none" overflow="hidden">{option.description ?? ""}</text>
                </box>
              </Show>
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

/** Optional in-dialog action button (rendered next to `ok`, red when danger). */
type DialogAction = { title: string; value: string; danger?: boolean; key?: string }

function showInfo(api: TuiPluginApi, props: { title: string; message: string; actions?: DialogAction[] }): Promise<string | undefined> {
  if (menuProbe) {
    menuProbe.onInfo?.(props.title, props.message)
    return Promise.resolve(undefined)
  }
  return new Promise((resolve) => {
    let settled = false
    const done = (action?: string) => {
      if (settled) return
      settled = true
      resolve(action)
      api.ui.dialog.clear()
    }
    api.ui.dialog.replace(
      () => <InfoDialog api={api} title={props.title} message={props.message} actions={props.actions} onDone={done} />,
      () => done(),
    )
  })
}

function dialogActionBindings(
  actions: DialogAction[] | undefined,
  prefix: string,
  onDone: (action?: string) => void,
): { commands: { name: string; title: string; run: (ctx: KeyContext) => void }[]; bindings: { key: string; cmd: string; desc: string }[] } {
  const commands: { name: string; title: string; run: (ctx: KeyContext) => void }[] = []
  const bindings: { key: string; cmd: string; desc: string }[] = []
  for (const [index, action] of (actions ?? []).entries()) {
    if (!action.key) continue
    const name = `${prefix}.action.${index}`
    commands.push({ name, title: action.title, run: (ctx: KeyContext) => { blockKey(ctx); onDone(action.value) } })
    bindings.push({ key: action.key, cmd: name, desc: action.title })
  }
  return { commands, bindings }
}

function DialogActionFooter(props: { actions: DialogAction[] | undefined; theme: () => { primary: RGBA; error: RGBA; accent: RGBA; background: RGBA; textMuted: RGBA }; onAction: (value: string) => void; onOk: () => void }) {
  return (
    <box flexDirection="row" justifyContent="space-between" width="100%">
      <box flexDirection="row" gap={1}>
        <For each={props.actions ?? []}>
          {(action) => (
            <Show when={action.key}>
              <text fg={action.danger ? props.theme().error : props.theme().accent}>{`${action.key}: ${action.title}`}</text>
            </Show>
          )}
        </For>
      </box>
      <box flexDirection="row" gap={1}>
        <For each={props.actions ?? []}>
          {(action) => (
            <box paddingLeft={2} paddingRight={2} backgroundColor={action.danger ? props.theme().error : props.theme().primary} onMouseUp={() => props.onAction(action.value)}>
              <text fg={props.theme().background}><b>{action.title}</b></text>
            </box>
          )}
        </For>
        <box paddingLeft={3} paddingRight={3} backgroundColor={props.theme().primary} onMouseUp={props.onOk}>
          <text fg={props.theme().background}><b>ok</b></text>
        </box>
      </box>
    </box>
  )
}

function InfoDialog(props: { api: TuiPluginApi; title: string; message: string; actions?: DialogAction[]; onDone: (action?: string) => void }) {
  const theme = () => props.api.theme.current
  useWizardDialogSize(props.api)
  useHidePromptCursor(props.api)
  const dimensions = useTerminalDimensions()
  const popMode = props.api.mode.push("config-studio.dialog")
  const lines = createMemo(() => props.message.split(/\r?\n/))
  const visualRows = createMemo(() => estimatedVisualRows(props.message, dialogContentWidth(props.api)))
  const bodyHeight = createMemo(() => cappedHeight(visualRows() + 1, wizardMaxRows(props.api, dimensions().height, 6, 4), 4))
  let scroll: ScrollBoxRenderable | undefined
  const page = () => Math.max(1, (scroll?.height ?? bodyHeight()) - 1)
  const commandPrefix = `config-studio.info.${Math.random().toString(36).slice(2)}`
  const actionKeys = dialogActionBindings(props.actions, commandPrefix, props.onDone)
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
      ...actionKeys.commands,
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
      ...actionKeys.bindings,
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
        <text fg={theme().textMuted} onMouseUp={() => props.onDone()}>esc</text>
      </box>
      <scrollbox maxHeight={bodyHeight()} ref={(element: ScrollBoxRenderable) => (scroll = element)}>
      <box flexDirection="column" gap={0}>
        {renderContentLines(lines(), theme)}
      </box>
      </scrollbox>
      <DialogActionFooter actions={props.actions} theme={theme} onAction={(value) => props.onDone(value)} onOk={() => props.onDone()} />
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

function showPagedInfo(api: TuiPluginApi, props: { title: string; sections: PagedSection[]; actions?: DialogAction[] }): Promise<string | undefined> {
  if (menuProbe) {
    menuProbe.onPaged?.(props.title, props.sections)
    return Promise.resolve(undefined)
  }
  return new Promise((resolve) => {
    let settled = false
    const done = (action?: string) => {
      if (settled) return
      settled = true
      resolve(action)
      api.ui.dialog.clear()
    }
    api.ui.dialog.replace(
      () => <PagedDialog api={api} title={props.title} sections={props.sections} actions={props.actions} onDone={done} />,
      () => done(),
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

function PagedDialog(props: { api: TuiPluginApi; title: string; sections: PagedSection[]; actions?: DialogAction[]; onDone: (action?: string) => void }) {
  const theme = () => props.api.theme.current
  useWizardDialogSize(props.api)
  useHidePromptCursor(props.api)
  const dimensions = useTerminalDimensions()
  const popMode = props.api.mode.push("config-studio.dialog")

  const height = createMemo(() => Math.max(6, wizardMaxRows(props.api, dimensions().height, 6, 6)))
  const sections = createMemo(() => (props.sections.length > 0 ? props.sections : [{ title: "", lines: ["(empty)"] }]))
  const jumpKeys = createMemo(() => sections().slice(0, 9).map((section, index) => ({ section, key: String(index + 1) })))

  let scroll: ScrollBoxRenderable | undefined
  const sectionRefs: (BoxRenderable | undefined)[] = []

  /** Exact content offset of a section header (measured, not estimated). */
  function sectionOffset(index: number): number | undefined {
    const box = sectionRefs[index]
    if (!scroll || !box || box.isDestroyed) return undefined
    try {
      return box.screenY - scroll.content.screenY
    } catch {
      return undefined
    }
  }

  const [current, setCurrent] = createSignal(0)

  function scrollToSection(index: number) {
    if (!scroll || scroll.isDestroyed) return
    const clamped = Math.max(0, Math.min(index, sections().length - 1))
    setCurrent(clamped)
    // Defer to the next frame so a freshly-changed signal has rendered.
    setTimeout(() => {
      if (!scroll || scroll.isDestroyed) return
      const offset = sectionOffset(clamped)
      if (offset !== undefined) scroll.scrollTop = offset
    }, 0)
  }

  // Track wheel/scrollbar scrolling: nearest section whose header is at or
  // above the scroll position wins. Polling keeps it decoupled from render.
  const trackTimer = setInterval(() => {
    if (!scroll || scroll.isDestroyed || scroll.scrollHeight <= scroll.height) return
    const top = scroll.scrollTop
    let best = 0
    for (let index = 0; index < sections().length; index++) {
      const offset = sectionOffset(index)
      if (offset !== undefined && offset <= top + 1) best = index
    }
    if (best !== current()) setCurrent(best)
  }, 250)
  ;(trackTimer as { unref?: () => void }).unref?.()
  onCleanup(() => clearInterval(trackTimer))

  const page = () => Math.max(1, (scroll?.height ?? height()) - 1)
  const commandPrefix = `config-studio.paged.${Math.random().toString(36).slice(2)}`
  const pagedActionKeys = dialogActionBindings(props.actions, commandPrefix, props.onDone)
  const unregister = props.api.keymap.registerLayer({
    priority: 10000,
    commands: [
      { name: `${commandPrefix}.close`, title: "Close", run: (ctx: KeyContext) => { blockKey(ctx); props.onDone() } },
      { name: `${commandPrefix}.next`, title: "Next section", run: (ctx: KeyContext) => { blockKey(ctx); scrollToSection(current() + 1) } },
      { name: `${commandPrefix}.prev`, title: "Previous section", run: (ctx: KeyContext) => { blockKey(ctx); scrollToSection(current() - 1) } },
      { name: `${commandPrefix}.up`, title: "Scroll up", run: (ctx: KeyContext) => { blockKey(ctx); scroll?.scrollBy(-1) } },
      { name: `${commandPrefix}.down`, title: "Scroll down", run: (ctx: KeyContext) => { blockKey(ctx); scroll?.scrollBy(1) } },
      { name: `${commandPrefix}.pageUp`, title: "Page up", run: (ctx: KeyContext) => { blockKey(ctx); scroll?.scrollBy(-page()) } },
      { name: `${commandPrefix}.pageDown`, title: "Page down", run: (ctx: KeyContext) => { blockKey(ctx); scroll?.scrollBy(page()) } },
      { name: `${commandPrefix}.home`, title: "Scroll top", run: (ctx: KeyContext) => { blockKey(ctx); if (scroll) scroll.scrollTop = 0 } },
      { name: `${commandPrefix}.end`, title: "Scroll bottom", run: (ctx: KeyContext) => { blockKey(ctx); if (scroll) scroll.scrollTop = scroll.scrollHeight } },
      ...jumpKeys().map(({ key }) => ({
        name: `${commandPrefix}.jump${key}`,
        title: "Jump to section",
        run: (ctx: KeyContext) => {
          blockKey(ctx)
          scrollToSection(Number(key) - 1)
        },
      })),
      { name: `${commandPrefix}.shield`, title: "Block background input", run: blockKey },
      ...pagedActionKeys.commands,
    ],
    bindings: [
      { key: "enter", cmd: `${commandPrefix}.close`, desc: "Close" },
      { key: "escape", cmd: `${commandPrefix}.close`, desc: "Close" },
      { key: "n", cmd: `${commandPrefix}.next`, desc: "Next section" },
      { key: "p", cmd: `${commandPrefix}.prev`, desc: "Previous section" },
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
      ...jumpKeys().map(({ key }) => ({ key, cmd: `${commandPrefix}.jump${key}`, desc: "Jump to section" })),
      ...pagedActionKeys.bindings,
      ...shieldBindings(`${commandPrefix}.shield`, ["home", "end"]),
    ],
  })
  onCleanup(() => {
    unregister()
    popMode()
  })

  const footerHint = createMemo(() => {
    const actionHints = (props.actions ?? [])
      .filter((action) => action.key)
      .map((action) => `${action.key}=${truncate(action.title, 20)}`)
    const base = sections().length <= 1 ? "up/down scroll" : [`p < ${current() + 1}/${sections().length} > n`, jumpKeys().map(({ key, section }) => `${key}=${truncate(section.title, 12)}`).join("  ")].filter(Boolean).join("   ")
    return [base, ...actionHints].filter(Boolean).join("   ")
  })

  return (
    <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" width="100%" marginBottom={1}>
        <text fg={isRestartRequired(props.title) ? theme().error : theme().accent}><b>{props.title}</b></text>
        <text fg={theme().textMuted} onMouseUp={() => props.onDone()}>esc</text>
      </box>
      <scrollbox maxHeight={height()} ref={(element: ScrollBoxRenderable) => (scroll = element)}>
        <box flexDirection="column" gap={0}>
          <For each={sections()}>
            {(section, index) => (
              <box
                flexDirection="column"
                gap={0}
                paddingTop={index() > 0 ? 1 : 0}
                ref={(element: BoxRenderable) => (sectionRefs[index()] = element)}
              >
                <Show when={section.title.length > 0}>
                  <text fg={theme().accent}><b>{`── ${section.title} ${"─".repeat(Math.max(0, Math.min(40, 40 - section.title.length)))}`}</b></text>
                </Show>
                {renderContentLines(section.lines, theme)}
              </box>
            )}
          </For>
        </box>
      </scrollbox>
      <box flexDirection="row" justifyContent="space-between" width="100%" marginTop={1}>
        <text fg={theme().textMuted}>{footerHint()}</text>
        <box flexDirection="row" gap={1}>
          <For each={props.actions ?? []}>
            {(action) => (
              <box paddingLeft={2} paddingRight={2} backgroundColor={action.danger ? theme().error : theme().primary} onMouseUp={() => props.onDone(action.value)}>
                <text fg={theme().background}><b>{action.title}</b></text>
              </box>
            )}
          </For>
          <box paddingLeft={3} paddingRight={3} backgroundColor={theme().primary} onMouseUp={() => props.onDone()}>
            <text fg={theme().background}><b>ok</b></text>
          </box>
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

/** Client-call timeout: startup-adjacent SDK calls must never hang the studio (3s, agent-variants pattern). */
const CLIENT_CALL_TIMEOUT_MS = 3000

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms)
        ;(timer as { unref?: () => void }).unref?.()
      }),
    ])
  } catch {
    return undefined
  } finally {
    if (timer) clearTimeout(timer)
  }
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
      const result = unwrap(await withTimeout(client.provider.list(), CLIENT_CALL_TIMEOUT_MS))
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
      const result = unwrap(await withTimeout(client.config.providers(), CLIENT_CALL_TIMEOUT_MS))
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
  // tui.json layers: own discovery + staged overlay (never in the opencode merge).
  const tuiFiles = discoverTuiFiles({ globalConfigDir, envConfigFile, envTuiFile: process.env["OPENCODE_TUI_CONFIG"], directory: api.state.path.directory, worktree: api.state.path.worktree })
  for (const change of pending) {
    const file = tuiFiles.find((item) => item.path === change.targetPath)
    if (file) file.data = applyOpsToData(file.data, change.ops)
  }
  // Staged overlay: pending ops are reflected in parsed file data so every
  // view (provenance, browsers, detail screens) renders the post-save world.
  for (const change of pending) {
    const file = files.find((item) => item.path === change.targetPath)
    if (!file) continue
    file.data = applyOpsToData(file.data, change.ops)
  }
  const merge = mergeWithProvenance(files)
  // Provider catalog cache: identical merged config => reuse the catalog
  // instead of round-tripping client.provider.list() on every open. Saves
  // change file content => new hash => immediate refetch.
  const cacheKey = providerCacheKey(merge)
  // 8s interactive cap: a slow/blocked models.dev fetch must not stall the
  // studio open (stale disk cache still serves as fallback on failure).
  const modelsDevPromise = fetchModelsDev(studioDataDir(api), 8000)
  let providerResult: { providers: RuntimeProviderLike[]; defaults: Record<string, string>; source: StudioState["providersSource"] }
  const cached = getCachedProviders<RuntimeProviderLike>(cacheKey)
  if (cached) {
    providerResult = cached
  } else {
    providerResult = await fetchProviders(api)
    setCachedProviders(cacheKey, providerResult)
  }
  const modelsDevResult = await modelsDevPromise
  const markdownAgents = discoverMarkdownAgents({ globalConfigDir, envConfigFile, directory: api.state.path.directory, worktree: api.state.path.worktree })
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
    tuiFiles,
    tuiTargetFilePath: previous?.tuiTargetFilePath && tuiFiles.some((file) => file.path === previous.tuiTargetFilePath) ? previous.tuiTargetFilePath : undefined,
    markdownAgents,
  }
}

async function reloadOpenCode(api: TuiPluginApi): Promise<boolean> {
  // Superseded by the deferred reload coordinator (src/reload.ts); kept as a
  // thin alias for any external callers.
  return reloadNow(api)
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
  options.push({ title: "< Back", value: "__back__", description: "cancel this edit" })
  const current = write.state.targetFilePath ?? strongest?.path ?? editable[editable.length - 1]?.path
  const picked = await showMenu(write.api, {
    title: `Edit which file? - ${suggestedLabel}`,
    options,
    current,
  })
  if (!picked || picked === "__back__") return undefined
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
/** Content of each staged file when its FIRST op was queued (outside-change guard). */
const stagedBases = new Map<string, string>()

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
  if (!stagedBases.has(target)) {
    try {
      stagedBases.set(target, existsSync(target) ? readFileSync(target, "utf8") : "")
    } catch {
      stagedBases.set(target, "")
    }
  }
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
    stagedBases.delete(targetPath)
    saved++
  }
  state.pending = []
  return { saved }
}

/**
 * Save-time outside-change guard: re-reads each staged target file and warns
 * when it changed on disk after staging (another editor, another tool).
 */
async function confirmOutsideChanges(api: TuiPluginApi, state: StudioState): Promise<boolean> {
  const relevant = new Map<string, string>()
  for (const [path, base] of stagedBases) {
    if (state.pending.some((change) => change.targetPath === path)) relevant.set(path, base)
  }
  if (relevant.size === 0) return true
  const changes: OutsideChange[] = detectOutsideChanges(relevant, (path) => {
    try {
      return existsSync(path) ? readFileSync(path, "utf8") : undefined
    } catch {
      return undefined
    }
  })
  if (changes.length === 0) return true
  const sections = changes.map((change) => ({
    title: change.path,
    lines: change.diffLines,
  }))
  const proceed = await showConfirm(api.ui, {
    title: "Outside changes detected",
    message: [
      "Some staged files changed on disk after you staged the edits:",
      ...changes.map((change) => `  - ${change.path}`),
      "",
      "Staged edits are applied to the CURRENT disk content, so they may land differently than the diff preview suggested.",
      "Review the outside changes, then decide.",
    ].join("\n"),
    confirmLabel: "Save anyway",
  })
  if (!proceed) return false
  await showPagedInfo(api, { title: "Outside changes (disk vs staged base)", sections })
  const really = await showConfirm(api.ui, {
    title: "Save with outside changes?",
    message: "The staged edits will be applied on top of the outside changes shown above.",
    confirmLabel: "Save anyway",
  })
  return really
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
    if (doc.source) lines.push("", doc.source)
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

/** Quick access: fixed defaults (browse, agents) + pinned deep screens (Menu-2+). */

/** Runs a quick-access entry; deep ids (settings:Group[:key]) drill straight in. */
async function runQuickAccess(api: TuiPluginApi, state: StudioState, id: string): Promise<void> {
  if (id === "browse") return providerBrowser(api, state)
  if (id === "agents") return agentsScreen(api, state)
  if (id.startsWith("settings:")) {
    const rest = id.slice("settings:".length)
    const group = rest.includes(":") ? rest.slice(0, rest.indexOf(":")) : rest
    const key = rest.includes(":") ? rest.slice(rest.indexOf(":") + 1) : undefined
    const kit = makeEditorKit(api, state)
    if (key !== undefined) {
      await kitDrillSettings(kit, group, key)
    } else {
      await kitDrillSettingsGroup(kit, group)
    }
    return mainMenu(api, state)
  }
  return mainMenu(api, state)
}

/** Toggles a deep-screen pin; persists to settings.jsonc. */
function toggleQuickAccess(api: TuiPluginApi, id: string): void {
  const dataDir = studioDataDir(api)
  const list = studioSettings.quickAccess.filter((item) => item !== id)
  const pinned = list.length === studioSettings.quickAccess.length
  if (pinned) list.push(id)
  studioSettings.quickAccess = list
  saveSettings(dataDir, studioSettings)
  api.ui.toast({ variant: "info", title: pinned ? "Pinned to Quick access" : "Unpinned from Quick access", message: screenTitle(id) })
}

/** Menu pin-prop factory: only Menu-2+ screens are pinnable. */
function pinPropsFor(id: string): { id: string; onToggle: () => void } | undefined {
  if (!PINNABLE_SCREENS.some((screen) => screen.id === id)) return undefined
  const api = currentApi()
  if (!api) return undefined
  return { id, onToggle: () => toggleQuickAccess(api, id) }
}

async function mainMenu(api: TuiPluginApi, state: StudioState): Promise<void> {
  await checkStandaloneDuplicates(api)
  const editedProviders = analyzeProviders(state.providers, state.defaults, state.merge).filter((provider) => provider.edited).length
  const modules = enabledModuleList()
  const modulePending = modules.some((module) => module.hasPendingChanges(moduleContext(api, state)))
  const pendingCount = state.pending.length + (modulePending ? 1 : 0)

  // Quick access: fixed defaults (the hoisted main-menu staples) + pinned
  // deep screens. Links, not copies - each entry runs the same handler the
  // original menu row would.
  const opts: WizardSelectOption<string>[] = [
    {
      title: "Providers & models",
      value: "quick:browse",
      description: `${state.providers.length} provider(s), ${editedProviders} edited`,
      help: "Open the model browser. Providers and models edited in any config file are listed first and highlighted.",
    },
    {
      title: "Agents",
      value: "quick:agents",
      description: "Agent model, variant, temperature, top_p",
      help: docText("root.agent"),
    },
  ]
  for (const id of studioSettings.quickAccess) {
    if (!PINNABLE_SCREENS.some((screen) => screen.id === id)) continue
    opts.push({
      title: ` ${screenTitle(id)}`,
      value: `quick:${id}`,
      description: "pinned",
      help: `Jump straight to ${screenTitle(id)}. (Pinned - press f on that screen's menu to unpin; f on any deep screen's menu to pin it.)`,
    })
  }
  opts.push({ title: "─".repeat(60), value: "__qa_divider__", description: "", divider: true })
  const pendingReloadState = pendingReload()
  if (pendingReloadState) {
    opts.push({
      title: `● Config reload pending - ${pendingReloadState.active} session(s) running`,
      value: "__reload_pending__",
      description: "saved config applies when sessions finish",
      help: "A config save deferred its reload because session(s) are still running. It applies automatically once they finish; you can also force it now (with a warning) or cancel the auto-reload.",
    })
  }
  opts.push(
    {
      title: "Settings",
      value: "settings",
      description: "All root config keys by group",
      help: "Every opencode.json root key - sharing, updates, provider toggles, instructions, skills, references, MCP, commands, permissions, attachments, compaction, server, experimental flags, and deprecated keys.",
    },
    {
      title: "TUI settings",
      value: "tui-settings",
      description: "tui.json - theme, keybinds, cursor, sounds",
      help: "Everything editable in tui.json: theme, keybind browser (184 commands), diff style, cursor, mouse, scroll, attention sounds, prompt sizing, plugin enable toggles. TUI changes always need a restart.",
    },
    {
      title: "Plugins",
      value: "plugins",
      description: "Manage plugin entries in both config families",
      help: "Add/remove plugins (npm specs or file:// paths, with optional options tuples) across opencode.json and tui.json layers. Restart required after changes.",
    },
    {
      title: "Cleanup & migrations",
      value: "cleanup",
      description: "Deprecated keys: detect and migrate",
      help: "Scans every config file for deprecated or dead keys (mode, tools, autoshare, reference, layout, logLevel, agent tools/maxSteps, misplaced tui keys) and stages migrations to their modern equivalents.",
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
  )
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
  if (action?.startsWith("quick:")) {
    return runQuickAccess(api, state, action.slice("quick:".length))
  }
  if (action?.startsWith("module:")) {
    const module = modules.find((item) => item.id === action.slice("module:".length))
    const entry = module && moduleUsesOwnMenu(studioSettings, module) ? module.mainMenuEntry?.(moduleContext(api, state)) : undefined
    if (entry) await entry.run(moduleContext(api, state))
    return mainMenu(api, state)
  }
  switch (action) {
    case "__reload_pending__":
      return reloadPendingMenu(api, state)
    case "browse":
      return providerBrowser(api, state)
    case "settings":
      await kitSettingsScreen(makeEditorKit(api, state))
      return mainMenu(api, state)
    case "tui-settings":
      return tuiSettingsScreen(api, state)
    case "plugins":
      return pluginManagerScreen(api, state)
    case "cleanup":
      return cleanupScreen(api, state)
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
    stagedBases.clear()
    configRestartReasons.length = 0
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
        ...(module.id === "agent-variants" ? [{ title: "Source & channel", value: "source", description: `${moduleOption<"embedded" | "standalone">(studioSettings, "agent-variants", "source", "embedded")} - ${avOrigin()}`, help: "Use the standalone agent-variants install (any channel) or the studio's bundled copy, and pin the standalone channel (@latest/@dev/exact)." } satisfies WizardSelectOption<string>] : []),
        { title: "< Back", value: "__back__", description: "Return to modules" },
      ],
    })
    if (!choice || choice === "__back__") return modulesScreen(api, state)
    if (choice === "source") return agentVariantsSourceScreen(api, state)
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

/** Strongest editable file (last in precedence order) for new entries. */
function strongestEditableFile(state: StudioState): { path: string; data: Record<string, unknown> } | undefined {
  const editable = editableFiles(state.files)
  return editable.length > 0 ? editable[editable.length - 1] : undefined
}

/** Plugin specs from every discovered file's plugin array (deduped, in order). */
function allPluginSpecs(state: StudioState): string[] {
  const specs: string[] = []
  for (const file of state.files) {
    const plugin = getAtPath(file.data, ["plugin"])
    if (!Array.isArray(plugin)) continue
    for (const entry of plugin) {
      const spec = Array.isArray(entry) ? String(entry[0]) : String(entry)
      if (spec && !specs.includes(spec)) specs.push(spec)
    }
  }
  return specs
}

/** Re-resolves the AV implementation (embedded vs standalone) per command run. */
async function refreshAgentVariantsSource(api: TuiPluginApi, state: StudioState): Promise<void> {
  const source = moduleOption<"embedded" | "standalone">(studioSettings, "agent-variants", "source", "embedded")
  const result = await refreshAvSource(source, allPluginSpecs(state))
  if (!result.ok) {
    api.ui.toast({ variant: "warning", title: "Agent Variants source", message: result.error ?? "Falling back to the embedded copy." })
  }
}

/** Standalone agent-variants entries across files, with file + array index. */
function standalonePluginEntries(state: StudioState): Array<{ file: string; index: number; spec: string; tuple: boolean }> {
  const hits: Array<{ file: string; index: number; spec: string; tuple: boolean }> = []
  for (const file of state.files) {
    const plugin = getAtPath(file.data, ["plugin"])
    if (!Array.isArray(plugin)) continue
    plugin.forEach((entry, index) => {
      const tuple = Array.isArray(entry)
      const spec = String(tuple ? entry[0] : entry)
      if (spec.includes("opencode-agent-variants") && !spec.includes("opencode-config-studio")) hits.push({ file: file.path, index, spec, tuple })
    })
  }
  return hits
}

function avChannelOf(spec: string): string {
  const at = spec.indexOf("@", 1)
  return at === -1 ? "latest" : spec.slice(at + 1)
}

/**
 * Agent Variants source + channel picker: embedded vs standalone, and (when
 * standalone) which pinned channel the standalone spec uses. Channel changes
 * stage a plugin-array edit through the normal review/save pipeline.
 */
async function agentVariantsSourceScreen(api: TuiPluginApi, state: StudioState): Promise<void> {
  const dataDir = studioDataDir(api)
  while (true) {
    const source = moduleOption<"embedded" | "standalone">(studioSettings, "agent-variants", "source", "embedded")
    const hits = standalonePluginEntries(state)
    const channelOptions: WizardSelectOption<string>[] = [
      {
        title: source === "standalone" ? "* Use standalone install" : "Use standalone install",
        value: "standalone",
        description: hits.length > 0 ? hits.map((hit) => `${hit.spec} (${fileLabel(state, hit.file)})`).join(", ") : "no standalone entry found yet",
        help: "Loads the wizard from your standalone agent-variants plugin install instead of the studio's bundled copy - the studio then drives exactly the version you pinned. Requires a standalone plugin entry (added below or by installing the plugin).",
      },
      {
        title: source === "embedded" ? "* Use embedded copy" : "Use embedded copy",
        value: "embedded",
        description: avOrigin(),
        help: "Uses the agent-variants version bundled with this studio build (declared in package.json). Always available.",
      },
      { title: "Set standalone channel/version", value: "channel", description: hits.length > 0 ? `current: ${hits.map((hit) => avChannelOf(hit.spec)).join(", ")}` : "no standalone entry yet", help: "Pins the standalone plugin spec to @latest, @dev, or an exact version (e.g. 0.9.0-dev.1). Stages a plugin-array edit; takes effect after Save & exit + restart." },
      { title: "Add standalone plugin entry", value: "add", description: "adds @mirrowel/opencode-agent-variants@dev", help: "Adds the standalone plugin to the strongest config file's plugin array so its channel can be managed here. Staged like any other edit." },
      { title: "< Back", value: "__back__", description: "" },
    ]
    const picked = await showMenu(api, { title: "Agent Variants source", options: channelOptions })
    if (!picked || picked === "__back__") return modulesScreen(api, state)
    if (picked === "standalone" || picked === "embedded") {
      setModuleOption(dataDir, studioSettings, "agent-variants", "source", picked)
      await refreshAgentVariantsSource(api, state)
      api.ui.toast({
        variant: "info",
        title: "Agent Variants source",
        message: picked === "standalone" ? `Now using the standalone install (${avOrigin()}).` : "Now using the embedded copy.",
      })
      continue
    }
    if (picked === "channel") {
      if (hits.length === 0) {
        await showAlert(api.ui, { title: "No standalone entry", message: "Add the standalone plugin entry first (option below), then pick its channel." })
        continue
      }
      const target = hits.length === 1 ? hits[0]! : await showMenu(api, {
        title: "Which entry?",
        options: [...hits.map((hit) => ({ title: hit.spec, value: String(hit.index), description: fileLabel(state, hit.file) })), { title: "< Cancel", value: "__cancel__", description: "" }],
      })
      if (!target || target === "__cancel__") continue
      const hit = typeof target === "object" ? target : hits.find((item) => String(item.index) === target)
      if (!hit) continue
      const channel = await showMenu(api, {
        title: `Channel for ${hit.spec}`,
        options: [
          { title: "latest (stable)", value: "latest", description: avChannelOf(hit.spec) === "latest" ? "current" : "" },
          { title: "dev (prerelease)", value: "dev", description: avChannelOf(hit.spec) === "dev" ? "current" : "" },
          { title: "Exact version...", value: "__exact__", description: "type e.g. 0.9.0-dev.1" },
          { title: "< Cancel", value: "__cancel__", description: "" },
        ],
      })
      if (!channel || channel === "__cancel__") continue
      const nextChannel = channel === "__exact__" ? (await showPrompt(api.ui, { title: "Exact version", placeholder: "e.g. 0.9.0-dev.1" }))?.trim() : channel
      if (!nextChannel) continue
      const newSpec = `@mirrowel/opencode-agent-variants@${nextChannel}`
      if (newSpec === hit.spec) continue
      const write: WriteContext = { api, state }
      const path: JSONPath = hit.tuple ? ["plugin", hit.index, 0] : ["plugin", hit.index]
      const ok = await applyEdits(write, [{ op: "set", path, value: newSpec }], `agent-variants standalone channel -> @${nextChannel}`)
      if (ok) {
        api.ui.toast({ variant: "info", title: "Channel staged", message: `${newSpec} - review and Save & exit, then restart OpenCode to install the new version.` })
        return modulesScreen(api, state)
      }
      continue
    }
    if (picked === "add") {
      const write: WriteContext = { api, state }
      const target = strongestEditableFile(state)
      if (!target) {
        await showAlert(api.ui, { title: "No editable file", message: "No editable config file was discovered." })
        continue
      }
      const pluginArray = getAtPath(target.data, ["plugin"])
      const ok = await applyEdits(write, [{ op: "set", path: pluginArray ? ["plugin", Array.isArray(pluginArray) ? pluginArray.length : 0] : ["plugin", 0], value: "@mirrowel/opencode-agent-variants@dev" }], "add agent-variants standalone entry")
      if (ok) {
        setModuleOption(dataDir, studioSettings, "agent-variants", "source", "standalone")
        api.ui.toast({ variant: "info", title: "Standalone entry staged", message: `@mirrowel/opencode-agent-variants@dev added to ${fileLabel(state, target.path)} - Save & exit, then restart OpenCode.` })
        return modulesScreen(api, state)
      }
      continue
    }
  }
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
  return { capture: { hiddenSections: [...DEFAULT_HIDDEN_SECTIONS] }, modules: { enabled: {}, options: {} }, quickAccess: [] }
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
    stageConfigEdits: async (ops, reason) => applyEdits({ api, state }, ops, reason),
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
  // Standalone-source mode: the standalone install is intentional - it does
  // the routing and feeds the studio its wizard. Nothing to clean up.
  if (moduleOption<"embedded" | "standalone">(studioSettings, "agent-variants", "source", "embedded") === "standalone") return
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
  const choice = await showMenu(api, {
    title: "Standalone Agent Variants detected",
    options: [
      { title: "Remove standalone", value: "remove", description: "embedded module takes over after restart", help: "Removes the standalone registration(s) from the config files. Until you restart, the studio's embedded router stays dormant and the standalone plugin keeps handling routing." },
      { title: "Keep standalone, use it in the studio", value: "use", description: "standalone plugin routes + feeds the studio its wizard", help: "Sets the Agent Variants module source to the standalone install: the standalone plugin keeps handling routing, and the studio loads the wizard from its exact version (any channel you pin). No duplicate routing." },
      { title: "Decide later", value: "later", description: "keep both; embedded router stays dormant", help: "Nothing changes now. The duplicate dialog returns at the next startup." },
    ],
  })
  if (choice === "use") {
    setModuleOption(studioDataDir(api), studioSettings, "agent-variants", "source", "standalone")
    await showInfo(api, {
      title: "Standalone source enabled",
      message: [
        "Agent Variants module now uses your standalone install.",
        "",
        "The standalone plugin keeps handling routing; the studio loads its wizard",
        "from the pinned version (manage the channel under Modules > Agent",
        "Variants > Source & channel).",
      ].join("\n"),
    })
    return
  }
  if (choice !== "remove") return
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
    stagedBases.clear()
    configRestartReasons.length = 0
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
    for (const [path] of stagedBases) {
      if (!state.pending.some((item) => item.targetPath === path)) stagedBases.delete(path)
    }
    const updated = await refreshStudio(api, state)
    Object.assign(state, updated)
    api.ui.toast({ variant: "info", title: "Staged change discarded", message: change.reason })
    return reviewChangesScreen(api, state)
  }
  return reviewChangesScreen(api, state)
}

function describeRunningSessions(running: RunningSession[]): string[] {
  const lines = running.slice(0, 8).map((session) => {
    const label = session.title?.trim() || session.agent || session.id
    const parts = [session.parentID ? `${label} [child session]` : label]
    if (session.agent) parts.push(session.agent)
    if (session.model) parts.push(session.model)
    if (session.directory) parts.push(session.directory.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? session.directory)
    return `  • ${parts.join(" - ")}`
  })
  if (running.length > 8) lines.push(`  … and ${running.length - 8} more`)
  return lines
}

/** Force-reload confirmation: shows what is still running, then reloads on confirm. */
async function confirmForceReload(api: TuiPluginApi): Promise<boolean> {
  const running = await fetchRunningSessions(api)
  const message = [
    running === undefined
      ? "Could not verify running sessions."
      : running.length === 0
        ? "No running sessions detected - reloading is safe."
        : [`These session(s) are still running:`, ...describeRunningSessions(running), "", "Reloading interrupts their in-progress work."].join("\n"),
    "",
    "Reload OpenCode config now?",
  ].join("\n")
  return showConfirm(api.ui, { title: "Reload config now?", message, confirmLabel: "Reload now" })
}

/** Main-menu entry for a deferred reload: force (with warning) or cancel the auto-reload. */
async function reloadPendingMenu(api: TuiPluginApi, state: StudioState): Promise<void> {
  const running = await fetchRunningSessions(api)
  const count = running?.length ?? pendingReload()?.active ?? 0
  const detailRows: WizardSelectOption<string>[] = []
  if (running && running.length > 0) {
    detailRows.push({ title: `─ ${count} session(s) running ${"─".repeat(30)}`, value: "__detail_head__", description: "", divider: true })
    for (const line of describeRunningSessions(running)) detailRows.push({ title: line.trim(), value: `__detail_${detailRows.length}`, description: "", divider: true })
  } else if (running !== undefined) {
    detailRows.push({ title: `─ no running sessions detected ${"─".repeat(26)}`, value: "__detail_head__", description: "", divider: true })
  } else {
    detailRows.push({ title: `─ could not verify running sessions ${"─".repeat(22)}`, value: "__detail_head__", description: "", divider: true })
  }
  const picked = await showMenu(api, {
    title: "Config reload pending",
    options: [
      ...detailRows,
      { title: `Reload NOW - interrupts ${count} running session(s)`, value: "force", description: "red button - stops in-progress work", danger: true, help: "Forces the deferred config reload immediately. Running sessions are interrupted." },
      { title: "Cancel auto-reload", value: "cancel", description: "keep the saved config on disk, never apply it automatically", help: "Drops the pending reload. The saved files stay on disk but are NOT applied until the next manual reload or OpenCode restart." },
      { title: "< Back", value: "__back__", description: "keep waiting" },
    ],
  })
  if (picked === "force") {
    if (await confirmForceReload(api)) {
      const ok = await reloadNow(api)
      api.ui.toast({ variant: ok ? "success" : "warning", title: ok ? "Config reloaded" : "Reload failed", message: ok ? "OpenCode config disposed and rebuilt." : "Config reload failed - the watcher keeps retrying." })
    }
    return mainMenu(api, state)
  }
  if (picked === "cancel") {
    cancelPendingReload()
    api.ui.toast({ variant: "info", title: "Auto-reload cancelled", message: "Saved config stays on disk until the next reload or restart." })
  }
  return mainMenu(api, state)
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
  const noOutsideConflicts = await confirmOutsideChanges(api, state)
  if (!noOutsideConflicts) return mainMenu(api, state)
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
  const restartReasons: string[] = [...configRestartReasons]
  for (const { module } of moduleSummaries) {
    try {
      const moduleResult = await module.save?.(moduleContext(api, state))
      restartReasons.push(...(moduleResult?.restartReasons ?? []))
    } catch (error) {
      restartReasons.push(`${module.title}: save failed - ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  configRestartReasons.length = 0
  const uniqueReasons = [...new Set(restartReasons)]
  const activeNow = await fetchActiveSessions(api)
  const deferred = activeNow === undefined || activeNow.length > 0
  const deferredCount = activeNow?.length ?? 0
  const runningSessions = deferred ? await fetchRunningSessions(api) : undefined
  const sessionLines =
    runningSessions === undefined
      ? []
      : runningSessions.length === 0
        ? []
        : ["Running sessions:", ...describeRunningSessions(runningSessions)]
  const reloadLine = deferred
    ? `Config reload DEFERRED - ${activeNow === undefined ? "could not verify" : `${deferredCount} session(s) running`}. It applies automatically once they finish; press r below to apply now.`
    : "OpenCode config reloads now; running sessions keep their previous settings."
  api.ui.toast({ variant: uniqueReasons.length > 0 ? "warning" : "success", title: "Config saved", message: uniqueReasons.length > 0 ? "Restart OpenCode to apply task-list/UI changes." : deferred ? "Reload deferred until sessions finish." : "All changes written." })
  // Summary dialog BEFORE the config reload: dispose reloads plugins and
  // would tear this dialog down mid-display otherwise. The deferred case
  // carries the red in-dialog Reload NOW action (r key or click) instead of a
  // follow-up menu.
  const reloadAction: DialogAction[] | undefined = deferred
    ? [{ title: `Reload NOW (${deferredCount === 0 ? "unverified" : `${deferredCount} session(s)`})`, value: "reload-now", danger: true, key: "r" }]
    : undefined
  const dialogAction: string | undefined = uniqueReasons.length > 0
    ? await showPagedInfo(api, {
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
              reloadLine,
              ...sessionLines,
            ],
          },
        ],
        actions: reloadAction,
      })
    : await showInfo(api, {
        title: "Saved",
        message: [
          `Wrote staged changes to ${result.saved} file(s) plus ${moduleSummaries.length} module change(s).`,
          "",
          reloadLine,
          ...sessionLines,
          "Restart OpenCode if anything looks stale.",
        ].join("\n"),
        actions: reloadAction,
      })
  if (dialogAction === "reload-now") {
    if (await confirmForceReload(api)) {
      const ok = await reloadNow(api)
      api.ui.toast({ variant: ok ? "success" : "warning", title: ok ? "Config reloaded" : "Reload failed", message: ok ? "OpenCode config disposed and rebuilt." : "Config reload failed - the watcher keeps retrying." })
      return
    }
  }
  await requestReload(api)
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
  const kit = makeEditorKit(api, state)
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
  options.push({ title: "! New custom provider...", value: "__new_provider__", description: "api base, SDK package, connection options, models", help: "Define a provider.<id> config entry from scratch: API family, npm SDK, baseURL/apiKey, model entries with limits and modalities." })
  options.push({ title: "< Back", value: "__back__", description: "Return to main menu" })

  const picked = await showMenu(api, { title: "Providers - edited first", options })
  if (!picked || picked === "__back__") return mainMenu(api, state)
  if (picked === "__new_provider__") {
    const id = await showPrompt(api.ui, { title: "Provider id", placeholder: "e.g. my-gateway (lowercase, no slashes)" })
    if (id === undefined || id.trim() === "") return providerBrowser(api, state)
    if (getAtPath(state.merge.merged, ["provider", id.trim()]) !== undefined) {
      await showAlert(api.ui, { title: "Exists", message: `Provider "${id.trim()}" already has a config entry.` })
      return providerBrowser(api, state)
    }
    const ok = await applyEdits({ api, state }, [{ op: "set", path: ["provider", id.trim()], value: {} }], `provider add ${id.trim()}`)
    if (ok) await providerEntryScreen(kit, id.trim())
    return providerBrowser(api, state)
  }
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
  options.push({ title: "! Provider settings...", value: "__provider_settings__", description: "api base, SDK package, options, env, filters", help: "Full provider entry editor (provider.<id> in config): API family, npm SDK, connection options incl. baseURL/apiKey/timeouts, model whitelist/blacklist, and raw model entries.", danger: false })
  options.push({ title: "+ Model entries (config)...", value: "__model_entries__", description: "custom models and overrides", help: "Manage provider.<id>.models entries directly: add custom models, edit limits, cost, modalities, status, default options." })
  options.push({ title: "< Back", value: "__back__", description: "Return to provider list" })

  const picked = await showMenu(api, { title: `Models - ${providerID}`, options })
  if (!picked || picked === "__back__") return providerBrowser(api, state)
  if (picked === "__provider_settings__") {
    await providerEntryScreen(makeEditorKit(api, state), providerID)
    return modelBrowser(api, state, providerID)
  }
  if (picked === "__model_entries__") {
    await providerModelsScreen(makeEditorKit(api, state), providerID)
    return modelBrowser(api, state, providerID)
  }
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

async function agentsScreen(api: TuiPluginApi, state: StudioState, returnTo?: () => Promise<void>): Promise<void> {
  const agentConfig = safeStateConfig(api)["agent"]
  const agents = new Map<string, Record<string, unknown>>()
  for (const name of ["build", "plan", "general"]) agents.set(name, {})
  if (agentConfig && typeof agentConfig === "object") {
    for (const [name, entry] of Object.entries(agentConfig as Record<string, unknown>)) {
      agents.set(name, entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {})
    }
  }
  for (const markdownAgent of state.markdownAgents) {
    if (!agents.has(markdownAgent.name)) agents.set(markdownAgent.name, { __markdown: markdownAgent.path })
  }
  // Agent Variants injects task-tool clones of parent agents (variant aliases)
  // into the runtime config this screen reads from. They are not real config
  // agents: editing one here would materialize a real agent.<name> entry and
  // fork the variant's single source of truth. Silently drop them (they are
  // copies of the base agent by design, managed in the Agent Variants module);
  // a name that ALSO exists in a discovered config file stays visible.
  // Exploring a read-only view of them here could be worthwhile someday.
  const hiddenAliases = agentVariantsHiddenAliases()
  if (hiddenAliases.size > 0) {
    for (const name of [...agents.keys()]) {
      if (!hiddenAliases.has(name)) continue
      const definedInFile = state.files.some((file) => {
        const agentTree = (file.data as Record<string, unknown> | undefined)?.["agent"]
        return !!agentTree && typeof agentTree === "object" && (agentTree as Record<string, unknown>)[name] !== undefined
      })
      if (!definedInFile) agents.delete(name)
    }
  }
  const options: WizardSelectOption<string>[] = [...agents.entries()].map(([name, entry]) => {
    const hasEdits = state.files.some((file) => fileAgentEdits(file).some((agent) => agent.agentID === name))
    const markdown = state.markdownAgents.find((agent) => agent.name === name)
    const markdownWins = markdown !== undefined && entry["__markdown"] !== undefined
    return {
      title: markdown ? `${name} [md]` : name,
      value: name,
      description: [
        markdownWins ? "markdown-defined agent" : undefined,
        typeof entry["model"] === "string" ? entry["model"] : "session model",
        typeof entry["variant"] === "string" ? `variant ${entry["variant"]}` : "default variant",
        entry["temperature"] !== undefined ? `temp ${entry["temperature"]}` : undefined,
        entry["top_p"] !== undefined ? `top_p ${entry["top_p"]}` : undefined,
      ].filter(Boolean).join(" - "),
      edited: hasEdits,
      help: [
        agentHelpText(state, name, entry["__markdown"] === undefined ? entry : {}),
        markdown ? `\nMarkdown agent: ${markdown.path}\nMarkdown agents override same-name config entries - edit the file there.` : undefined,
      ].filter(Boolean).join("\n"),
    }
  })
  for (const module of enabledModuleList()) {
    if (moduleUsesOwnMenu(studioSettings, module)) continue
    for (const entry of module.agentsScreenEntries?.(moduleContext(api, state)) ?? []) {
      options.push({ title: entry.title, value: `module-agents:${module.id}:${entry.title}`, description: entry.description, help: entry.help, edited: entry.edited })
    }
  }
  options.push({ title: "+ New agent...", value: "__new_agent__", description: "add agent.<name> to the config", help: "Creates a config agent entry you can then configure (model, permissions, prompt, mode...)." })
  options.push({ title: "< Back", value: "__back__", description: "Return to main menu" })

  const picked = await showMenu(api, { title: "Agents", options })
  if (!picked || picked === "__back__") return returnTo ? returnTo() : mainMenu(api, state)
  if (picked === "__new_agent__") {
    const name = await showPrompt(api.ui, { title: "Agent name", placeholder: "e.g. reviewer (letters, numbers, dashes)" })
    if (name === undefined || name.trim() === "" || !/^[\w.-]+$/.test(name.trim())) return agentsScreen(api, state)
    if (agents.has(name.trim())) {
      await showAlert(api.ui, { title: "Exists", message: `Agent "${name.trim()}" already exists.` })
      return agentsScreen(api, state)
    }
    const markdown = state.markdownAgents.find((agent) => agent.name === name.trim())
    if (markdown) {
      const proceed = await showConfirm(api.ui, {
        title: "Markdown collision",
        message: `A markdown agent "${name.trim()}" exists at\n${markdown.path}\n\nMarkdown overrides config entries for the same name. Create the config entry anyway?`,
        confirmLabel: "Create anyway",
      })
      if (!proceed) return agentsScreen(api, state)
    }
    await applyEdits({ api, state }, [{ op: "set", path: ["agent", name.trim()], value: {} }], `agent add ${name.trim()}`)
    configRestartReasons.push(`${name.trim()}: new agent requires restart to appear in the agent list.`)
    return agentDetail(api, state, name.trim())
  }
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

// Config-savable agent fields edited AV-style (FieldList): values stage into
// opencode.json through the unified queue.
const AGENT_CONFIG_FIELDS: Array<{ key: string; label: string; type: "model" | "variant" | "number" | "string" | "json" | "color" | "enum" | "boolean" | "permission"; doc: string; restart?: boolean; options?: string[] }> = [
  { key: "model", label: "Model", type: "model", doc: "agent.model" },
  { key: "variant", label: "Model variant", type: "variant", doc: "agent.variant" },
  { key: "temperature", label: "Temperature", type: "number", doc: "agent.temperature" },
  { key: "top_p", label: "Top P", type: "number", doc: "agent.top_p" },
  { key: "prompt", label: "Prompt", type: "string", doc: "agent.prompt" },
  { key: "permission", label: "Permissions", type: "permission", doc: "root.permission" },
  { key: "options", label: "Options", type: "json", doc: "agent.options" },
  { key: "mode", label: "Mode", type: "enum", options: ["subagent", "primary", "all"], doc: "agent.mode", restart: true },
  { key: "hidden", label: "Hidden", type: "boolean", doc: "agent.hidden", restart: true },
  { key: "steps", label: "Max steps", type: "number", doc: "agent.steps" },
  { key: "description", label: "Description", type: "string", doc: "agent.description", restart: true },
  { key: "color", label: "Color", type: "color", doc: "agent.color", restart: true },
]
const THEME_COLOR_NAMES = ["primary", "secondary", "accent", "success", "warning", "error", "info"]

/** Restart reasons collected from config edits (shown red in save summary). */
const configRestartReasons: string[] = []

function agentConfigValue(state: StudioState, agent: string, key: string): unknown {
  return getAtPath(state.merge.merged, ["agent", agent, key])
}

function fieldRowDescription(value: unknown, state: StudioState, pointer: JSONPath): string {
  const { winner } = provenanceAt(state.merge, pointer)
  const source = winner ? fileLabel(state, winner) : "OpenCode default"
  if (value === undefined) return `(not set - ${source})`
  const text = typeof value === "string" ? value : prettyJSON(value)
  return `${truncate(text, 46)} (${source})`
}

/** AV-style field list for one agent (probe-aware for the menu-tree smoke). */
async function avFieldList(api: TuiPluginApi, props: { title: string; options: AVFieldListOption[]; current?: string }): Promise<AVFieldListChoice | undefined> {
  if (menuProbe?.onMenu) {
    const selection = menuProbe.onMenu(props.title, props.options.map((option) => ({ title: option.title, value: option.value, description: option.description } as WizardSelectOption<unknown>)))
    if (selection === undefined || selection === null) return undefined
    return { action: "select", value: selection as string }
  }
  return avShowFieldList(avApiForWizard(api), props)
}

/** Wizard API boundary cast (type copies may differ across package installs). */
function avApiForWizard(api: TuiPluginApi): Parameters<typeof avAgentMode>[0] {
  return api as unknown as Parameters<typeof avAgentMode>[0]
}

async function agentDetail(api: TuiPluginApi, state: StudioState, agent: string): Promise<void> {
  const write: WriteContext = { api, state }
  let selectedField: string | undefined = AGENT_CONFIG_FIELDS[0]?.key

  while (true) {
    const moduleRuns: Array<{ run: (ctx: ModuleContext) => Promise<void> }> = []
    const options: AVFieldListOption[] = []

    if (avAgentMode(avApiForWizard(api), agent) === "primary") {
      options.push({ title: "! Primary-only agent", value: "__primary_info__", description: "task tool cannot call it", kind: "action" })
    }

    for (const field of AGENT_CONFIG_FIELDS) {
      const pointer: JSONPath = ["agent", agent, field.key]
      options.push({
        title: field.label,
        value: field.key,
        description: fieldRowDescription(agentConfigValue(state, agent, field.key), state, pointer),
        restart: field.restart === true,
        kind: "field",
      })
    }

    for (const module of enabledModuleList()) {
      if (moduleUsesOwnMenu(studioSettings, module)) continue
      for (const entry of module.agentDetailEntries?.(moduleContext(api, state), agent) ?? []) {
        moduleRuns.push(entry)
        options.push({ title: entry.title, value: `module-agent:${module.id}:${moduleRuns.length - 1}`, description: entry.description ?? "", kind: "action" })
      }
    }
    options.push({ title: "< Back", value: "__back__", description: "Return to agent list", kind: "action" })

    const pickedField = await avFieldList(api, { title: `Agent ${agent}`, options, current: selectedField })
    const field = pickedField?.value
    if (!field || field === "__back__") return agentsScreen(api, state)
    selectedField = field

    if (field === "__primary_info__") {
      await showInfo(api, {
        title: "Primary-only agent",
        message: [
          `"${agent}" runs in primary mode: the task tool cannot call it, so Agent Variants cannot attach variants to it.`,
          "Set mode: subagent (or all) in the agent config to make it task-callable.",
        ].join("\n"),
      })
      continue
    }

    if (field.startsWith("module-agent:")) {
      const rest = field.slice("module-agent:".length)
      const splitAt = rest.lastIndexOf(":")
      const index = Number(rest.slice(splitAt + 1))
      const entry = moduleRuns[index]
      if (entry) await entry.run(moduleContext(api, state))
      continue
    }

    const def = AGENT_CONFIG_FIELDS.find((item) => item.key === field)
    if (!def) continue
    const pointer: JSONPath = ["agent", agent, def.key]

    if (pickedField.action === "inspect") {
      await showInfo(api, {
        title: def.label,
        message: docText(def.doc, [
          `Current: ${fieldRowDescription(agentConfigValue(state, agent, def.key), state, pointer)}`,
          def.restart ? "RESTART REQUIRED when this field changes." : "Applies via config reload after Save & exit.",
        ]),
      })
      continue
    }

    // ---- edit flows ----
    if (def.type === "model") {
      const picked = await showMenu(api, {
        title: `Model - ${agent}`,
        options: [
          { title: "Pick model", value: "pick", description: "Full catalog picker" },
          { title: "Remove model override", value: "remove", description: "Use the session model", danger: Boolean(agentConfigValue(state, agent, "model")) },
          { title: "< Cancel", value: "__cancel__", description: "" },
        ],
      })
      if (!picked || picked === "__cancel__") continue
      if (picked === "remove") {
        await applyEdits(write, [{ op: "delete", path: pointer }], `agent ${agent} model remove`)
      } else {
        const modelPick = await pickAnyModel(api, state, `Model for agent ${agent}`)
        if (!modelPick) continue
        await applyEdits(write, [{ op: "set", path: pointer, value: `${modelPick.providerID}/${modelPick.modelID}` }], `agent ${agent} model`)
      }
      continue
    }

    if (def.type === "variant") {
      const modelRef = agentConfigValue(state, agent, "model")
      let providerID: string | undefined
      let modelID: string | undefined
      if (typeof modelRef === "string" && modelRef.includes("/")) {
        const [pid, ...rest] = modelRef.split("/")
        providerID = pid
        modelID = rest.join("/")
      } else {
        const pick = await pickAnyModel(api, state, `Agent ${agent} has no model set. Pick the model whose variants to list`)
        if (!pick) continue
        providerID = pick.providerID
        modelID = pick.modelID
      }
      const runtime = state.providers.find((item) => item.id === providerID)?.models?.[modelID!]
      const variantNames = runtime?.variants ? Object.keys(runtime.variants) : []
      const variantPick = await showMenu(api, {
        title: `Model variant - ${agent} (on ${providerID}/${modelID})`,
        options: [
          { title: "Default (no variant)", value: "__remove__", description: "Remove the agent variant override" },
          ...variantNames.map((name) => ({ title: name, value: name, description: "catalog variant" })),
          { title: "< Cancel", value: "__cancel__", description: "" },
        ],
      })
      if (!variantPick || variantPick === "__cancel__") continue
      await applyEdits(
        write,
        variantPick === "__remove__"
          ? [{ op: "delete", path: pointer }]
          : [{ op: "set", path: pointer, value: variantPick }],
        `agent ${agent} variant`,
      )
      continue
    }

    if (def.type === "number") {
      const input = await showPrompt(api.ui, {
        title: `Agent ${agent} - ${def.label}`,
        placeholder: def.key === "temperature" ? "0.0 - 2.0 (empty removes)" : "0.0 - 1.0 (empty removes)",
        value: agentConfigValue(state, agent, def.key) !== undefined ? String(agentConfigValue(state, agent, def.key)) : "",
      })
      if (input === undefined) continue
      if (input.trim() === "") {
        await applyEdits(write, [{ op: "delete", path: pointer }], `agent ${agent} ${def.key} remove`)
      } else {
        const num = Number(input)
        if (!Number.isFinite(num)) {
          await showAlert(api.ui, { title: "Invalid number", message: `"${input}" is not a number.` })
          continue
        }
        await applyEdits(write, [{ op: "set", path: pointer, value: num }], `agent ${agent} ${def.key}`)
      }
      continue
    }

    if (def.type === "json") {
      const body = await showJSONEditor(api, `agent.${agent}.${def.key}`, agentConfigValue(state, agent, def.key))
      if (body === undefined) continue
      if (body === "__delete__") {
        await applyEdits(write, [{ op: "delete", path: pointer }], `agent ${agent} ${def.key} remove`)
      } else {
        await applyEdits(write, [{ op: "set", path: pointer, value: body }], `agent ${agent} ${def.key}`)
      }
      continue
    }

    if (def.type === "permission") {
      await kitPermissionEditor(makeEditorKit(api, state), {
        title: `Agent ${agent} permissions`,
        pointer: ["agent", agent, "permission"],
        doc: "Agent-level permission rules override the root permission set for this agent (ask/allow/deny with wildcard patterns).",
      })
      continue
    }

    if (def.type === "enum" || def.type === "boolean") {
      const current = agentConfigValue(state, agent, def.key)
      const options: WizardSelectOption<string>[] = [
        { title: "(not set - remove)", value: "__remove__", description: "uses the default", danger: true },
        ...(def.type === "boolean" ? [{ title: "true", value: "true", description: "" }, { title: "false", value: "false", description: "" }] : (def.options ?? []).map((option) => ({ title: option, value: option, description: String(current) === option ? "current" : "" }))),
        { title: "< Cancel", value: "__cancel__", description: "" },
      ]
      const pickedValue = await showMenu(api, { title: `Agent ${agent} - ${def.label}`, options })
      if (!pickedValue || pickedValue === "__cancel__") continue
      if (pickedValue === "__remove__") {
        await applyEdits(write, [{ op: "delete", path: pointer }], `agent ${agent} ${def.key} remove`)
      } else {
        await applyEdits(write, [{ op: "set", path: pointer, value: pickedValue === "true" ? true : pickedValue === "false" ? false : pickedValue }], `agent ${agent} ${def.key}`)
      }
      if (def.restart) configRestartReasons.push(`${agent}: ${def.label.toLowerCase()} change requires restart.`)
      continue
    }

    if (def.type === "color") {
      const input = await showPrompt(api.ui, {
        title: `Agent ${agent} - Color`,
        placeholder: `#RRGGBB or ${THEME_COLOR_NAMES.join("/")} (empty removes)`,
        value: typeof agentConfigValue(state, agent, "color") === "string" ? String(agentConfigValue(state, agent, "color")) : "",
      })
      if (input === undefined) continue
      if (input.trim() === "") {
        await applyEdits(write, [{ op: "delete", path: pointer }], `agent ${agent} color remove`)
      } else if (!/^#[0-9a-fA-F]{6}$/.test(input.trim()) && !THEME_COLOR_NAMES.includes(input.trim())) {
        await showAlert(api.ui, { title: "Invalid color", message: "Use a #RRGGBB hex code or a theme color name." })
        continue
      } else {
        await applyEdits(write, [{ op: "set", path: pointer, value: input.trim() }], `agent ${agent} color`)
        configRestartReasons.push(`${agent}: color change requires restart.`)
      }
      continue
    }

    // string: prompt / description
    const input = await showPrompt(api.ui, {
      title: `Agent ${agent} - ${def.label}`,
      placeholder: `(empty removes the ${def.label} override)`,
      value: typeof agentConfigValue(state, agent, def.key) === "string" ? String(agentConfigValue(state, agent, def.key)) : "",
    })
    if (input === undefined) continue
    if (input === "") {
      await applyEdits(write, [{ op: "delete", path: pointer }], `agent ${agent} ${def.key} remove`)
    } else {
      await applyEdits(write, [{ op: "set", path: pointer, value: input }], `agent ${agent} ${def.key}`)
    }
    if (def.restart) configRestartReasons.push(`${agent}: ${def.label.toLowerCase()} change requires restart.`)
    continue
  }
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
      const reloadResult = await requestReload(api)
      if (reloadResult.kind === "deferred") {
        api.ui.toast({ variant: "warning", title: "Restored", message: `${entry.target} - reload deferred (${reloadResult.detectionFailed ? "unverified" : `${reloadResult.active} session(s) running`}); applies when they finish.` })
      } else {
        api.ui.toast({ variant: "info", title: "Restored", message: entry.target })
      }
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
  const cleanupFindings = scanCleanupFindings(state)
  const markdownCollisions = state.markdownAgents.filter((agent) => resolved["agent"] && typeof resolved["agent"] === "object" && (resolved["agent"] as Record<string, unknown>)[agent.name] !== undefined)
  const bothProviderFilters = Array.isArray(getAtPath(state.merge.merged, ["enabled_providers"])) && getAtPath(state.merge.merged, ["enabled_providers"]) !== undefined && getAtPath(state.merge.merged, ["disabled_providers"]) !== undefined
  const defaultAgent = typeof resolved["default_agent"] === "string" ? resolved["default_agent"] : undefined
  const defaultAgentProblem = defaultAgent
    ? (() => {
        const agentMap = resolved["agent"] as Record<string, unknown> | undefined
        const entry = agentMap && typeof agentMap === "object" ? agentMap[defaultAgent] : undefined
        if (entry === undefined && !["build", "plan", "general"].includes(defaultAgent)) return `"${defaultAgent}" is not defined anywhere - falls back to build`
        const mode = entry && typeof entry === "object" ? (entry as Record<string, unknown>)["mode"] : undefined
        if (mode === "subagent") return `"${defaultAgent}" is a subagent - OpenCode rejects it as default`
        const hidden = entry && typeof entry === "object" ? (entry as Record<string, unknown>)["hidden"] : undefined
        if (hidden === true) return `"${defaultAgent}" is hidden - OpenCode rejects it as default`
        return undefined
      })()
    : undefined
  const mergeLines = [
    `layers discovered: ${state.files.length}`,
    `tui.json layers: ${state.tuiFiles.filter((file) => file.exists).length}`,
    `markdown agents: ${state.markdownAgents.length}`,
    `editable (exist + parse ok): ${editableFiles(state.files).length}`,
    `provider catalog source: ${state.providersSource}`,
    `models.dev metadata: ${state.modelsDevError ? `error - ${state.modelsDevError}` : `${Object.keys(state.modelsDev).length} providers`}`,
    `write target: ${state.targetFilePath ?? "(picked per edit)"}`,
    `staged changes: ${state.pending.length}`,
  ]
  const sections: PagedSection[] = [
    { title: "Merge report", lines: mergeLines },
  ]
  if (cleanupFindings.length > 0) {
    sections.push({
      title: "Deprecated keys",
      lines: [
        `${cleanupFindings.length} deprecated/dead key finding(s) - Cleanup & migrations stages the fixes:`,
        ...cleanupFindings.flatMap((finding) => [`  ${finding.rule}: ${finding.detail} (${finding.file})`]),
      ],
    })
  }
  if (markdownCollisions.length > 0) {
    sections.push({
      title: "Markdown/config collisions",
      lines: [
        "Markdown agents override same-name config entries - config edits to these names have no effect:",
        ...markdownCollisions.flatMap((agent) => [`  ${agent.name} - ${agent.path}`]),
      ],
    })
  }
  if (bothProviderFilters) {
    sections.push({ title: "Provider filter conflict", lines: ["Both enabled_providers and disabled_providers are set - only the allowlist (enabled_providers) takes effect."] })
  }
  if (defaultAgentProblem) {
    sections.push({ title: "Default agent", lines: [defaultAgentProblem] })
  }
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
      title: `Dialog size picker: ${wizardDialogSize(api)}, ${wizardDialogHeightPercent(api)}%`,
      value: "size-picker",
      description: "Width + height with live preview",
      help: "AV-style size picker: cycle width (medium/large/xlarge), slide the height with presets (compact/normal/tall/max) or 1% steps, watch a live mini preview of the resulting dialog box.",
    },
    {
      title: pendingReload() ? "Reload config now (reload pending)" : "Reload config now",
      value: "reload-now",
      description: "dispose + rebuild OpenCode config",
      help: "Applies saved config immediately. If sessions are still running, a warning lists them before the reload interrupts their work.",
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
  if (picked === "size-picker") {
    await showSizeSlider(api)
    return uiScreen(api, state)
  }
  if (picked === "reload-now") {
    if (await confirmForceReload(api)) {
      const ok = await reloadNow(api)
      api.ui.toast({ variant: ok ? "success" : "warning", title: ok ? "Config reloaded" : "Reload failed", message: ok ? "OpenCode config disposed and rebuilt." : "Config reload failed - the watcher keeps retrying." })
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
    title: "Config Studio: Configure",
    desc: "Visual config editor - settings, providers, models, variants, TUI",
    category: "",
    slashName: "config-studio",
    run,
  }
  command.category = declarePaletteCategory("Config Studio", command)
  schedulePaletteReconcile()
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
      category: currentPaletteCategory(),
      slash: {
        name: "config-studio",
      },
      onSelect: run,
    },
  ])
}

const tui: TuiPlugin = async (api) => {
  activeApi = api
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
  setModuleAlertImplementation((moduleApi, title, message) => showAlert(moduleApi.ui, { title, message }))
  resetAgentVariantsLens()
  studioSettings = loadSettings(studioDataDir(api))

  // Startup duplicate check ONLY: the TUI entry runs at OpenCode startup, and
  // eager preloading here (client.provider.list / models.dev fetch) stacks on
  // OpenCode's own boot work and slows startup. Data loads lazily when the
  // studio command opens; the provider cache makes every later open instant.
  // Opening the studio re-checks (duplicateCheckDone is reset per command
  // run), which is fine - users should be warned twice rather than never.
  const startupCheckTimer = setTimeout(() => {
    void checkStandaloneDuplicates(api).catch(() => {})
  }, STARTUP_CHECK_DELAY_MS)
  ;(startupCheckTimer as { unref?: () => void }).unref?.()

  const unregister = registerStudioCommand(api, async () => {
    // The deferred-reload watcher must not fire global.dispose while the
    // studio is open (dispose reloads plugins and tears these dialogs down).
    beginStudioFlow()
    try {
      studioSettings = loadSettings(studioDataDir(api))
      duplicateCheckDone = false
      let state: StudioState | undefined
      // Deferred busy indicator: warm caches skip the dialog entirely; only a
      // genuinely slow load (cold start) flashes it after 150ms. The busy
      // dialog MUST finish its teardown (dialog.clear) before the first menu
      // opens - otherwise its clear() wipes the menu that replaced it.
      let settled = false
      const loading = refreshStudio(api).then((result) => {
        settled = true
        return result
      })
      let busyDone: Promise<void> | undefined
      const busyTimer = setTimeout(() => {
        if (!settled) busyDone = showBusy(api, "Loading config layers...", loading.then(() => undefined))
      }, 150)
      ;(busyTimer as { unref?: () => void }).unref?.()
      try {
        state = await loading
      } finally {
        clearTimeout(busyTimer)
      }
      if (busyDone) await busyDone
      if (!state) return
      await refreshAgentVariantsSource(api, state)
      await mainMenu(api, state)
    } finally {
      // Releasing the guard lets a pending deferred reload resume its watch;
      // if everything went idle while the studio was open, it applies then
      // (dialogs are closed at this point).
      endStudioFlow()
    }
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
  SizeSliderDialog,
  PagedDialog,
  scanCleanupFindings,
  setStudioSettings: (settings: StudioSettings) => {
    studioSettings = settings
  },
  resetDuplicateCheck: () => {
    duplicateCheckDone = false
  },
  /** Test seam: injects deferred-reload pending state (the bundled reload copy). */
  setReloadPendingForTest: (state: { since: number; active: number } | undefined) => {
    setReloadPendingForTest(state)
  },
  /** Skips the startup duplicate dialog (tests: the walker must not answer it). */
  suppressDuplicateDialog: () => {
    duplicateCheckDone = true
  },
  defaultHiddenSections: () => [...DEFAULT_HIDDEN_SECTIONS],
}
