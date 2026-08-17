/**
 * Provider-catalog cache.
 *
 * `client.provider.list()` is the slow leg of every studio open (in-process
 * round-trip; the server re-assembles the merged catalog). The catalog can
 * only change when (a) config files change or (b) the server-side
 * models.dev/remote layers drift. We already parse and merge all config
 * files on every open, so the merged-config content hash is a precise
 * invalidation key for (a); a TTL fallback bounds staleness for (b).
 */

import { stableStringify } from "./jsonc.js"
import type { ProvenancedMerge } from "./discovery.js"

export type ProviderSnapshot<T> = {
  providers: T[]
  defaults: Record<string, string>
  source: "provider-list" | "config-providers" | "state"
}

const PROVIDER_CACHE_TTL_MS = 5 * 60 * 1000

let cache: { key: string; at: number; snapshot: ProviderSnapshot<unknown> } | undefined

/** Content-hash key: identical merged config => catalog cannot have changed via config. */
export function providerCacheKey(merge: ProvenancedMerge): string {
  return stableStringify(merge.merged)
}

export function getCachedProviders<T>(key: string, now = Date.now()): ProviderSnapshot<T> | undefined {
  if (!cache) return undefined
  if (cache.key !== key) return undefined
  if (now - cache.at > PROVIDER_CACHE_TTL_MS) return undefined
  return cache.snapshot as ProviderSnapshot<T>
}

export function setCachedProviders<T>(key: string, snapshot: ProviderSnapshot<T>, now = Date.now()): void {
  cache = { key, at: now, snapshot: snapshot as ProviderSnapshot<unknown> }
}

export function providerCacheState(): { key: string; ageMs: number } | undefined {
  return cache ? { key: cache.key, ageMs: Date.now() - cache.at } : undefined
}

export function clearProviderCache(): void {
  cache = undefined
}

// ---------------------------------------------------------------------------
// Save-time outside-change detection
// ---------------------------------------------------------------------------

export type OutsideChange = {
  path: string
  /** Line-level summary of what changed on disk since staging. */
  diffLines: string[]
}

/** First-diff summary: lines added/removed on disk relative to the staged base. */
export function summarizeOutsideChange(baseText: string, diskText: string, maxLines = 24): string[] {
  const base = baseText.split(/\r?\n/)
  const disk = diskText.split(/\r?\n/)
  const diffLines: string[] = []
  // Longest-common-prefix/suffix trim keeps the summary tight for big files.
  let start = 0
  while (start < base.length && start < disk.length && base[start] === disk[start]) start++
  let endBase = base.length
  let endDisk = disk.length
  while (endBase > start && endDisk > start && base[endBase - 1] === disk[endDisk - 1]) {
    endBase--
    endDisk--
  }
  const removed = base.slice(start, endBase)
  const added = disk.slice(start, endDisk)
  if (removed.length === 0 && added.length === 0) return diffLines
  diffLines.push(`changed around line ${start + 1}:`)
  for (const line of removed.slice(0, maxLines)) diffLines.push(`  - ${line.trim()}`)
  for (const line of added.slice(0, maxLines)) diffLines.push(`  + ${line.trim()}`)
  if (removed.length + added.length > maxLines * 2) diffLines.push(`  ... (${removed.length + added.length} changed lines total)`)
  return diffLines
}

/** Detects files that changed on disk after their staged base snapshot. */
export function detectOutsideChanges(
  bases: Map<string, string>,
  readDisk: (path: string) => string | undefined,
): OutsideChange[] {
  const result: OutsideChange[] = []
  for (const [path, baseText] of bases) {
    const diskText = readDisk(path)
    if (diskText === undefined) {
      result.push({ path, diffLines: ["file no longer readable"] })
      continue
    }
    if (diskText !== baseText) {
      const diffLines = summarizeOutsideChange(baseText, diskText)
      if (diffLines.length > 0) result.push({ path, diffLines })
    }
  }
  return result
}
