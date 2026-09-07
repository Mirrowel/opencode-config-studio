#!/usr/bin/env node
/**
 * dev:link / dev:unlink — switch the agent-variants dependency between the
 * npm registry version (used by CI and releases) and the local sibling repo
 * (used while developing both plugins together).
 *
 * package.json in git must always reference the registry version; release and
 * pack checks fail if a file: dependency is present.
 */
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const pkgPath = path.join(root, "package.json")
const depName = "@mirrowel/opencode-agent-variants"
const localPath = "../agent-variants"

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
const mode = process.argv[2]

if (mode === "link") {
  pkg.dependencies ??= {}
  pkg.dependencies[depName] = `file:${localPath}`
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log(`linked ${depName} -> file:${localPath} (run npm install)`)
} else if (mode === "unlink") {
  const registryVersion = process.argv[3]
  if (!registryVersion) {
    console.error("usage: node scripts/dev-link.mjs unlink <registry-version>")
    process.exit(1)
  }
  pkg.dependencies ??= {}
  pkg.dependencies[depName] = registryVersion
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log(`unlinked ${depName} -> ${registryVersion}`)
} else {
  console.error("usage: node scripts/dev-link.mjs link|unlink <registry-version>")
  process.exit(1)
}
