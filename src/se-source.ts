/**
 * Subagent Explorer implementation source resolution.
 *
 * The studio embeds a bundled copy of the subagent-explorer wizard library,
 * but can instead load the wizard from a standalone subagent-explorer plugin
 * install (any release channel: @latest, @dev, an exact version, or a local
 * file:// checkout). This lets the studio drive exactly the version the user
 * pinned while the embedded copy stays the fallback.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type * as EmbeddedWizard from "@mirrowel/opencode-subagent-explorer/wizard"
import type { TuiHostApi } from "@mirrowel/opencode-subagent-explorer/tui-host"
import * as embeddedWizardModule from "@mirrowel/opencode-subagent-explorer/wizard"

const SE_NPM = "@mirrowel/opencode-subagent-explorer"

export type SeWizardHostApi = TuiHostApi

export type SeImplementation = {
  wizard: typeof EmbeddedWizard
  origin: { kind: "embedded" } | { kind: "standalone"; spec: string; dir: string; version: string }
}

const embedded: SeImplementation = {
  wizard: embeddedWizardModule,
  origin: { kind: "embedded" },
}

let active: SeImplementation | undefined

export function seSourceKind(): "embedded" | "standalone" {
  return active?.origin.kind ?? "embedded"
}

export function seOrigin(): string {
  if (!active || active.origin.kind === "embedded") {
    let dep: string | undefined
    try {
      const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { dependencies?: Record<string, string> }
      dep = manifest.dependencies?.[SE_NPM]
    } catch {
      dep = undefined
    }
    return `embedded (bundled ${SE_NPM}${dep ? ` dep ${dep}` : ""})`
  }
  return `standalone ${active.origin.spec} (version ${active.origin.version})`
}

/** Currently active implementation (embedded until refreshed). */
export function se(): SeImplementation {
  return active ?? embedded
}

export function isStandaloneSubagentExplorerSpec(spec: unknown): spec is string {
  if (typeof spec !== "string" || spec.length === 0) return false
  if (spec === SE_NPM || spec.startsWith(`${SE_NPM}@`)) return true
  if (!spec.startsWith("file:")) return false
  try {
    const path = fileURLToPath(spec).replace(/\\/g, "/").toLowerCase()
    return path.endsWith("/opencode-subagent-explorer") || path.endsWith("/subagent-explorer")
  } catch {
    return false
  }
}

/** Sanitizes a spec the way OpenCode's Npm cache does (Windows-illegal chars). */
function sanitizeSpec(spec: string): string {
  const illegal = new Set(["<", ">", ":", '"', "|", "?", "*"])
  return Array.from(spec, (char) => (illegal.has(char) || char.charCodeAt(0) < 32 ? "_" : char)).join("")
}

function packageJsonExists(dir: string): boolean {
  return existsSync(join(dir, "package.json"))
}

function unwrapCacheDir(dir: string): string {
  // OpenCode's package cache stores wrapper dirs: the wrapper's package.json
  // only declares the dependency; the real package is nested under
  // node_modules/<name>. Descend when the wrapper is not the package itself.
  try {
    const readName = (candidate: string) => {
      try {
        return (JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as { name?: string }).name
      } catch {
        return undefined
      }
    }
    if (readName(dir) !== SE_NPM) {
      const nested = join(dir, "node_modules", SE_NPM)
      if (readName(nested) === SE_NPM) return nested
    }
  } catch {
    /* fall through */
  }
  return dir
}

function v2CacheRoot(): string {
  return join(process.env["XDG_CACHE_HOME"] ?? join(process.env["HOME"] ?? process.env["USERPROFILE"] ?? "", ".cache"), "opencode", "npm")
}

function resolveStandaloneDir(spec: string): string | undefined {
  try {
    if (spec.startsWith("file://")) {
      const path = fileURLToPath(spec)
      return packageJsonExists(path) ? unwrapCacheDir(path) : undefined
    }
    if (/^([a-zA-Z]:[\\/]|\/)/.test(spec)) {
      return packageJsonExists(spec) ? unwrapCacheDir(spec) : undefined
    }
    const base = join(process.env["XDG_CACHE_HOME"] ?? join(process.env["HOME"] ?? process.env["USERPROFILE"] ?? "", ".cache"), "opencode", "packages")
    const normalized = spec.startsWith("@mirrowel") && !spec.includes("@", 1) ? `${spec}@latest` : spec
    const direct = join(base, ...sanitizeSpec(normalized).split("/"))
    if (packageJsonExists(direct)) return unwrapCacheDir(direct)
    const family = join(base, "@mirrowel")
    if (!existsSync(family)) return probeV2(family, normalized)
    const prefix = "opencode-subagent-explorer"
    let entries: string[]
    try {
      entries = readdirSync(family).filter((entry) => entry === prefix || entry.startsWith(`${prefix}@`))
    } catch {
      return probeV2(family, normalized)
    }
    if (entries.length === 0) return probeV2(family, normalized)
    const wanted = normalized.split("@").slice(1).join("@") || "latest"
    const pick =
      entries.find((entry) => entry === `${prefix}@${wanted}`) ??
      entries.find((entry) => entry === `${prefix}@dev`) ??
      entries.find((entry) => entry === `${prefix}@latest`) ??
      entries[0]!
    const dir = join(family, pick)
    return packageJsonExists(dir) ? unwrapCacheDir(dir) : undefined
  } catch {
    return undefined
  }
}

/** v2 cache layout: ~/.cache/opencode/npm/&lt;sanitized spec&gt;/&lt;gen#&gt;/node_modules/&lt;pkg&gt; */
function probeV2(familyDir: string, normalized: string): string | undefined {
  void familyDir
  try {
    const root = v2CacheRoot()
    if (!existsSync(root)) return undefined
    const specDir = join(root, sanitizeSpec(normalized))
    if (!existsSync(specDir)) return undefined
    const generations = readdirSync(specDir).filter((entry) => /^[0-9]+$/.test(entry)).map(Number)
    if (generations.length === 0) return undefined
    const dir = join(specDir, String(Math.max(...generations)), "node_modules", SE_NPM)
    return packageJsonExists(dir) ? dir : undefined
  } catch {
    return undefined
  }
}

async function loadFromDir(spec: string, dir: string): Promise<SeImplementation | undefined> {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string }
    const wizardURL = pathToFileURL(join(dir, "dist", "wizard.js")).href
    const wizard = (await import(`${wizardURL}?${Date.now()}`)) as typeof EmbeddedWizard
    if (typeof wizard.mainMenu !== "function") return undefined
    return { wizard, origin: { kind: "standalone", spec, dir, version: manifest.version ?? "unknown" } }
  } catch {
    return undefined
  }
}

export type SeRefreshResult = { ok: boolean; origin: string; error?: string }

/**
 * Points the studio's Subagent Explorer module at the configured
 * implementation: "standalone" resolves the standalone spec from the plugin
 * array; anything else (or a failed resolution) falls back to the embedded
 * copy. Local checkouts win over npm installs when both are registered.
 */
export async function refreshSeSource(source: "embedded" | "standalone", pluginSpecs: string[]): Promise<SeRefreshResult> {
  if (source !== "standalone") {
    active = undefined
    return { ok: true, origin: seOrigin() }
  }
  const candidates = pluginSpecs.filter((entry) => isStandaloneSubagentExplorerSpec(entry))
  const ordered = [
    ...candidates.filter((entry) => entry.startsWith("file:") || /^([a-zA-Z]:[\\/]|\/)/.test(entry)),
    ...candidates.filter((entry) => !(entry.startsWith("file:") || /^([a-zA-Z]:[\\/]|\/)/.test(entry))),
  ]
  if (ordered.length === 0) {
    active = undefined
    return { ok: false, origin: seOrigin(), error: "No standalone subagent-explorer plugin entry found in any config file; using the embedded copy." }
  }
  const errors: string[] = []
  for (const spec of ordered) {
    const dir = resolveStandaloneDir(spec)
    if (!dir) {
      errors.push(`"${spec}" is not installed yet (restart OpenCode to install it)`)
      continue
    }
    const impl = await loadFromDir(spec, dir)
    if (!impl) {
      errors.push(`"${spec}" could not be loaded (missing or incompatible dist/wizard.js - if the cached copy is stale, pin an exact version or clear the cache)`)
      continue
    }
    active = impl
    return { ok: true, origin: seOrigin() }
  }
  active = undefined
  return { ok: false, origin: seOrigin(), error: `${errors.join("; ")}; using the embedded copy.` }
}
