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
 * - The watcher long-polls `session.wait()` per running session, re-checks
 *   `session.active()` (new sessions may start), and disposes once idle.
 *   It holds off while a Config Studio flow is open (dispose would tear the
 *   studio dialogs down mid-display) and gives up after repeated failures,
 *   leaving the pending state + manual reload available.
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
const WAIT_TIMEOUT = 300000
const STUDIO_HOLD_POLL = 5000
const FAILURE_RETRY = 10000
const MAX_CONSECUTIVE_FAILURES = 5

let pending: PendingState | undefined
let watching = false
let studioDepth = 0

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

/** IDs of currently running sessions; `undefined` when detection failed. */
export async function fetchActiveSessions(api: TuiPluginApi): Promise<string[] | undefined> {
  const session = sessionClient(api)
  const active = session?.active
  if (typeof active !== "function") return undefined
  const result = await callWithTimeout(() => (active as () => Promise<unknown>).call(session))
  if (!result || typeof result !== "object") return undefined
  const data = (result as { data?: unknown }).data
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined
  return Object.keys(data as Record<string, unknown>)
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
}

export function pendingReload(): PendingState | undefined {
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
  const dispose = client && typeof client === "object" ? (client as { global?: { dispose?: unknown } }).global?.dispose : undefined
  if (typeof dispose !== "function") return false
  try {
    await (dispose as () => Promise<unknown>)()
    return true
  } catch {
    return false
  }
}

/** Disposes immediately; clears any pending auto-reload. Returns whether the dispose call succeeded. */
export async function reloadNow(api: TuiPluginApi): Promise<boolean> {
  pending = undefined
  return disposeNow(api)
}

/** Drops the pending auto-reload without disposing. */
export function cancelPendingReload(): void {
  pending = undefined
}

async function watchUntilIdle(api: TuiPluginApi): Promise<"idle" | "cancelled" | "gave-up"> {
  const session = sessionClient(api)
  const wait = session?.wait
  let failures = 0
  for (;;) {
    if (!pending) return "cancelled"
    if (studioDepth > 0) {
      await sleep(timings.studioHoldPoll)
      continue
    }
    const ids = await fetchActiveSessions(api)
    if (ids === undefined) {
      failures++
      if (failures >= MAX_CONSECUTIVE_FAILURES) return "gave-up"
      await sleep(timings.failureRetry)
      continue
    }
    failures = 0
    if (ids.length === 0) return "idle"
    pending = { since: pending.since, active: ids.length }
    if (typeof wait !== "function") {
      await sleep(timings.failureRetry)
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
    const outcome = await watchUntilIdle(api)
    if (outcome === "idle") {
      pending = undefined
      const toast = (api as { ui?: { toast?: (input: unknown) => unknown } }).ui?.toast
      const reloaded = await disposeNow(api)
      try {
        toast?.({
          variant: reloaded ? "success" : "warning",
          title: "Config Studio",
          message: reloaded ? "Config reloaded - all sessions finished" : "Config reload failed - reload manually from the studio menu",
        })
      } catch {
        // best effort
      }
    } else if (outcome === "gave-up") {
      const toast = (api as { ui?: { toast?: (input: unknown) => unknown } }).ui?.toast
      try {
        toast?.({ variant: "warning", title: "Config Studio", message: "Auto-reload watch failed - reload manually when ready" })
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
    pending = undefined
    await disposeNow(api)
    return { kind: "reloaded" }
  }
  pending = { since: Date.now(), active: ids?.length ?? 0 }
  void startWatcher(api)
  return { kind: "deferred", active: ids?.length ?? 0, detectionFailed: ids === undefined }
}

let timings = { studioHoldPoll: STUDIO_HOLD_POLL, failureRetry: FAILURE_RETRY }

/** Test seam: shrink watcher sleep intervals so failure/hold paths are testable. */
export function __testSetTimings(next: { studioHoldPoll?: number; failureRetry?: number }): void {
  timings = { ...timings, ...next }
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
