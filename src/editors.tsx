/**
 * Value editors for every config surface the studio supports. All screens
 * receive an EditorKit (dialog primitives + staging callback) from tui.tsx so
 * this module stays free of host plumbing and every dialog stays probe-aware
 * for the menu-tree smoke.
 */
import {
  ALL_KEYBIND_NAMES,
  CLEANUP_RULES,
  KEYBIND_GROUPS,
  MCP_LOCAL_FIELDS,
  MCP_REMOTE_FIELDS,
  MODEL_FIELDS,
  PROVIDER_FIELDS,
  PROVIDER_OPTIONS_FIELDS,
  ROOT_KEYS,
  ROOT_KEY_GROUPS,
  TUI_KEYS,
  isPlainOnlyPermissionKey,
  keybindGroupsMatching,
  PERMISSION_ACTIONS,
  PERMISSION_TOOL_KEYS,
  toolsToPermission,
  type FieldKind,
  type FieldSuggestion,
  type ObjectFieldSpec,
  type RootKeyMeta,
} from "./keymeta.js"
import type { EditOp, JSONPath } from "./jsonc.js"
import type { StudioState, WizardSelectOption } from "./tui.js"

export interface EditorKit {
  state: StudioState
  showMenu: <V>(props: { title: string; options: WizardSelectOption<V>[]; current?: V; help?: string }) => Promise<V | undefined>
  showPrompt: (props: { title: string; description?: string; placeholder?: string; value?: string }) => Promise<string | undefined>
  showConfirm: (props: { title: string; message: string; confirmLabel?: string }) => Promise<boolean>
  showAlert: (props: { title: string; message: string }) => Promise<void>
  showInfo: (props: { title: string; message: string }) => Promise<void>
  showJSONEditor: (title: string, value: unknown) => Promise<Record<string, unknown> | undefined | "__delete__">
  pickModel: (title: string) => Promise<{ providerID: string; modelID: string } | undefined>
  stage: (ops: EditOp[], reason: string) => Promise<boolean>
  valueAt: (pointer: JSONPath) => unknown
  sourceLabel: (pointer: JSONPath) => string
  agentNames: () => string[]
  /** Variant names of a provider/model reference ("" = none). */
  variantsFor?: (modelRef: string) => string[]
  /** Known model families from the live catalog. */
  modelFamilies?: () => string[]
  /** Host hook: open the file-centric plugin manager. */
  openPlugins?: () => Promise<void>
  /** Host hook: open the agents screen. */
  openAgents?: () => Promise<void>
  /** Host hooks with a return continuation (settings group re-entry). */
  openPluginsFrom?: (returnTo: () => Promise<void>) => Promise<void>
  openAgentsFrom?: (returnTo: () => Promise<void>) => Promise<void>
}

function preview(value: unknown, max = 46): string {
  if (value === undefined) return "(not set)"
  if (value === null) return "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number" || typeof value === "string") return truncate(String(value), max)
  const text = JSON.stringify(value)
  return truncate(text ?? "?", max)
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toBoolOrRaw(input: string): unknown {
  if (input === "true") return true
  if (input === "false") return false
  return input
}

// ---------------------------------------------------------------------------
// Single-field editors
// ---------------------------------------------------------------------------

async function enumFieldEditor(kit: EditorKit, spec: { key: string; title: string; options?: string[]; placeholder?: string; doc: string }, pointer: JSONPath, current: unknown): Promise<void> {
  const options: WizardSelectOption<string>[] = [
    { title: "(not set - remove)", value: "__remove__", description: spec.placeholder ? `default: ${spec.placeholder}` : "uses the built-in default", danger: true },
  ]
  for (const option of spec.options ?? []) {
    options.push({ title: option, value: option, description: String(current) === option ? "current" : "" })
  }
  options.push({ title: "< Cancel", value: "__cancel__", description: "" })
  const picked = await kit.showMenu({ title: spec.title, options })
  if (picked === undefined || picked === "__cancel__") return
  if (picked === "__remove__") {
    await kit.stage([{ op: "delete", path: pointer }], `${spec.title} reset`)
    return
  }
  await kit.stage([{ op: "set", path: pointer, value: toBoolOrRaw(picked) }], `${spec.title} = ${picked}`)
}

async function boolFieldEditor(kit: EditorKit, spec: { key: string; title: string; doc: string }, pointer: JSONPath, current: unknown): Promise<void> {
  await enumFieldEditor(kit, { ...spec, options: ["true", "false"] }, pointer, current)
}

async function stringFieldEditor(kit: EditorKit, spec: { key: string; title: string; placeholder?: string; doc: string; suggestions?: FieldSuggestion[] }, pointer: JSONPath, current: unknown): Promise<void> {
  if (spec.suggestions && spec.suggestions.length > 0) {
    const options: WizardSelectOption<string>[] = spec.suggestions.map((suggestion) => ({
      title: suggestion.label,
      value: suggestion.value,
      description: String(current) === suggestion.value ? "current" : suggestion.value,
      help: suggestion.detail,
      edited: String(current) === suggestion.value,
    }))
    options.push({ title: "Custom...", value: "__custom__", description: "enter a raw value", help: spec.doc })
    if (current !== undefined && !spec.suggestions.some((suggestion) => suggestion.value === String(current))) {
      options.unshift({ title: `${truncate(String(current), 40)} (current, custom)`, value: String(current), description: "keep", edited: true })
    }
    options.push({ title: "< Cancel", value: "__cancel__", description: "" })
    const picked = await kit.showMenu({ title: spec.title, options, current: current !== undefined ? String(current) : undefined })
    if (picked === undefined || picked === "__cancel__") return
    if (picked === "__custom__") {
      const input = await kit.showPrompt({ title: spec.title, placeholder: spec.placeholder ?? "(empty removes)", value: typeof current === "string" ? current : "", description: spec.doc })
      if (input === undefined) return
      if (input.trim() === "") {
        await kit.stage([{ op: "delete", path: pointer }], `${spec.title} removed`)
      } else {
        await kit.stage([{ op: "set", path: pointer, value: input.trim() }], `${spec.title} set`)
      }
      return
    }
    await kit.stage([{ op: "set", path: pointer, value: picked }], `${spec.title} = ${picked}`)
    return
  }
  const input = await kit.showPrompt({
    title: spec.title,
    placeholder: spec.placeholder ?? "(empty removes)",
    value: typeof current === "string" ? current : "",
    description: spec.doc,
  })
  if (input === undefined) return
  if (input.trim() === "") {
    await kit.stage([{ op: "delete", path: pointer }], `${spec.title} removed`)
  } else {
    await kit.stage([{ op: "set", path: pointer, value: input.trim() }], `${spec.title} set`)
  }
}

async function numberFieldEditor(kit: EditorKit, spec: { key: string; title: string; placeholder?: string; min?: number; doc: string }, pointer: JSONPath, current: unknown): Promise<void> {
  const input = await kit.showPrompt({
    title: spec.title,
    placeholder: spec.placeholder ?? "(empty removes)",
    value: current !== undefined ? String(current) : "",
    description: spec.doc,
  })
  if (input === undefined) return
  if (input.trim() === "") {
    await kit.stage([{ op: "delete", path: pointer }], `${spec.title} removed`)
    return
  }
  const num = Number(input)
  if (!Number.isFinite(num) || (spec.min !== undefined && num < spec.min)) {
    await kit.showAlert({ title: "Invalid number", message: `"${input}" is not a valid number${spec.min !== undefined ? ` (minimum ${spec.min})` : ""}.` })
    return
  }
  await kit.stage([{ op: "set", path: pointer, value: num }], `${spec.title} = ${num}`)
}

export async function stringListEditor(kit: EditorKit, title: string, pointer: JSONPath, doc: string, suggestions?: FieldSuggestion[]): Promise<void> {
  while (true) {
    const list = kit.valueAt(pointer)
    const items = Array.isArray(list) ? list.map((item) => String(item)) : []
    const options: WizardSelectOption<string>[] = items.map((item, index) => ({
      title: truncate(item, 50),
      value: `edit:${index}`,
      description: kit.sourceLabel([...pointer, String(index)]),
      edited: true,
    }))
    if (suggestions) {
      for (const suggestion of suggestions) {
        if (!items.includes(suggestion.value)) options.push({ title: `+ ${suggestion.value}`, value: `quick:${suggestion.value}`, description: suggestion.label, help: suggestion.detail, edited: true })
      }
    }
    options.push({ title: "+ Add entry", value: "add", description: "" })
    options.push({ title: "< Back", value: "__back__", description: items.length === 0 ? "(list is empty)" : "" })
    const picked = await kit.showMenu({ title, options, help: doc })
    if (!picked || picked === "__back__") return

    if (picked === "add") {
      const value = await kit.showPrompt({ title: "New entry", placeholder: "value", description: doc })
      if (value === undefined || value.trim() === "") continue
      const next = [...items, value.trim()]
      await kit.stage([{ op: "set", path: pointer, value: next }], `${title}: add`)
      continue
    }
    if (picked.startsWith("quick:")) {
      await kit.stage([{ op: "set", path: pointer, value: [...items, picked.slice(6)] }], `${title}: add ${picked.slice(6)}`)
      continue
    }
    if (picked.startsWith("edit:")) {
      const index = Number(picked.slice(5))
      const action = await kit.showMenu({
        title: String(items[index]),
        options: [
          { title: "Edit", value: "edit", description: "" },
          { title: "Remove", value: "remove", description: "", danger: true },
          { title: "Move up", value: "up", description: index > 0 ? "" : "(first)" },
          { title: "Move down", value: "down", description: index < items.length - 1 ? "" : "(last)" },
          { title: "< Cancel", value: "__cancel__", description: "" },
        ],
      })
      if (!action || action === "__cancel__") continue
      if (action === "edit") {
        const value = await kit.showPrompt({ title: "Edit entry", value: items[index] })
        if (value === undefined || value.trim() === "") continue
        const next = [...items]
        next[index] = value.trim()
        await kit.stage([{ op: "set", path: pointer, value: next }], `${title}: edit`)
        continue
      }
      if (action === "remove") {
        await kit.stage([{ op: "set", path: pointer, value: items.filter((_, i) => i !== index) }], `${title}: remove`)
        continue
      }
      const swap = action === "up" ? index - 1 : index + 1
      if (swap < 0 || swap >= items.length) continue
      const next = [...items]
      const moved = next[index]!
      next[index] = next[swap]!
      next[swap] = moved
      await kit.stage([{ op: "set", path: pointer, value: next }], `${title}: reorder`)
      continue
    }
  }
}

async function modelFieldEditor(kit: EditorKit, spec: { title: string; doc: string }, pointer: JSONPath, current: unknown): Promise<void> {
  const picked = await kit.showMenu({
    title: spec.title,
    options: [
      { title: "Pick from catalog", value: "pick", description: typeof current === "string" ? `current: ${current}` : "" },
      { title: "Enter manually", value: "manual", description: "provider/model for providers not in the catalog yet" },
      { title: "Remove", value: "remove", description: "", danger: current !== undefined },
      { title: "< Cancel", value: "__cancel__", description: "" },
    ],
  })
  if (!picked || picked === "__cancel__") return
  if (picked === "remove") {
    await kit.stage([{ op: "delete", path: pointer }], `${spec.title} removed`)
    return
  }
  if (picked === "manual") {
    const input = await kit.showPrompt({ title: spec.title, placeholder: "provider/model", value: typeof current === "string" ? current : "" })
    if (input === undefined || !input.includes("/")) {
      if (input !== undefined) await kit.showAlert({ title: "Invalid", message: "Model references use provider/model." })
      return
    }
    await kit.stage([{ op: "set", path: pointer, value: input.trim() }], `${spec.title} = ${input.trim()}`)
    return
  }
  const modelPick = await kit.pickModel(spec.title)
  if (!modelPick) return
  await kit.stage([{ op: "set", path: pointer, value: `${modelPick.providerID}/${modelPick.modelID}` }], `${spec.title} = ${modelPick.providerID}/${modelPick.modelID}`)
}

async function jsonFieldEditor(kit: EditorKit, spec: { title: string; doc: string }, pointer: JSONPath, current: unknown, allowBool: boolean): Promise<void> {
  const options: WizardSelectOption<string>[] = [
    { title: "Edit as JSON", value: "json", description: preview(current) },
    { title: "Remove", value: "remove", description: "", danger: current !== undefined },
  ]
  if (allowBool) {
    options.unshift({ title: "true", value: "b:true", description: "" }, { title: "false", value: "b:false", description: "" })
  }
  options.push({ title: "< Cancel", value: "__cancel__", description: "" })
  const picked = await kit.showMenu({ title: spec.title, options })
  if (!picked || picked === "__cancel__") return
  if (picked === "remove") {
    await kit.stage([{ op: "delete", path: pointer }], `${spec.title} removed`)
    return
  }
  if (picked.startsWith("b:")) {
    await kit.stage([{ op: "set", path: pointer, value: picked === "b:true" }], `${spec.title} = ${picked.slice(2)}`)
    return
  }
  const body = await kit.showJSONEditor(spec.title, isPlainObject(current) ? current : {})
  if (body === undefined) return
  if (body === "__delete__") {
    await kit.stage([{ op: "delete", path: pointer }], `${spec.title} removed`)
    return
  }
  await kit.stage([{ op: "set", path: pointer, value: body }], `${spec.title} set`)
}

export async function fieldEditor(kit: EditorKit, spec: ObjectFieldSpec, pointer: JSONPath, returnTo?: () => Promise<void>): Promise<void> {
  const current = kit.valueAt(pointer)
  switch (spec.kind) {
    case "boolean":
      return boolFieldEditor(kit, spec, pointer, current)
    case "enum":
      return enumFieldEditor(kit, spec, pointer, current)
    case "string":
      return stringFieldEditor(kit, spec, pointer, current)
    case "number":
      return numberFieldEditor(kit, spec, pointer, current)
    case "stringList":
      return stringListEditor(kit, spec.title, pointer, spec.doc, spec.suggestions)
    case "json":
      return jsonFieldEditor(kit, spec, pointer, current, false)
    case "boolOrJson":
      return jsonFieldEditor(kit, spec, pointer, current, true)
    case "model":
      return modelFieldEditor(kit, spec, pointer, current)
    case "object":
      return objectEditor(kit, { title: spec.title, pointer, fields: spec.fields ?? [], doc: spec.doc, allowExtraKeys: spec.allowExtraKeys, extraKeysLabel: spec.extraKeysLabel })
    case "permission":
      return permissionEditor(kit, { title: spec.title, pointer, doc: spec.doc })
    case "mcp":
      return mcpScreen(kit)
    case "commandMap":
      return commandScreen(kit)
    case "referenceMap":
      return referenceScreen(kit)
    case "providerMap": {
      // ["provider", id, "models"] opens the per-provider model manager;
      // bare providerMap pointers open the provider list.
      if (pointer[0] === "provider" && pointer[2] === "models" && typeof pointer[1] === "string") {
        return providerModelsScreen(kit, pointer[1])
      }
      return providerListScreen(kit, pointer)
    }
    case "agentMap": {
      if (kit.openAgentsFrom && returnTo) return kit.openAgentsFrom(returnTo)
      if (kit.openAgents) return kit.openAgents()
      await kit.showInfo({ title: "Agents", message: "Agent editing lives in the studio's Agents screen (main menu)." })
      return
    }
    case "pluginList": {
      if (kit.openPluginsFrom && returnTo) return kit.openPluginsFrom(returnTo)
      if (kit.openPlugins) return kit.openPlugins()
      return pluginManagerScreen(kit)
    }
    case "agent": {
      const names = kit.agentNames()
      const picked = await kit.showMenu({
        title: spec.title,
        options: [
          ...names.map((name) => ({ title: name, value: name, description: String(current) === name ? "current" : "" })),
          { title: "(not set - remove)", value: "__remove__", description: "", danger: current !== undefined },
          { title: "< Cancel", value: "__cancel__", description: "" },
        ],
      })
      if (!picked || picked === "__cancel__") return
      if (picked === "__remove__") {
        await kit.stage([{ op: "delete", path: pointer }], `${spec.title} removed`)
        return
      }
      await kit.stage([{ op: "set", path: pointer, value: picked }], `${spec.title} = ${picked}`)
      return
    }
  }
}

// ---------------------------------------------------------------------------
// Recursive object editor (AV-style field rows)
// ---------------------------------------------------------------------------

export async function objectEditor(
  kit: EditorKit,
  props: { title: string; pointer: JSONPath; fields: ObjectFieldSpec[]; doc?: string; allowExtraKeys?: boolean; extraKeysLabel?: string; onDelete?: () => Promise<void> },
): Promise<void> {
  while (true) {
    const current = kit.valueAt(props.pointer)
    const data = isPlainObject(current) ? current : {}
    const knownKeys = new Set(props.fields.map((field) => field.key))
    const extraKeys = Object.keys(data).filter((key) => !knownKeys.has(key))
    const options: WizardSelectOption<string>[] = []

    for (const field of props.fields) {
      const value = data[field.key]
      options.push({
        title: field.title,
        value: `field:${field.key}`,
        description: `${preview(value)} (${kit.sourceLabel([...props.pointer, field.key])})`,
        help: field.doc,
      })
    }
    for (const key of extraKeys) {
      options.push({
        title: `+ ${key}`,
        value: `extra:${key}`,
        description: `${preview(data[key])} (extra key)`,
        edited: true,
      })
    }
    if (props.allowExtraKeys) {
      options.push({ title: "+ Add key", value: "add-key", description: props.extraKeysLabel ?? "additional keys" })
    }
    if (props.onDelete) {
      options.push({ title: "! Remove whole section", value: "__delete__", description: "", danger: true })
    }
    options.push({ title: "< Back", value: "__back__", description: "" })

    const picked = await kit.showMenu({ title: props.title, options })
    if (!picked || picked === "__back__") return

    if (picked === "__delete__") {
      if (await kit.showConfirm({ title: "Remove", message: `Remove ${props.title} from the config?`, confirmLabel: "Remove" })) {
        await props.onDelete!()
      }
      continue
    }
    if (picked === "add-key") {
      const key = await kit.showPrompt({ title: "New key", placeholder: "key name" })
      if (key === undefined || key.trim() === "" || knownKeys.has(key.trim())) continue
      const body = await kit.showJSONEditor(`${props.title} - ${key.trim()}`, {})
      if (body === undefined || body === "__delete__") continue
      await kit.stage([{ op: "set", path: [...props.pointer, key.trim()], value: body }], `${props.title}: add ${key.trim()}`)
      continue
    }
    if (picked.startsWith("field:")) {
      const key = picked.slice(6)
      const spec = props.fields.find((field) => field.key === key)
      if (!spec) continue
      await fieldEditor(kit, spec, [...props.pointer, key])
      continue
    }
    if (picked.startsWith("extra:")) {
      const key = picked.slice(6)
      const action = await kit.showMenu({
        title: key,
        options: [
          { title: "Edit as JSON", value: "json", description: preview(data[key]) },
          { title: "Remove key", value: "remove", description: "", danger: true },
          { title: "< Cancel", value: "__cancel__", description: "" },
        ],
      })
      if (!action || action === "__cancel__") continue
      if (action === "remove") {
        await kit.stage([{ op: "delete", path: [...props.pointer, key] }], `${props.title}: remove ${key}`)
        continue
      }
      const body = await kit.showJSONEditor(`${props.title} - ${key}`, isPlainObject(data[key]) ? data[key] : {})
      if (body === undefined) continue
      if (body === "__delete__") {
        await kit.stage([{ op: "delete", path: [...props.pointer, key] }], `${props.title}: remove ${key}`)
        continue
      }
      await kit.stage([{ op: "set", path: [...props.pointer, key], value: body }], `${props.title}: set ${key}`)
      continue
    }
  }
}

// ---------------------------------------------------------------------------
// Settings screen (all root keys, grouped)
// ---------------------------------------------------------------------------

export async function settingsScreen(kit: EditorKit): Promise<void> {
  while (true) {
    const groupPicked = await kit.showMenu({
      title: "Settings",
      options: [
        ...ROOT_KEY_GROUPS.map((group) => ({
          title: group,
          value: group,
          description: `${ROOT_KEYS.filter((meta) => meta.group === group).length} key(s)`,
        })),
        { title: "< Back", value: "__back__", description: "" },
      ],
    })
    if (!groupPicked || groupPicked === "__back__") return
    await settingsGroupScreen(kit, groupPicked)
  }
}

async function settingsGroupScreen(kit: EditorKit, group: string): Promise<void> {
  while (true) {
    const metas = ROOT_KEYS.filter((meta) => meta.group === group)
    const options: WizardSelectOption<string>[] = metas.map((meta) => ({
      title: meta.dead ? `${meta.title} [dead]` : meta.deprecated ? `${meta.title} [deprecated]` : meta.title,
      value: meta.key,
      description: `${timingBadge(meta.timing)}${meta.concat ? "concat" : ""} ${preview(kit.valueAt([meta.key]))} (${kit.sourceLabel([meta.key])})`.trim(),
      help: meta.doc + (meta.deprecated ? `\n\nDeprecated: ${meta.deprecated}` : ""),
      danger: meta.dead === true,
      edited: kit.valueAt([meta.key]) !== undefined,
    }))
    options.push({ title: "< Back", value: "__back__", description: "" })
    const picked = await kit.showMenu({ title: group, options })
    if (!picked || picked === "__back__") return
    const meta = metas.find((item) => item.key === picked)
    if (!meta) continue
    if (meta.dead) {
      const remove = await kit.showConfirm({
        title: `${meta.title} is dead`,
        message: `${meta.deprecated}\n\nRemove the key from the config?`,
        confirmLabel: "Remove",
      })
      if (remove) await kit.stage([{ op: "delete", path: [meta.key] }], `cleanup ${meta.key}`)
      continue
    }
    await fieldEditor(kit, rootSpecToFieldSpec(meta), [meta.key], async () => settingsGroupScreen(kit, group))
  }
}

function timingBadge(timing: RootKeyMeta["timing"]): string {
  if (timing === "restart") return "[restart]"
  if (timing === "reload") return "[reload]"
  return ""
}

function rootSpecToFieldSpec(meta: RootKeyMeta): ObjectFieldSpec {
  return {
    key: meta.key,
    title: meta.title,
    kind: meta.kind,
    options: meta.options,
    suggestions: meta.suggestions,
    placeholder: meta.placeholder,
    min: meta.min,
    doc: meta.doc + (meta.deprecated ? `\n\nDeprecated: ${meta.deprecated}` : "") + (meta.concat ? "\n\nNOTE: entries from all config layers are CONCATENATED (global + project), not replaced." : ""),
    fields: meta.fields,
  }
}

// ---------------------------------------------------------------------------
// Permission editor
// ---------------------------------------------------------------------------

export async function permissionEditor(kit: EditorKit, props: { title: string; pointer: JSONPath; doc: string }): Promise<void> {
  while (true) {
    const current = kit.valueAt(props.pointer)
    const map = isPlainObject(current) ? current : {}
    const knownKeys = new Set<string>(PERMISSION_TOOL_KEYS)
    const toolKeys = [...new Set([...PERMISSION_TOOL_KEYS, ...Object.keys(map)])].filter((key) => key !== "*")

    const options: WizardSelectOption<string>[] = []
    if (typeof current === "string") {
      options.push({ title: `! Shorthand: ${current}`, value: "__shorthand__", description: "applies to every tool - selecting edits it", danger: true, edited: true })
    } else {
      options.push({ title: "Shorthand (all tools)", value: "__shorthand__", description: map["*"] !== undefined ? `* = ${preview(map["*"])}` : "(not set)" })
    }
    for (const tool of toolKeys) {
      const rule = map[tool]
      options.push({
        title: tool,
        value: `tool:${tool}`,
        description: rule === undefined ? "(default: ask)" : typeof rule === "string" ? rule : rule !== null && typeof rule === "object" ? Object.entries(rule).map(([pattern, action]) => `${pattern}=${action}`).join(", ").slice(0, 60) : "?",
        help: isPlainOnlyPermissionKey(tool) ? "Plain action only (no pattern rules) for this tool." : "Action for the whole tool, or per-pattern rules. Last matching rule wins; * and ? wildcards supported.",
        edited: rule !== undefined,
      })
    }
    options.push({ title: "+ Add custom tool rule", value: "add-tool", description: "e.g. an MCP tool name" })
    options.push({ title: "i How matching works", value: "__help__", description: "" })
    options.push({ title: "< Back", value: "__back__", description: "" })

    const picked = await kit.showMenu({ title: props.title, options })
    if (!picked || picked === "__back__") return

    if (picked === "__shorthand__") {
      const action = await kit.showMenu({
        title: "Shorthand rule (every tool)",
        options: [
          { title: "(remove shorthand)", value: "__remove__", description: "", danger: true },
          ...PERMISSION_ACTIONS.map((item) => ({ title: item, value: item, description: typeof current === "string" && current === item ? "current" : "" })),
          { title: "< Cancel", value: "__cancel__", description: "" },
        ],
      })
      if (!action || action === "__cancel__") continue
      if (typeof current === "string" && action !== "__remove__") {
        await kit.stage([{ op: "set", path: props.pointer, value: action }], `permission shorthand = ${action}`)
        continue
      }
      if (action !== "__remove__") {
        const replace = await kit.showConfirm({
          title: "Replace pattern rules?",
          message: "A shorthand replaces ALL per-tool rules. Continue?",
          confirmLabel: "Replace",
        })
        if (!replace) continue
        await kit.stage([{ op: "set", path: props.pointer, value: action }], `permission shorthand = ${action}`)
        continue
      }
      if (typeof current === "string") {
        await kit.stage([{ op: "delete", path: props.pointer }], "permission shorthand removed")
      } else if (map["*"] !== undefined) {
        const next = { ...map }
        delete next["*"]
        await setPermissionMap(kit, props.pointer, next, props.title)
      }
      continue
    }

    if (picked === "__help__") {
      await kit.showInfo({
        title: "Permission matching",
        message: [
          "Rules: ask | allow | deny per tool, optionally per wildcard pattern (\"git push\", \"*.env\", \"src/**\").",
          "* and ? are wildcards; patterns ending in \" *\" make the suffix optional (\"ls\" also matches \"ls -la\").",
          "The LAST matching rule wins; unmatched actions default to ask.",
          "Precedence: built-in defaults < root permission < agent permission < session approvals.",
          "Agent-level rules override root rules for that agent.",
          "Hidden tools: a deny with pattern * removes the tool from the model entirely.",
        ].join("\n"),
      })
      continue
    }

    if (picked === "add-tool") {
      const tool = await kit.showPrompt({ title: "Tool name", placeholder: "e.g. mymcp_mytool" })
      if (tool === undefined || tool.trim() === "") continue
      await toolRuleEditor(kit, props.pointer, tool.trim(), props.title)
      continue
    }

    if (picked.startsWith("tool:")) {
      await toolRuleEditor(kit, props.pointer, picked.slice(5), props.title)
      continue
    }
  }
}

async function setPermissionMap(kit: EditorKit, pointer: JSONPath, next: Record<string, unknown>, title: string): Promise<void> {
  if (Object.keys(next).length === 0) {
    await kit.stage([{ op: "delete", path: pointer }], `${title}: rules removed`)
    return
  }
  await kit.stage([{ op: "set", path: pointer, value: next }], `${title}: rules updated`)
}

async function toolRuleEditor(kit: EditorKit, pointer: JSONPath, tool: string, title: string): Promise<void> {
  const current = kit.valueAt(pointer)
  const map = isPlainObject(current) ? current : {}
  const rule = map[tool]

  if (rule === undefined) {
    const action = await kit.showMenu({
      title: `${tool} rule`,
      options: [
        ...PERMISSION_ACTIONS.map((item) => ({ title: item, value: item, description: "" })),
        ...(isPlainOnlyPermissionKey(tool) ? [] : [{ title: "Pattern rules...", value: "patterns", description: "per-command/path rules" } as WizardSelectOption<string>]),
        { title: "< Cancel", value: "__cancel__", description: "" },
      ],
    })
    if (!action || action === "__cancel__") return
    if (action === "patterns") {
      await patternRuleEditor(kit, pointer, tool, {}, title)
      return
    }
    await setPermissionMap(kit, pointer, { ...map, [tool]: action }, title)
    return
  }

  const options: WizardSelectOption<string>[] = [
    { title: "Set action", value: "action", description: typeof rule === "string" ? `current: ${rule}` : "" },
    ...(isPlainOnlyPermissionKey(tool) ? [] : [{ title: "Pattern rules", value: "patterns", description: typeof rule === "object" ? `${Object.keys(rule as object).length} pattern(s)` : "convert to per-pattern rules" } as WizardSelectOption<string>]),
    { title: "Remove rule", value: "remove", description: "", danger: true },
    { title: "< Cancel", value: "__cancel__", description: "" },
  ]
  const picked = await kit.showMenu({ title: `${tool} rule`, options })
  if (!picked || picked === "__cancel__") return
  if (picked === "remove") {
    const next = { ...map }
    delete next[tool]
    await setPermissionMap(kit, pointer, next, title)
    return
  }
  if (picked === "action") {
    const action = await kit.showMenu({
      title: `${tool} action`,
      options: [...PERMISSION_ACTIONS.map((item) => ({ title: item, value: item, description: typeof rule === "string" && rule === item ? "current" : "" })), { title: "< Cancel", value: "__cancel__", description: "" }],
    })
    if (!action || action === "__cancel__") return
    await setPermissionMap(kit, pointer, { ...map, [tool]: action }, title)
    return
  }
  await patternRuleEditor(kit, pointer, tool, isPlainObject(rule) ? rule : {}, title)
}

async function patternRuleEditor(kit: EditorKit, pointer: JSONPath, tool: string, existing: Record<string, unknown>, title: string): Promise<void> {
  let patterns = { ...existing }
  while (true) {
    const entries = Object.entries(patterns)
    const options: WizardSelectOption<string>[] = entries.map(([pattern, action]) => ({
      title: truncate(pattern, 44),
      value: `edit:${pattern}`,
      description: String(action),
      edited: true,
    }))
    options.push({ title: "+ Add pattern", value: "add", description: "wildcards: * and ?" })
    options.push({ title: "Save", value: "save", description: entries.length === 0 ? "removes the rule" : `${entries.length} pattern(s)` })
    options.push({ title: "< Cancel", value: "__cancel__", description: "" })
    const picked = await kit.showMenu({ title: `${tool} patterns (last match wins)`, options })
    if (!picked || picked === "__cancel__") return
    if (picked === "add") {
      const pattern = await kit.showPrompt({ title: "Pattern", placeholder: 'e.g. "git push" or "*.env"' })
      if (pattern === undefined || pattern.trim() === "") continue
      const action = await kit.showMenu({
        title: `Action for ${pattern.trim()}`,
        options: [...PERMISSION_ACTIONS.map((item) => ({ title: item, value: item, description: "" })), { title: "< Cancel", value: "__cancel__", description: "" }],
      })
      if (!action || action === "__cancel__") continue
      patterns = { ...patterns, [pattern.trim()]: action }
      continue
    }
    if (picked === "save") {
      const current = kit.valueAt(pointer)
      const map = isPlainObject(current) ? current : {}
      if (Object.keys(patterns).length === 0) {
        const next = { ...map }
        delete next[tool]
        await setPermissionMap(kit, pointer, next, title)
      } else {
        await setPermissionMap(kit, pointer, { ...map, [tool]: patterns }, title)
      }
      return
    }
    if (picked.startsWith("edit:")) {
      const pattern = picked.slice(5)
      const action = await kit.showMenu({
        title: pattern,
        options: [
          ...PERMISSION_ACTIONS.map((item) => ({ title: item, value: item, description: patterns[pattern] === item ? "current" : "" })),
          { title: "Remove pattern", value: "remove", description: "", danger: true },
          { title: "< Cancel", value: "__cancel__", description: "" },
        ],
      })
      if (!action || action === "__cancel__") continue
      const next = { ...patterns }
      if (action === "remove") delete next[pattern]
      else next[pattern] = action
      patterns = next
      continue
    }
  }
}

// ---------------------------------------------------------------------------
// MCP manager
// ---------------------------------------------------------------------------

export async function mcpScreen(kit: EditorKit): Promise<void> {
  while (true) {
    const mcp = kit.valueAt(["mcp"])
    const map = isPlainObject(mcp) ? mcp : {}
    const options: WizardSelectOption<string>[] = Object.entries(map).map(([name, entry]) => {
      const object = isPlainObject(entry) ? entry : {}
      const type = object["type"] === "remote" ? "remote" : object["type"] === "local" ? "local" : "overlay"
      const enabled = object["enabled"] === false ? "disabled" : "enabled"
      return {
        title: name,
        value: `server:${name}`,
        description: `[${type}] ${enabled} (${kit.sourceLabel(["mcp", name])})`,
        edited: true,
        help: type === "local" ? "Local stdio server: command + args array." : type === "remote" ? "Remote HTTP server." : "Partial entry (usually an enabled:false overlay of a lower layer).",
      }
    })
    options.push({ title: "+ Add local server", value: "add-local", description: "stdio command" })
    options.push({ title: "+ Add remote server", value: "add-remote", description: "HTTP endpoint" })
    options.push({ title: "< Back", value: "__back__", description: Object.keys(map).length === 0 ? "(no servers configured)" : "" })

    const picked = await kit.showMenu({ title: "MCP servers", options })
    if (!picked || picked === "__back__") return

    if (picked === "add-local" || picked === "add-remote") {
      const name = await kit.showPrompt({ title: "Server name", placeholder: "e.g. github" })
      if (name === undefined || name.trim() === "" || map[name.trim()] !== undefined) continue
      const pointer: JSONPath = ["mcp", name.trim()]
      if (picked === "add-local") {
        const command = await kit.showPrompt({ title: "Command", placeholder: "e.g. npx -y @modelcontextprotocol/server-github", description: "Tokens are split on spaces into the command array (edit precisely after creation)." })
        if (command === undefined || command.trim() === "") continue
        await kit.stage([{ op: "set", path: pointer, value: { type: "local", command: command.trim().split(/\s+/) } }], `mcp add local ${name.trim()}`)
      } else {
        const url = await kit.showPrompt({ title: "URL", placeholder: "https://example.com/mcp" })
        if (url === undefined || url.trim() === "") continue
        await kit.stage([{ op: "set", path: pointer, value: { type: "remote", url: url.trim() } }], `mcp add remote ${name.trim()}`)
      }
      await mcpEntryScreen(kit, name.trim())
      continue
    }
    if (picked.startsWith("server:")) {
      await mcpEntryScreen(kit, picked.slice(7))
      continue
    }
  }
}

async function mcpEntryScreen(kit: EditorKit, name: string): Promise<void> {
  while (true) {
    const entry = kit.valueAt(["mcp", name])
    const object = isPlainObject(entry) ? entry : {}
    const type = object["type"] === "remote" ? "remote" : object["type"] === "local" ? "local" : undefined
    if (!type) {
      const picked = await kit.showMenu({
        title: `MCP ${name} (partial entry)`,
        options: [
          { title: "Define as local server", value: "local", description: "command + args" },
          { title: "Define as remote server", value: "remote", description: "HTTP endpoint" },
          { title: "Remove entry", value: "remove", description: "", danger: true },
          { title: "< Back", value: "__back__", description: "usually an enabled:false overlay of a lower layer" },
        ],
      })
      if (!picked || picked === "__back__") return
      if (picked === "remove") {
        await kit.stage([{ op: "delete", path: ["mcp", name] }], `mcp remove ${name}`)
        return
      }
      if (picked === "local") {
        const command = await kit.showPrompt({ title: "Command", placeholder: "npx -y server" })
        if (command === undefined || command.trim() === "") continue
        await kit.stage([{ op: "set", path: ["mcp", name], value: { ...object, type: "local", command: command.trim().split(/\s+/) } }], `mcp ${name} = local`)
        continue
      }
      const url = await kit.showPrompt({ title: "URL", placeholder: "https://..." })
      if (url === undefined || url.trim() === "") continue
      await kit.stage([{ op: "set", path: ["mcp", name], value: { ...object, type: "remote", url: url.trim() } }], `mcp ${name} = remote`)
      continue
    }

    const fields = type === "local" ? MCP_LOCAL_FIELDS : MCP_REMOTE_FIELDS
    const options: WizardSelectOption<string>[] = [
      { title: object["enabled"] === false ? "Enable server" : "Disable server", value: "__toggle__", description: "disabled servers never connect", danger: object["enabled"] !== false },
    ]
    for (const field of fields) {
      if (field.key === "enabled") continue
      options.push({
        title: field.title,
        value: `field:${field.key}`,
        description: `${preview(object[field.key])} (${kit.sourceLabel(["mcp", name, field.key])})`,
        help: field.doc,
      })
    }
    if (type === "remote") {
      options.push({ title: "OAuth", value: "field:__oauth__", description: object["oauth"] === undefined ? "(auto-detect)" : object["oauth"] === false ? "disabled" : "credentials set", help: "OAuth credentials object, or false to disable auto-detection." })
    }
    options.push({ title: "Remove server", value: "__remove__", description: "", danger: true })
    options.push({ title: "< Back", value: "__back__", description: "" })

    const picked = await kit.showMenu({ title: `MCP ${name} (${type})`, options })
    if (!picked || picked === "__back__") return
    if (picked === "__toggle__") {
      await kit.stage([{ op: "set", path: ["mcp", name, "enabled"], value: object["enabled"] === false }], `mcp ${name} ${object["enabled"] === false ? "enabled" : "disabled"}`)
      continue
    }
    if (picked === "__remove__") {
      if (await kit.showConfirm({ title: "Remove server", message: `Remove MCP server "${name}" from the config?`, confirmLabel: "Remove" })) {
        await kit.stage([{ op: "delete", path: ["mcp", name] }], `mcp remove ${name}`)
        return
      }
      continue
    }
    if (picked === "field:__oauth__") {
      const action = await kit.showMenu({
        title: "OAuth",
        options: [
          { title: "(not set - auto-detect)", value: "__remove__", description: "", danger: object["oauth"] !== undefined },
          { title: "false (disable OAuth)", value: "false", description: "" },
          { title: "Edit credentials", value: "json", description: "clientId / clientSecret / scope / callbackPort / redirectUri" },
          { title: "< Cancel", value: "__cancel__", description: "" },
        ],
      })
      if (!action || action === "__cancel__") continue
      if (action === "__remove__") {
        await kit.stage([{ op: "delete", path: ["mcp", name, "oauth"] }], `mcp ${name} oauth removed`)
        continue
      }
      if (action === "false") {
        await kit.stage([{ op: "set", path: ["mcp", name, "oauth"], value: false }], `mcp ${name} oauth disabled`)
        continue
      }
      const body = await kit.showJSONEditor("OAuth credentials", isPlainObject(object["oauth"]) ? object["oauth"] : {})
      if (body === undefined) continue
      if (body === "__delete__") {
        await kit.stage([{ op: "delete", path: ["mcp", name, "oauth"] }], `mcp ${name} oauth removed`)
        continue
      }
      await kit.stage([{ op: "set", path: ["mcp", name, "oauth"], value: body }], `mcp ${name} oauth set`)
      continue
    }
    if (picked.startsWith("field:")) {
      const key = picked.slice(6)
      const spec = fields.find((field) => field.key === key)
      if (!spec) continue
      if (spec.key === "environment" || spec.key === "headers") {
        await fieldEditor(kit, { ...spec, kind: "json" }, ["mcp", name, key])
        continue
      }
      await fieldEditor(kit, spec, ["mcp", name, key])
      continue
    }
  }
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

export async function commandScreen(kit: EditorKit): Promise<void> {
  while (true) {
    const commandMap = kit.valueAt(["command"])
    const map = isPlainObject(commandMap) ? commandMap : {}
    const options: WizardSelectOption<string>[] = Object.keys(map).map((name) => ({
      title: `/${name}`,
      value: `cmd:${name}`,
      description: `${preview(isPlainObject(map[name]) ? map[name]["description"] : undefined, 40)} (${kit.sourceLabel(["command", name])})`,
      edited: true,
    }))
    options.push({ title: "+ Add command", value: "add", description: "" })
    options.push({ title: "< Back", value: "__back__", description: Object.keys(map).length === 0 ? "(no custom commands)" : "" })

    const picked = await kit.showMenu({ title: "Slash commands", options })
    if (!picked || picked === "__back__") return
    if (picked === "add") {
      const name = await kit.showPrompt({ title: "Command name", placeholder: "e.g. review (shown as /review)" })
      if (name === undefined || name.trim() === "" || map[name.trim()] !== undefined) continue
      const template = await kit.showPrompt({ title: "Template", placeholder: "{prompt} - the user input", description: "Use {prompt} where the user's input goes." })
      if (template === undefined || template.trim() === "") continue
      await kit.stage([{ op: "set", path: ["command", name.trim()], value: { template: template.trim() } }], `command add ${name.trim()}`)
      await commandEntryScreen(kit, name.trim())
      continue
    }
    if (picked.startsWith("cmd:")) {
      await commandEntryScreen(kit, picked.slice(4))
      continue
    }
  }
}

async function commandEntryScreen(kit: EditorKit, name: string): Promise<void> {
  const modelRef = kit.valueAt(["command", name, "model"])
  const variantSuggestions: FieldSuggestion[] | undefined = typeof modelRef === "string" && kit.variantsFor
    ? kit.variantsFor(modelRef).map((variant) => ({ value: variant, label: variant, detail: `Variant of ${modelRef}` }))
    : undefined
  const COMMAND_FIELDS: ObjectFieldSpec[] = [
    { key: "template", title: "Template", kind: "string", doc: "Prompt template. Placeholders: $1..$N (the highest number receives all remaining args) and $ARGUMENTS (raw arg string). Without placeholders, args append after a blank line. !`cmd` segments run in the shell; @file mentions attach files." },
    { key: "description", title: "Description", kind: "string", doc: "Shown in the command list." },
    { key: "agent", title: "Agent", kind: "agent", doc: "Agent the command runs as (default: current). Unknown agent names error at run time. Subagent-mode agents always run as detached subtasks." },
    { key: "model", title: "Model", kind: "model", doc: "Model override for the command run. Priority: command.model > command agent's model > request model > session model." },
    { key: "variant", title: "Model variant", kind: "string", suggestions: variantSuggestions, doc: "Variant for the model above (provider/model#variant)." },
    { key: "subtask", title: "Subtask", kind: "boolean", doc: "Run as a nested subtask (fresh context) instead of a top-level turn. Forced true when the target agent is subagent-mode." },
  ]
  await objectEditor(kit, {
    title: `/${name}`,
    pointer: ["command", name],
    fields: COMMAND_FIELDS,
    doc: "Custom slash command definition.",
    onDelete: async () => {
      await kit.stage([{ op: "delete", path: ["command", name] }], `command remove ${name}`)
    },
  })
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

export async function referenceScreen(kit: EditorKit): Promise<void> {
  const KEY = "references"
  while (true) {
    const referenceMap = kit.valueAt([KEY])
    const map = isPlainObject(referenceMap) ? referenceMap : {}
    const options: WizardSelectOption<string>[] = Object.entries(map).map(([name, entry]) => ({
      title: name,
      value: `ref:${name}`,
      description: `${preview(referenceTarget(entry), 40)} (${kit.sourceLabel([KEY, name])})`,
      edited: true,
      help: referenceTarget(entry),
    }))
    options.push({ title: "+ Add reference", value: "add", description: "git repository or local path" })
    options.push({ title: "< Back", value: "__back__", description: Object.keys(map).length === 0 ? "(no references)" : "" })

    const picked = await kit.showMenu({ title: "References", options })
    if (!picked || picked === "__back__") return
    if (picked === "add") {
      const name = await kit.showPrompt({ title: "Reference name", placeholder: "e.g. docs" })
      if (name === undefined || name.trim() === "" || map[name.trim()] !== undefined) continue
      const kind = await kit.showMenu({
        title: "Reference type",
        options: [
          { title: "Git repository", value: "git", description: "cloned on demand" },
          { title: "Local path", value: "local", description: "directory on disk" },
          { title: "< Cancel", value: "__cancel__", description: "" },
        ],
      })
      if (!kind || kind === "__cancel__") continue
      if (kind === "git") {
        const repo = await kit.showPrompt({ title: "Repository", placeholder: "owner/repo or https://..." })
        if (repo === undefined || repo.trim() === "") continue
        await kit.stage([{ op: "set", path: [KEY, name.trim()], value: { repository: repo.trim() } }], `reference add ${name.trim()}`)
      } else {
        const path = await kit.showPrompt({ title: "Path", placeholder: "C:/path/to/dir" })
        if (path === undefined || path.trim() === "") continue
        await kit.stage([{ op: "set", path: [KEY, name.trim()], value: { path: path.trim() } }], `reference add ${name.trim()}`)
      }
      await referenceEntryScreen(kit, name.trim())
      continue
    }
    if (picked.startsWith("ref:")) {
      await referenceEntryScreen(kit, picked.slice(4))
      continue
    }
  }
}

function referenceTarget(entry: unknown): string {
  if (typeof entry === "string") return entry
  if (isPlainObject(entry)) {
    if (typeof entry["repository"] === "string") return `git: ${entry["repository"]}`
    if (typeof entry["path"] === "string") return `local: ${entry["path"]}`
  }
  return "?"
}

async function referenceEntryScreen(kit: EditorKit, name: string): Promise<void> {
  const GIT_FIELDS: ObjectFieldSpec[] = [
    { key: "repository", title: "Repository", kind: "string", doc: "Git repository (owner/repo or URL). Required for git references." },
    { key: "branch", title: "Branch", kind: "string", doc: "Branch to check out (default: default branch)." },
  ]
  const LOCAL_FIELDS: ObjectFieldSpec[] = [
    { key: "path", title: "Path", kind: "string", doc: "Local directory path. Required for local references." },
  ]
  const COMMON_FIELDS: ObjectFieldSpec[] = [
    { key: "description", title: "Description", kind: "string", doc: "What this reference contains - helps the model pick it." },
    { key: "hidden", title: "Hidden", kind: "boolean", doc: "Hide from the reference picker (still addressable)." },
  ]
  const entry = kit.valueAt(["references", name])
  const isGit = isPlainObject(entry) ? typeof entry["repository"] === "string" : typeof entry === "string" && /^[\w-]+\/[\w.-]+$|^https?:\/\//.test(entry)
  await objectEditor(kit, {
    title: `Reference ${name}`,
    pointer: ["references", name],
    fields: [...(isGit ? GIT_FIELDS : LOCAL_FIELDS), ...COMMON_FIELDS],
    doc: "Named external context (git repository or local directory).",
    onDelete: async () => {
      await kit.stage([{ op: "delete", path: ["references", name] }], `reference remove ${name}`)
    },
  })
}

// ---------------------------------------------------------------------------
// Provider deep editor (full provider-array support)
// ---------------------------------------------------------------------------

export async function providerListScreen(kit: EditorKit, pointer: JSONPath): Promise<void> {
  while (true) {
    const providerMap = kit.valueAt(pointer)
    const map = isPlainObject(providerMap) ? providerMap : {}
    const options: WizardSelectOption<string>[] = Object.keys(map)
      .sort()
      .map((id) => ({
        title: id,
        value: `provider:${id}`,
        description: `${Object.keys(isPlainObject(map[id]) ? map[id]!["models"] ?? {} : {}).length} model entry(s) (${kit.sourceLabel([...pointer, id])})`,
        edited: true,
        help: "Provider config entry.",
      }))
    options.push({ title: "+ Add provider", value: "add", description: "custom provider (api base, npm SDK, models)" })
    options.push({ title: "< Back", value: "__back__", description: Object.keys(map).length === 0 ? "(no provider entries in config)" : "" })

    const picked = await kit.showMenu({ title: "Provider entries", options })
    if (!picked || picked === "__back__") return
    if (picked === "add") {
      const id = await kit.showPrompt({ title: "Provider id", placeholder: "e.g. my-gateway (lowercase, no slashes)" })
      if (id === undefined || id.trim() === "" || map[id.trim()] !== undefined) continue
      await kit.stage([{ op: "set", path: [...pointer, id.trim()], value: {} }], `provider add ${id.trim()}`)
      await providerEntryScreen(kit, id.trim())
      continue
    }
    if (picked.startsWith("provider:")) {
      await providerEntryScreen(kit, picked.slice(9))
      continue
    }
  }
}

export async function providerEntryScreen(kit: EditorKit, id: string): Promise<void> {
  const pointer: JSONPath = ["provider", id]
  await objectEditor(kit, {
    title: `Provider ${id}`,
    pointer,
    fields: PROVIDER_FIELDS,
    doc: "Full provider entry: SDK wiring, connection options, and model definitions. New providers take effect after a reload/restart; the catalog refreshes on save.",
    onDelete: async () => {
      await kit.stage([{ op: "delete", path: pointer }], `provider remove ${id}`)
    },
  })
}

export async function modelEntryScreen(kit: EditorKit, providerID: string, modelID: string): Promise<void> {
  const pointer: JSONPath = ["provider", providerID, "models", modelID]
  const familySuggestions: FieldSuggestion[] | undefined = kit.modelFamilies
    ? kit.modelFamilies().slice(0, 30).map((family) => ({ value: family, label: family, detail: `Model family present in the live catalog.` }))
    : undefined
  const fields = MODEL_FIELDS.map((field) => (field.key === "family" && familySuggestions ? { ...field, suggestions: familySuggestions } : field))
  await objectEditor(kit, {
    title: `Model ${providerID}/${modelID}`,
    pointer,
    fields,
    doc: "Full model entry: capabilities, limits, cost, modalities, default options, and variants.",
    onDelete: async () => {
      await kit.stage([{ op: "delete", path: pointer }], `model remove ${providerID}/${modelID}`)
    },
  })
}

export async function providerModelsScreen(kit: EditorKit, providerID: string): Promise<void> {
  const pointer: JSONPath = ["provider", providerID, "models"]
  while (true) {
    const models = kit.valueAt(pointer)
    const map = isPlainObject(models) ? models : {}
    const options: WizardSelectOption<string>[] = Object.keys(map)
      .sort()
      .map((id) => ({
        title: id,
        value: `model:${id}`,
        description: preview(map[id], 60),
        edited: true,
        help: "Model entry (custom or catalog override).",
      }))
    options.push({ title: "+ Add model", value: "add", description: "custom model or catalog override" })
    options.push({ title: "< Back", value: "__back__", description: Object.keys(map).length === 0 ? "(no model entries)" : "" })

    const picked = await kit.showMenu({ title: `Models - ${providerID}`, options })
    if (!picked || picked === "__back__") return
    if (picked === "add") {
      const id = await kit.showPrompt({ title: "Model id", placeholder: "e.g. my-model-v1 (lowercase)" })
      if (id === undefined || id.trim() === "" || map[id.trim()] !== undefined) continue
      const name = await kit.showPrompt({ title: "Display name", placeholder: id.trim() })
      if (name === undefined) continue
      const entry: Record<string, unknown> = { name: name.trim() === "" ? id.trim() : name.trim() }
      const limits = await kit.showPrompt({ title: "Context limit (tokens)", placeholder: "e.g. 128000 (empty to skip)" })
      if (limits !== undefined && limits.trim() !== "" && Number.isFinite(Number(limits))) {
        entry["limit"] = { context: Number(limits) }
      }
      await kit.stage([{ op: "set", path: [...pointer, id.trim()], value: entry }], `model add ${providerID}/${id.trim()}`)
      await modelEntryScreen(kit, providerID, id.trim())
      continue
    }
    if (picked.startsWith("model:")) {
      await modelEntryScreen(kit, providerID, picked.slice(6))
      continue
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin manager hook (implemented host-side: file-centric staging)
// ---------------------------------------------------------------------------

export async function pluginManagerScreen(kit: EditorKit): Promise<void> {
  if (kit.openPlugins) return kit.openPlugins()
  await kit.showInfo({
    title: "Plugins",
    message: "The plugin manager edits raw plugin arrays per file. Open it from the studio main menu.",
  })
}
