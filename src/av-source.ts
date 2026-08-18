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

export function resolveStandaloneDir(spec: string): string | undefined {
  return resolveStandaloneDirIn(join(homedir(), ".cache", "opencode", "packages"), spec)
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
  const spec = pluginSpecs.find((entry) => entry.includes("opencode-agent-variants"))
  if (!spec) {
    active = undefined
    return { ok: false, origin: avOrigin(), error: "No standalone agent-variants plugin entry found in any config file; using the embedded copy." }
  }
  const dir = resolveStandaloneDir(spec)
  if (!dir) {
    active = undefined
    return { ok: false, origin: avOrigin(), error: `Standalone plugin "${spec}" is not installed yet (restart OpenCode to install it); using the embedded copy.` }
  }
  const impl = await loadFromDir(spec, dir)
  if (!impl) {
    active = undefined
    return { ok: false, origin: avOrigin(), error: `Standalone plugin "${spec}" could not be loaded (missing or incompatible dist/wizard.js - if the cached copy is stale, remove ~/.cache/opencode/packages/@mirrowel/opencode-agent-variants@<tag> or pin an exact version); using the embedded copy.` }
  }
  active = impl
  return { ok: true, origin: avOrigin() }
}
