/**
 * OpenCode v2 TUI plugin implementation for Config Studio: builds a v1-shaped
 * TUI api facade over the v2 TUI context and reuses the studio's normal TUI
 * activation (exported from tui.tsx) so every screen, editor, and flow runs
 * unchanged on both hosts.
 *
 * Host-specific bridging:
 * - Dialogs: v1 exposes dialog components returning JSX rendered inside a
 *   `dialog.replace(render)` entry; v2 only offers promise dialogs that open
 *   their own host entry. The bridge invokes render thunks synchronously —
 *   JSX content becomes one dialog entry; nested DialogX bridges park the
 *   caller's onClose and settle it on dismiss (see v2-tui in agent-variants
 *   for the same pattern).
 * - Keymap: v1-style layers (commands with name/title/desc/run + bindings)
 *   convert to v2 named commands with comma-joined `bind` strings; v1-style
 *   palette commands (`namespace: "palette"`) map onto v2 palette/slash
 *   commands with `group` from `category`.
 * - Client: the studio code probes the v1 client surface (provider.list,
 *   config.providers, session.active/get/wait, global.dispose, mcp.status,
 *   tool.list/ids). The wrapper delegates to the v2 client and normalizes
 *   envelopes, composing the v1 provider catalog from v2 provider+model
 *   lists, mapping config reloads to location eviction, MCP status to
 *   mcp.list, and the tool registry to the studio server plugin's RPC.
 */

import { createSignal } from "solid-js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { join } from "node:path"
import { homedir } from "node:os"
import type { V2KeymapCommand, V2KeymapLayer, V2LocationRef, V2TuiContext, V2TuiSetup } from "./v2-types.js"
import { TOOL_RPC_ID, v2GlobalConfigDir } from "./v2-server.js"

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const handle = setTimeout(() => resolve(undefined), ms)
    ;(handle as unknown as { unref?: () => void }).unref?.()
    promise.then(
      (value) => {
        clearTimeout(handle)
        resolve(value)
      },
      () => {
        clearTimeout(handle)
        resolve(undefined)
      },
    )
  })
}

function pickThemeToken(source: unknown, ...path: Array<string | number>): unknown {
  let current: unknown = source
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

type V1LayerCommand = {
  name: string
  title?: string
  desc?: string
  category?: string
  namespace?: string
  slashName?: string
  run: (ctx: { event?: { preventDefault?: () => void; stopPropagation?: () => void } }) => void
}

type V1Layer = {
  mode?: string
  priority?: number
  commands: readonly V1LayerCommand[]
  bindings: readonly { key: string; cmd: string; desc?: string }[]
}

function convertKeymapLayer(layer: V1Layer): V2KeymapLayer {
  const bindingsByName = new Map<string, string[]>()
  for (const binding of layer.bindings ?? []) {
    if (!binding?.cmd) continue
    const keys = bindingsByName.get(binding.cmd) ?? []
    keys.push(binding.key)
    bindingsByName.set(binding.cmd, keys)
  }
  const commands: V2KeymapCommand[] = (layer.commands ?? []).map((command) => {
    const palette = command.namespace === "palette"
    const v2: V2KeymapCommand = {
      id: command.name,
      title: command.title ?? command.name,
      description: command.desc,
      ...(palette ? { palette: true as const } : {}),
      ...(palette && command.slashName ? { slash: { name: command.slashName } } : {}),
      ...(palette && command.category ? { group: command.category } : {}),
      ...(bindingsByName.get(command.name)?.length ? { bind: bindingsByName.get(command.name)!.join(",") } : {}),
      run: (_input?: string, event?: { preventDefault?: () => void; stopPropagation?: () => void }) =>
        command.run({
          event: event
            ? { preventDefault: () => event.preventDefault?.(), stopPropagation: () => event.stopPropagation?.() }
            : undefined,
        }),
    }
    return v2
  })
  return { mode: "global", priority: layer.priority, commands }
}

function unwrapLocation<T>(result: unknown): T | undefined {
  if (!result || typeof result !== "object") return undefined
  const record = result as { data?: unknown }
  return ("data" in record ? record.data : result) as T | undefined
}

/**
 * The wire `location` query uses `workspace`; the plugin-facing LocationRef
 * uses `workspaceID`. Translate at the boundary.
 */
function wireLocation(ref: { directory: string; workspaceID?: string } | undefined): Record<string, string> | undefined {
  if (!ref) return undefined
  return ref.workspaceID !== undefined ? { directory: ref.directory, workspace: ref.workspaceID } : { directory: ref.directory }
}

/** v1-shaped client facade over the v2 OpenCodeClient. */
function wrapV2Client(context: V2TuiContext) {
  const raw = context.client as any
  const location = () => {
    try {
      const ref = context.location ? (context.location as V2LocationRef) : context.data.location.default()
      return wireLocation(ref)
    } catch {
      return undefined
    }
  }
  const call = <T>(method: (() => Promise<T>) | undefined, fallback: T): Promise<T | undefined> => {
    if (typeof method !== "function") return Promise.resolve(fallback)
    return withTimeout(method.call(raw), 8000).then((value) => (value === undefined ? fallback : value))
  }

  const composeCatalog = async () => {
    const [providersResult, modelsResult, defaultResult] = await Promise.all([
      call<unknown[]>(() => raw?.provider?.list?.bind(raw.provider)({ location: location() }), []),
      call<unknown[]>(() => raw?.model?.list?.bind(raw.model)({ location: location() }), []),
      call<unknown>((() => raw?.model?.default?.bind(raw.model)) as () => Promise<unknown>, undefined as unknown),
    ])
    const providers = (unwrapLocation<unknown[]>(providersResult) ?? []) as Array<{ id: string; name?: string }>
    const models = (unwrapLocation<unknown[]>(modelsResult) ?? []) as Array<{
      providerID: string
      modelID?: string
      id?: string
      name?: string
      variants?: Array<{ id: string } | string>
    }>
    const byProvider = new Map<string, Record<string, unknown>>()
    for (const model of models) {
      if (!model?.providerID) continue
      const id = model.modelID ?? model.id ?? ""
      if (!id) continue
      const variants: Record<string, unknown> = {}
      for (const variant of model.variants ?? []) {
        const variantId = typeof variant === "string" ? variant : variant?.id
        if (variantId) variants[variantId] = {}
      }
      const bucket = byProvider.get(model.providerID) ?? {}
      bucket[id] = { id, name: model.name ?? id, ...(Object.keys(variants).length ? { variants } : {}) }
      byProvider.set(model.providerID, bucket)
    }
    const def = unwrapLocation<{ providerID: string; modelID?: string; id?: string }>(defaultResult)
    const defaults = def ? { [def.providerID]: def.modelID ?? def.id ?? "" } : {}
    const all = providers.map((provider) => ({
      id: provider.id,
      name: provider.name ?? provider.id,
      source: "api",
      env: [],
      options: {},
      models: byProvider.get(provider.id) ?? {},
    }))
    return { all, default: defaults }
  }

  const rpcTools = async (method: "tools" | "ids") => {
    try {
      const rpc = raw?.rpc
      const fn = rpc?.call?.bind(rpc)
      if (typeof fn !== "function") return undefined
      const result = await withTimeout(fn({ rpcID: TOOL_RPC_ID, method, input: {}, location: location() }), 8000)
      const output = (result as { output?: unknown })?.output ?? (result as { data?: { output?: unknown } })?.data?.output ?? result
      return (output as { tools?: unknown[]; ids?: string[] } | undefined) ?? undefined
    } catch {
      return undefined
    }
  }

  return {
    __v2: true as const,
    raw,
    provider: {
      list: async () => ({ data: await composeCatalog() }),
    },
    config: {
      get: async (input?: unknown) => {
        const fn = raw?.config?.get?.bind(raw.config)
        if (typeof fn !== "function") return undefined
        return fn(input ?? { location: location() })
      },
      providers: async () => {
        const catalog = await composeCatalog()
        return { data: { providers: catalog.all, default: catalog.default } }
      },
    },
    session: {
      active: async () => ({ data: await raw.session.active() }),
      get: async (args: { sessionID: string }) => ({ data: await raw.session.get(args) }),
      wait: async (args: { sessionID: string }) => raw.session.wait(args),
    },
    global: {
      // v2 replaces the v1 config dispose with per-location eviction.
      dispose: async () => {
        const debug = raw?.debug
        const evict = debug?.location?.evict?.bind(debug.location)
        if (typeof evict !== "function") return undefined
        return evict({ location: location() })
      },
    },
    mcp: {
      status: async () => {
        const fn = raw?.mcp?.list?.bind(raw.mcp)
        if (typeof fn !== "function") return { data: {} }
        const result = await withTimeout(fn({ location: location() }), 8000)
        const servers = ((unwrapLocation(result) ?? []) as Array<{ name: string; status?: { status?: string; error?: string } }>).filter(Boolean)
        const map: Record<string, { status?: string; error?: string }> = {}
        for (const server of servers) {
          map[server.name] = {
            status: server.status?.status,
            ...(typeof server.status?.error === "string" ? { error: server.status.error } : {}),
          }
        }
        return { data: map }
      },
    },
    tool: {
      list: async () => {
        const output = await rpcTools("tools")
        return { data: output?.tools ?? [] }
      },
      ids: async () => {
        const output = await rpcTools("ids")
        return { data: output?.ids ?? [] }
      },
    },
  }
}

/** Builds the v1-shaped TUI api facade over a v2 TUI plugin context. */
export function buildStudioV2Api(context: V2TuiContext): TuiPluginApi {
  const disposeFns: Array<() => void> = []
  const locationRef = () => {
    try {
      return context.location ? (context.location as V2LocationRef) : context.data.location.default()
    } catch {
      return undefined
    }
  }
  // Project root for discovery walk-up: resolved from the server's location
  // info once available (v1's host supplied the true worktree root).
  let projectRootCache: string | undefined

  const [kvStore, kvMutate] = context.storage.store("kv", { initial: {} as Record<string, unknown> })
  const kvMirror: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(kvStore as Record<string, unknown>)) kvMirror[key] = value

  let configDocsCache: { pluginEntries: unknown[]; defaultAgent?: string; mcp: Record<string, unknown> } = {
    pluginEntries: [],
    mcp: {},
  }
  const refreshConfigDocs = async () => {
    try {
      const fn = (context.client as any)?.config?.get
      if (typeof fn !== "function") return
      const result = await withTimeout(fn.call(context.client, { location: wireLocation(locationRef()) }), 5000)
      const docs = Array.isArray(result) ? result : ((result as { data?: unknown[] })?.data ?? [])
      const pluginEntries: unknown[] = []
      const mcp: Record<string, unknown> = {}
      let defaultAgent: string | undefined
      for (const doc of docs as Array<{ type?: string; info?: Record<string, unknown> }>) {
        if (doc?.type !== "document" || !doc.info) continue
        if (typeof doc.info.default_agent === "string") defaultAgent = doc.info.default_agent
        const plugins = (doc.info.plugins ?? doc.info.plugin) as unknown
        if (Array.isArray(plugins)) {
          for (const entry of plugins) {
            if (typeof entry === "string") pluginEntries.push(entry)
            else if (entry && typeof entry === "object" && typeof (entry as { package?: unknown }).package === "string") {
              pluginEntries.push((entry as { package: string }).package)
            }
          }
        }
        const mcpConfig = doc.info.mcp as Record<string, unknown> | undefined
        const servers = (mcpConfig?.["servers"] ?? mcpConfig) as Record<string, Record<string, unknown>> | undefined
        if (servers && typeof servers === "object") {
          for (const [name, server] of Object.entries(servers)) {
            if (!server || typeof server !== "object") continue
            mcp[name] = { ...server, disabled: undefined, enabled: server["disabled"] === true ? false : true }
          }
        }
      }
      configDocsCache = { pluginEntries, defaultAgent, mcp }
    } catch {
      /* keep previous cache */
    }
  }

  const buildProviderList = () => {
    const providers = context.data.location.provider.list() ?? []
    const models = context.data.location.model.list() ?? []
    const byProvider = new Map<string, Record<string, unknown>>()
    for (const model of models) {
      if (!model?.providerID) continue
      const id = model.modelID ?? model.id ?? ""
      if (!id) continue
      const variants: Record<string, unknown> = {}
      for (const variant of model.variants ?? []) {
        const variantId = typeof variant === "string" ? variant : variant?.id
        if (variantId) variants[variantId] = {}
      }
      const bucket = byProvider.get(model.providerID) ?? {}
      bucket[id] = { id, name: model.name ?? id, ...(Object.keys(variants).length ? { variants } : {}) }
      byProvider.set(model.providerID, bucket)
    }
    return providers.map((provider) => ({
      id: provider.id,
      name: provider.name ?? provider.id,
      models: byProvider.get(provider.id) ?? {},
    }))
  }

  const state = {
    get config() {
      const agents = context.data.location.agent.list() ?? []
      const agentRecord: Record<string, any> = {}
      for (const agent of agents) {
        if (agent.hidden) continue
        agentRecord[agent.id] = {
          name: agent.name,
          mode: agent.mode,
          hidden: agent.hidden,
          color: agent.color,
          description: agent.description,
          prompt: agent.system,
          model: agent.model ? `${agent.model.providerID}/${agent.model.id}` : undefined,
        }
      }
      return {
        agent: agentRecord,
        default_agent: configDocsCache.defaultAgent,
        plugin: configDocsCache.pluginEntries,
        mcp: configDocsCache.mcp,
      }
    },
    get provider() {
      return buildProviderList()
    },
    get path() {
      const ref = locationRef()
      const dir = ref?.directory ?? process.cwd()
      return {
        config: v2GlobalConfigDir(),
        directory: dir,
        // The true project root once resolved; the session directory until
        // then so discovery still walks (at least) the launch directory.
        worktree: projectRootCache ?? dir,
      }
    },
  }

  const dialog = context.ui.dialog
  let nestedOnClose: (() => void) | undefined
  const settleNested = (dismissed: boolean) => {
    const onClose = nestedOnClose
    nestedOnClose = undefined
    if (dismissed) onClose?.()
  }

  const api = {
    hostVersion: 2 as const,
    app: { version: context.app?.version },
    client: wrapV2Client(context),
    kv: {
      get<Value = unknown>(key: string, fallback?: Value): Value {
        const value = key in kvMirror ? kvMirror[key] : (kvStore as Record<string, unknown>)[key]
        return (value === undefined ? fallback : value) as Value
      },
      set(key: string, value: unknown) {
        kvMirror[key] = value
        void kvMutate((draft) => {
          draft[key] = value
        }).catch(() => undefined)
      },
      ready: true,
    },
    lifecycle: {
      onDispose(fn: () => void) {
        disposeFns.push(fn)
      },
    },
    mode: {
      push(mode: string) {
        try {
          return context.keymap.mode.push(mode)
        } catch {
          return () => undefined
        }
      },
    },
    renderer: {
      get root() {
        return (context.renderer as { root?: unknown } | undefined)?.root
      },
    },
    state,
    theme: {
      get current() {
        const theme = context.theme
        const dark = context.themeMode === "dark"
        const text = pickThemeToken(theme, "text", "default")
        return {
          text,
          textMuted: pickThemeToken(theme, "text", "subdued") ?? text,
          background: pickThemeToken(theme, "background", "default"),
          backgroundPanel: pickThemeToken(theme, "background", "surface", "offset") ?? pickThemeToken(theme, "background", "default"),
          primary: pickThemeToken(theme, "text", "action", "primary", "selected") ?? text,
          secondary: pickThemeToken(theme, "hue", dark ? "interactive" : "neutral", dark ? 300 : 700) ?? text,
          accent: pickThemeToken(theme, "hue", "accent", dark ? 200 : 800) ?? text,
          success: pickThemeToken(theme, "text", "feedback", "success", "default") ?? text,
          warning: pickThemeToken(theme, "text", "feedback", "warning", "default") ?? text,
          error: pickThemeToken(theme, "text", "feedback", "error", "default") ?? text,
          info: pickThemeToken(theme, "text", "feedback", "info", "default") ?? text,
        }
      },
    },
    ui: {
      toast: (input: { variant?: string; title?: string; message: string; duration?: number }) => {
        try {
          context.ui.toast.show({ title: input.title, message: input.message, variant: input.variant, duration: input.duration })
        } catch {
          /* toasts must never crash the studio */
        }
      },
      dialog: {
        replace(renderer: unknown, onClose?: () => void) {
          nestedOnClose = undefined
          let content: unknown
          try {
            content = typeof renderer === "function" ? (renderer as () => unknown)() : renderer
          } catch {
            content = undefined
          }
          if (content === undefined || content === null) {
            nestedOnClose = onClose
            return
          }
          const element = content
          dialog.show(() => element, onClose)
        },
        clear() {
          nestedOnClose = undefined
          dialog.clear()
        },
        setSize(size: string) {
          try {
            dialog.set({ size })
          } catch {
            /* size hints are best-effort */
          }
        },
      },
      DialogSelect(props: {
        title: string
        placeholder?: string
        options: Array<{ title: string; value: unknown; description?: string; category?: string; disabled?: boolean }>
        current?: unknown
        onSelect: (option: { title: string; value: unknown; description?: string; category?: string }) => void
      }) {
        void dialog
          .select({
            title: props.title,
            placeholder: props.placeholder,
            current: props.current,
            options: props.options.map((option) => ({
              title: option.title,
              value: option.value,
              description: option.description,
              category: option.category,
              disabled: option.disabled,
            })),
          })
          .then((value) => {
            if (value === undefined) {
              settleNested(true)
              return
            }
            settleNested(false)
            const option = props.options.find((item) => item.value === value)
            if (option) props.onSelect(option)
          })
          .catch(() => settleNested(true))
      },
      DialogPrompt(props: { title: string; placeholder?: string; value?: string; onConfirm: (value: string) => void; onCancel?: () => void }) {
        void dialog
          .prompt({ title: props.title, placeholder: props.placeholder, value: props.value })
          .then((value) => {
            settleNested(value === undefined)
            if (value === undefined) props.onCancel?.()
            else props.onConfirm(value)
          })
          .catch(() => {
            settleNested(true)
            props.onCancel?.()
          })
      },
      DialogConfirm(props: { title: string; message: string; confirmLabel?: string; onConfirm: () => void; onCancel?: () => void }) {
        void dialog
          .confirm({ title: props.title, message: props.message, label: { confirm: props.confirmLabel } })
          .then((result) => {
            settleNested(result !== true)
            if (result === true) props.onConfirm()
            else props.onCancel?.()
          })
          .catch(() => {
            settleNested(true)
            props.onCancel?.()
          })
      },
      DialogAlert(props: { title: string; message: string; onConfirm?: () => void }) {
        void dialog
          .alert({ title: props.title, message: props.message })
          .then(() => {
            settleNested(false)
            props.onConfirm?.()
          })
          .catch(() => {
            settleNested(true)
            props.onConfirm?.()
          })
      },
    },
    keymap: {
      registerLayer(layer: V1Layer) {
        const [active, setActive] = createSignal(true)
        try {
          context.keymap.layer(() => (active() ? convertKeymapLayer(layer) : { mode: "global", enabled: false, commands: [], bindings: [] }))
        } catch {
          return () => undefined
        }
        return () => {
          setActive(false)
        }
      },
    },
  }

  return Object.assign(api as unknown as TuiPluginApi, {
    __studioV2DisposeFns: disposeFns,
    __studioV2RefreshConfigDocs: refreshConfigDocs,
    __studioV2StartupSync: async () => {
      try {
        await withTimeout(context.data.location.sync(locationRef()), 8000)
      } catch {
        /* stores may still be syncing */
      }
      // Resolve the true project root for the discovery walk-up.
      try {
        const get = (context.client as any)?.location?.get
        if (typeof get === "function") {
          const info = unwrapLocation<{ directory: string; project?: { directory?: string } }>(
            await withTimeout(get.call(context.client, { location: wireLocation(locationRef()) }), 5000),
          )
          const root = info?.project?.directory ?? info?.directory
          if (typeof root === "string" && root.length > 0) projectRootCache = root
        }
      } catch {
        /* keep the directory fallback */
      }
      await refreshConfigDocs()
    },
  }) as TuiPluginApi & {
    __studioV2DisposeFns: Array<() => void>
    __studioV2RefreshConfigDocs: () => Promise<void>
    __studioV2StartupSync: () => Promise<void>
  }
}

/**
 * v2 TUI setup: builds the adapter, runs the shared studio activation
 * (injected from tui.tsx to avoid an import cycle), and returns cleanup.
 */
export function createStudioTuiSetup(studioActivation: (api: TuiPluginApi) => Promise<void>): V2TuiSetup {
  return async (context: V2TuiContext) => {
    const api = buildStudioV2Api(context)
    const extended = api as typeof api & { __studioV2DisposeFns: Array<() => void>; __studioV2StartupSync: () => Promise<void> }
    try {
      await studioActivation(api)
    } catch {
      /* activation failures must not break the host */
    }
    // Prime the v2 data stores + config docs + project root so the first
    // studio open sees plugin entries, the default agent, and the full
    // config layer set (fire-and-forget; screens degrade gracefully).
    void extended.__studioV2StartupSync()
    return () => {
      for (const dispose of extended.__studioV2DisposeFns) {
        try {
          dispose()
        } catch {
          /* disposal must not throw */
        }
      }
    }
  }
}
