/**
 * Agent Variants implementation source resolution.
 *
 * The studio embeds a bundled copy of the agent-variants wizard library, but
 * can instead load the wizard/config from a standalone agent-variants plugin
 * install (any release channel: @latest, @dev, an exact version, or a local
 * file:// checkout). This lets the studio drive exactly the version the user
 * pinned while the embedded copy stays the fallback.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type * as EmbeddedWizard from "@mirrowel/opencode-agent-variants/wizard"
import type * as EmbeddedConfig from "@mirrowel/opencode-agent-variants/config"
import { isStandaloneAgentVariantsSpec } from "./standalone.js"
import * as embeddedWizardModule from "@mirrowel/opencode-agent-variants/wizard"
import * as embeddedConfigModule from "@mirrowel/opencode-agent-variants/config"

export type AvImplementation = {
  wizard: typeof EmbeddedWizard
  config: typeof EmbeddedConfig
  /** Where this implementation was loaded from. */
  origin: { kind: "embedded" } | { kind: "standalone"; spec: string; dir: string; version: string }
}

const embedded: AvImplementation = {
  wizard: embeddedWizardModule,
  config: embeddedConfigModule,
  origin: { kind: "embedded" },
}

let active: AvImplementation | undefined

export function avSourceKind(): "embedded" | "standalone" {
  return active?.origin.kind ?? "embedded"
}

export function avOrigin(): string {
  if (!active || active.origin.kind === "embedded") {
    return `embedded (bundled @mirrowel/opencode-agent-variants${readOwnDependency() ? ` dep ${readOwnDependency()}` : ""})`
  }
  return `standalone ${active.origin.spec} (version ${active.origin.version})`
}

/** Currently active implementation (embedded until refreshed). */
export function av(): AvImplementation {
  return active ?? embedded
}

function readOwnDependency(): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { dependencies?: Record<string, string> }
    return manifest.dependencies?.["@mirrowel/opencode-agent-variants"]
  } catch {
    return undefined
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

/**
 * Resolves the on-disk directory of a standalone agent-variants plugin spec:
 * file:// (or absolute) paths resolve directly; npm specs resolve against
 * OpenCode's package cache (~/.cache/opencode/packages/&lt;spec&gt;).
 */
const AV_PACKAGE_NAME = "@mirrowel/opencode-agent-variants"

function readPackageName(dir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string }
    return manifest.name
  } catch {
    return undefined
  }
}

/**
 * OpenCode's package cache stores npm specs as wrapper directories whose
 * package.json only declares a dependency on the real package; the install
 * itself lives at node_modules/<name>. Descend when we landed on a wrapper.
 */
function unwrapCacheDir(dir: string): string {
  if (readPackageName(dir) === AV_PACKAGE_NAME) return dir
  const nested = join(dir, "node_modules", ...AV_PACKAGE_NAME.split("/"))
  if (readPackageName(nested) === AV_PACKAGE_NAME) return nested
  return dir
}

/** v2 cache layout: ~/.cache/opencode/npm/<sanitized name@spec>/<generation>/… */
function probeV2KeyDir(keyDir: string): string | undefined {
  try {
    if (!existsSync(keyDir)) return undefined
    // Numbered generation directories; the highest number is the newest.
    // A generation is an install root (node_modules/ inside, sometimes with
    // a wrapper package.json) — unwrapCacheDir descends to the real package.
    let generations: number[] = []
    try {
      generations = readdirSync(keyDir)
        .map((entry) => Number.parseInt(entry, 10))
        .filter((value) => Number.isFinite(value) && existsSync(join(keyDir, String(value))))
    } catch {
      generations = []
    }
    if (generations.length > 0) {
      const dir = join(keyDir, String(Math.max(...generations)))
      if (packageJsonExists(dir) || existsSync(join(dir, "node_modules"))) return unwrapCacheDir(dir)
    }
    if (packageJsonExists(keyDir)) return unwrapCacheDir(keyDir)
    return undefined
  } catch {
    return undefined
  }
}

function resolveV2CacheDir(base: string, sanitizedSpec: string): string | undefined {
  try {
    for (const key of [sanitizedSpec, `${sanitizedSpec}@latest`]) {
      const found = probeV2KeyDir(join(base, ...key.split("/")))
      if (found) return found
    }
    // Unresolved spec form: scan for any key containing the package name.
    const name = (sanitizedSpec.split("/").pop() ?? sanitizedSpec).split("@")[0] ?? sanitizedSpec
    let entries: string[] = []
    try {
      entries = readdirSync(base).filter((entry) => entry.includes(name))
    } catch {
      return undefined
    }
    for (const entry of entries) {
      const found = probeV2KeyDir(join(base, entry))
      if (found) return found
    }
    return undefined
  } catch {
    return undefined
  }
}

/** v2 cache root honors the same env/XDG resolution as the v2 host. */
function v2CacheRoot(): string {
  if (process.env["OPENCODE_CACHE_DIR"]) return process.env["OPENCODE_CACHE_DIR"]
  if (process.env["XDG_CACHE_HOME"]) return join(process.env["XDG_CACHE_HOME"], "opencode")
  return join(homedir(), ".cache", "opencode")
}

export function resolveStandaloneDir(spec: string): string | undefined {
  const v1 = resolveStandaloneDirIn(join(homedir(), ".cache", "opencode", "packages"), spec)
  if (v1) return v1
  const normalized = spec.startsWith("@mirrowel") && !spec.includes("@", 1) ? `${spec}@latest` : spec
  return resolveV2CacheDir(join(v2CacheRoot(), "npm"), sanitizeSpec(normalized))
}

/** Tests: v2 cache scan against an explicit base directory. */
export function resolveStandaloneDirV2In(base: string, spec: string): string | undefined {
  const normalized = spec.startsWith("@mirrowel") && !spec.includes("@", 1) ? `${spec}@latest` : spec
  return resolveV2CacheDir(base, sanitizeSpec(normalized))
}

export function resolveStandaloneDirIn(base: string, spec: string): string | undefined {
  try {
    if (spec.startsWith("file://")) {
      const path = fileURLToPath(spec)
      return packageJsonExists(path) ? unwrapCacheDir(path) : undefined
    }
    if (/^([a-zA-Z]:[\\/]|\/)/.test(spec)) {
      return packageJsonExists(spec) ? unwrapCacheDir(spec) : undefined
    }
    const normalized = spec.startsWith("@mirrowel") && !spec.includes("@", 1) ? `${spec}@latest` : spec
    const direct = join(base, ...sanitizeSpec(normalized).split("/"))
    if (packageJsonExists(direct)) return unwrapCacheDir(direct)
    const family = join(base, "@mirrowel")
    if (!existsSync(family)) return undefined
    const prefix = "opencode-agent-variants"
    let entries: string[]
    try {
      entries = readdirSync(family).filter((entry) => entry === prefix || entry.startsWith(`${prefix}@`))
    } catch {
      return undefined
    }
    if (entries.length === 0) return undefined
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

async function loadFromDir(spec: string, dir: string): Promise<AvImplementation | undefined> {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string }
    const wizardURL = pathToFileURL(join(dir, "dist", "wizard.js")).href
    const configURL = pathToFileURL(join(dir, "dist", "config.js")).href
    const wizard = (await import(`${wizardURL}?${Date.now()}`)) as typeof EmbeddedWizard
    const config = (await import(`${configURL}?${Date.now()}`)) as typeof EmbeddedConfig
    if (typeof wizard.mainMenu !== "function" || typeof config.loadSidecar !== "function") return undefined
    return { wizard, config, origin: { kind: "standalone", spec, dir, version: manifest.version ?? "unknown" } }
  } catch {
    return undefined
  }
}

export type RefreshResult = { ok: boolean; origin: string; error?: string }

/**
 * Points the studio's Agent Variants module at the configured implementation:
 * "standalone" resolves the standalone spec from the plugin array; anything
 * else (or a failed resolution) falls back to the embedded copy.
 */
export async function refreshAvSource(source: "embedded" | "standalone", pluginSpecs: string[]): Promise<RefreshResult> {
  if (source !== "standalone") {
    active = undefined
    return { ok: true, origin: avOrigin() }
  }
  // Identity matching (npm specs AND local checkouts - a repo folder named
  // plain "agent-variants" is a valid standalone registration). Local
  // checkouts win over npm installs when both are registered: local usually
  // means active development.
  const candidates = pluginSpecs.filter((entry) => isStandaloneAgentVariantsSpec(entry))
  const ordered = [
    ...candidates.filter((entry) => entry.startsWith("file:") || /^([a-zA-Z]:[\\/]|\/)/.test(entry)),
    ...candidates.filter((entry) => !(entry.startsWith("file:") || /^([a-zA-Z]:[\\/]|\/)/.test(entry))),
  ]
  if (ordered.length === 0) {
    active = undefined
    return { ok: false, origin: avOrigin(), error: "No standalone agent-variants plugin entry found in any config file; using the embedded copy." }
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
      errors.push(`"${spec}" could not be loaded (missing or incompatible dist/wizard.js - if the cached copy is stale, remove ~/.cache/opencode/packages/@mirrowel/opencode-agent-variants@<tag> or pin an exact version)`)
      continue
    }
    active = impl
    return { ok: true, origin: avOrigin() }
  }
  active = undefined
  return { ok: false, origin: avOrigin(), error: `${errors.join("; ")}; using the embedded copy.` }
}
