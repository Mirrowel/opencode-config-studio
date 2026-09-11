#!/usr/bin/env node
/**
 * dev:link / dev:unlink — switch a sibling-plugin dependency between the
 * npm registry version (used by CI and releases) and the local sibling repo
 * (used while developing the plugins together).
 *
 * package.json in git must always reference the registry version; release and
 * pack checks fail if a file: dependency is present.
 */
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const pkgPath = path.join(root, "package.json")

const packages = {
  "agent-variants": { dep: "@mirrowel/opencode-agent-variants", local: "../agent-variants" },
  "subagent-explorer": { dep: "@mirrowel/opencode-subagent-explorer", local: "../subagent-explorer" },
}

const mode = process.argv[2]
const which = process.argv[3] ?? "agent-variants"
const target = packages[which]

if (!target) {
  console.error(`unknown package "${which}" - known: ${Object.keys(packages).join(", ")}`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))

if (mode === "link") {
  pkg.dependencies ??= {}
  pkg.dependencies[target.dep] = `file:${target.local}`
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log(`linked ${target.dep} -> file:${target.local} (run npm install)`)
} else if (mode === "unlink") {
  const registryVersion = process.argv[4]
  if (!registryVersion) {
    console.error("usage: node scripts/dev-link.mjs unlink <package> <registry-version>")
    process.exit(1)
  }
  pkg.dependencies ??= {}
  pkg.dependencies[target.dep] = registryVersion
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log(`unlinked ${target.dep} -> ${registryVersion}`)
} else {
  console.error("usage: node scripts/dev-link.mjs link|unlink <package> [registry-version]")
  process.exit(1)
}
