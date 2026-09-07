import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

/**
 * Deferred config reload.
 *
 * `global.dispose()` reloads OpenCode config live, but it interrupts running
 * sessions (drains are aborted). The coordinator defers the dispose until no
 * sessions are actively running:
 *
 * - requestReload(): empty `session.active()` map -> dispose now (old behavior);
 *   sessions running OR detection failed -> mark pending + start the watcher.
 * - The watcher NEVER stops until the reload applies or is cancelled: every
 *   cycle fully re-fetches the active set (new sessions included), waits on
 *   the known sessions with a 30s cap per round, and retries detection or
 *   dispose failures on an escalating 5s->30s interval forever. It holds off
 *   while a Config Studio flow is open (dispose would tear the studio dialogs
 *   down mid-display).
 * - reloadNow(): forces the dispose immediately (used by the red post-save
 *   shortcut and the manual menu entries, both behind user confirmation).
 */

export type RunningSession = {
  id: string
  title?: string
  agent?: string
  model?: string
  directory?: string
  parentID?: string
}

export type ReloadRequestResult =
  | { kind: "reloaded" }
  | { kind: "deferred"; active: number; detectionFailed: boolean }

type PendingState = { since: number; active: number }

const CALL_TIMEOUT = 3000
// Full revalidation cadence: per-session waits are capped so the watcher
// re-fetches the ENTIRE active set at least every 30s - sessions that started
// since the last check are picked up, never only the previously-known list.
const WAIT_TIMEOUT = 30000
const STUDIO_HOLD_POLL = 5000
const FAILURE_BASE = 5000
const FAILURE_MAX = 30000

let pending: PendingState | undefined
let watching = false
let studioDepth = 0
let timings = { studioHoldPoll: STUDIO_HOLD_POLL, failureBase: FAILURE_BASE, failureMax: FAILURE_MAX }

/** Test seam: shrink watcher sleep intervals so failure/recovery paths are testable. */
export function __testSetTimings(next: { studioHoldPoll?: number; failureBase?: number; failureMax?: number }): void {
  timings = { ...timings, ...next }
}

function callWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number = CALL_TIMEOUT): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    let settled = false
    const done = (value: T | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => done(undefined), timeoutMs)
    if (typeof timer === "object" && timer && "unref" in timer) (timer as { unref(): void }).unref()
    fn().then(
      (value) => done(value),
      () => done(undefined),
    )
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), ms)
    if (typeof timer === "object" && timer && "unref" in timer) (timer as { unref(): void }).unref()
  })
}

function sessionClient(api: TuiPluginApi): Record<string, unknown> | undefined {
  const client = (api as { client?: unknown }).client
  if (!client || typeof client !== "object") return undefined
  const session = (client as { session?: unknown }).session
  if (!session || typeof session !== "object") return undefined
  return session as Record<string, unknown>
}

/**
 * IDs of currently running sessions; `undefined` when detection failed.
 * The host client's session surface varies by OpenCode version, so probe in
 * order: session.active() (newest, map of running drains) then
 * session.status() (older, sessionID -> idle|retry|busy; busy/retry count as
 * running). All calls stay attached to their namespace object - SDK methods
 * are class methods that dereference `this`, so detaching them throws.
 */
export async function fetchActiveSessions(api: TuiPluginApi): Promise<string[] | undefined> {
  const session = sessionClient(api)
  if (!session) return undefined
  const active = session["active"]
  if (typeof active === "function") {
    const result = await callWithTimeout(() => (active as (args?: unknown) => Promise<unknown>).call(session))
    const data = result && typeof result === "object" ? (result as { data?: unknown }).data : undefined
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return Object.keys(data as Record<string, unknown>)
    }
  }
  const status = session["status"]
  if (typeof status === "function") {
    const result = await callWithTimeout(() => (status as (args?: unknown) => Promise<unknown>).call(session))
    const data = result && typeof result === "object" ? (result as { data?: unknown }).data : undefined
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const running: string[] = []
      for (const [id, value] of Object.entries(data as Record<string, unknown>)) {
        const type = value && typeof value === "object" ? (value as { type?: unknown }).type : value
        if (type === undefined || type === "busy" || type === "retry") running.push(id)
      }
      return running
    }
  }
  return undefined
}

/** Details of running sessions for confirmation dialogs. */
export async function fetchRunningSessions(api: TuiPluginApi): Promise<RunningSession[] | undefined> {
  const ids = await fetchActiveSessions(api)
  if (ids === undefined) return undefined
  const session = sessionClient(api)
  const get = session?.get
  const sessions: RunningSession[] = []
  for (const id of ids) {
    if (typeof get !== "function") {
      sessions.push({ id })
      continue
    }
    const result = await callWithTimeout(() => (get as (args: unknown) => Promise<unknown>).call(session, { sessionID: id }))
    const info = result && typeof result === "object" ? (result as { data?: unknown }).data : undefined
    const record = info && typeof info === "object" ? (info as Record<string, unknown>) : undefined
    const model = record?.model
    const modelRef =
      model && typeof model === "object"
        ? [((model as Record<string, unknown>).providerID as string | undefined), ((model as Record<string, unknown>).id as string | undefined)].filter(Boolean).join("/") || undefined
        : undefined
    sessions.push({
      id,
      title: typeof record?.title === "string" ? (record.title as string) : undefined,
      agent: typeof record?.agent === "string" ? (record.agent as string) : undefined,
      model: modelRef,
      directory: typeof record?.directory === "string" ? (record.directory as string) : undefined,
      parentID: typeof record?.parentID === "string" ? (record.parentID as string) : undefined,
    })
  }
  return sessions
}export function pendingReload(): PendingState | undefined {
  return pending
}

export function beginStudioFlow(): void {
  studioDepth++
}

export function endStudioFlow(): void {
  studioDepth = Math.max(0, studioDepth - 1)
}

async function disposeNow(api: TuiPluginApi): Promise<boolean> {
  const client = (api as { client?: unknown }).client
  if (!client || typeof client !== "object") return false
  // The dispose namespace moved between SDK generations (global -> instance).
  // Methods MUST be called on their namespace object - they are class methods
  // that dereference `this`; a detached call throws immediately.
  for (const namespace of ["global", "instance"] as const) {
    const group = (client as Record<string, unknown>)[namespace]
    if (!group || typeof group !== "object") continue
    const dispose = (group as Record<string, unknown>)["dispose"]
    if (typeof dispose !== "function") continue
    try {
      await (dispose as (args?: unknown) => Promise<unknown>).call(group)
      return true
    } catch {
      return false
    }
  }
  return false
}

/**
 * Disposes immediately (manual force). Pending state is only cleared when the
 * dispose actually succeeded - on failure the never-stop watcher keeps the
 * deferred reload alive. Returns whether the dispose call succeeded.
 */
export async function reloadNow(api: TuiPluginApi): Promise<boolean> {
  const ok = await disposeNow(api)
  if (ok) pending = undefined
  return ok
}

/** Drops the pending auto-reload without disposing. */
export function cancelPendingReload(): void {
  pending = undefined
}

function escalatedDelay(failures: number): number {
  // 5s, 10s, 20s, 30s cap - retries never stop, they only slow down.
  const steps = [timings.failureBase, timings.failureBase * 2, timings.failureBase * 4]
  return Math.min(steps[Math.min(failures - 1, steps.length - 1)] ?? timings.failureMax, timings.failureMax)
}

/**
 * Watch loop: NEVER stops until the reload applies or is cancelled.
 * Every cycle fully re-fetches the active set (a session that started since
 * the last check is included, not just the previously-known list). Per-session
 * waits are capped at WAIT_TIMEOUT so a full revalidation happens at least
 * every ~30s even while sessions keep running. Detection and dispose failures
 * back off (escalatedDelay) and retry forever.
 */
async function watchUntilApplied(api: TuiPluginApi): Promise<"applied" | "cancelled"> {
  const session = sessionClient(api)
  const wait = session?.wait
  let failures = 0
  let disposeWarned = false
  for (;;) {
    if (!pending) return "cancelled"
    if (studioDepth > 0) {
      await sleep(timings.studioHoldPoll)
      continue
    }
    const ids = await fetchActiveSessions(api)
    if (ids === undefined) {
      failures++
      await sleep(escalatedDelay(failures))
      continue
    }
    if (ids.length === 0) {
      const ok = await disposeNow(api)
      if (ok) return "applied"
      if (!disposeWarned) {
        disposeWarned = true
        try {
          ;(api as { ui?: { toast?: (input: unknown) => unknown } }).ui?.toast?.({ variant: "warning", title: "Config Studio", message: "Config reload failed - retrying every 30s until it applies" })
        } catch {
          // best effort
        }
      }
      failures++
      await sleep(escalatedDelay(failures))
      continue
    }
    failures = 0
    disposeWarned = false
    pending = { since: pending.since, active: ids.length }
    if (typeof wait !== "function") {
      // No long-poll surface: plain interval polling.
      await sleep(Math.min(timings.failureMax, WAIT_TIMEOUT))
      continue
    }
    await Promise.all(
      ids.map((id) => callWithTimeout(() => (wait as (args: unknown) => Promise<unknown>).call(session, { sessionID: id }), WAIT_TIMEOUT)),
    )
  }
}

async function startWatcher(api: TuiPluginApi): Promise<void> {
  if (watching) return
  watching = true
  try {
    const outcome = await watchUntilApplied(api)
    if (outcome === "applied") {
      pending = undefined
      try {
        ;(api as { ui?: { toast?: (input: unknown) => unknown } }).ui?.toast?.({
          variant: "success",
          title: "Config Studio",
          message: "Config reloaded - all sessions finished",
        })
      } catch {
        // best effort
      }
    }
  } finally {
    watching = false
  }
}

/**
 * Requests a config reload, deferring while sessions run.
 * - no running sessions (verified) -> dispose immediately, `{kind: "reloaded"}`
 * - sessions running OR detection failed -> pending + watcher, `{kind: "deferred"}`
 */
export async function requestReload(api: TuiPluginApi): Promise<ReloadRequestResult> {
  const ids = await fetchActiveSessions(api)
  if (ids !== undefined && ids.length === 0) {
    const ok = await disposeNow(api)
    if (ok) {
      pending = undefined
      return { kind: "reloaded" }
    }
    // Dispose failed (busy instance): hand it to the never-stop watcher.
    pending = { since: Date.now(), active: 0 }
    void startWatcher(api)
    return { kind: "deferred", active: 0, detectionFailed: false }
  }
  pending = { since: Date.now(), active: ids?.length ?? 0 }
  void startWatcher(api)
  return { kind: "deferred", active: ids?.length ?? 0, detectionFailed: ids === undefined }
}

/** Test seam: injects/removes the pending state without side effects. */
export function __testSetPending(state: { since: number; active: number } | undefined): void {
  pending = state
}

/** Test seam: resets coordinator module state between test cases. */
export function __testReset(): void {
  pending = undefined
  watching = false
  studioDepth = 0
}

/** Test seam: whether a watcher loop is currently active. */
export function __testWatching(): boolean {
  return watching
}
