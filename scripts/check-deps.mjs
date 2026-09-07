#!/usr/bin/env node
/**
 * Release dependency gate: the published package must depend on the agent
 * variants package through the registry, never through a local file: link
 * (dev:link is for development only). Also verifies the dependency exists on
 * the npm registry unless ALLOW_UNPUBLISHED=1 (used before the first
 * agent-variants release).
 */
import { readFileSync } from "node:fs"
import { execSync } from "node:child_process"

const fail = (message) => {
  console.error(message)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"))
const depName = "@mirrowel/opencode-agent-variants"
const dependency = pkg.dependencies?.[depName]
if (!dependency) fail(`${depName} must be listed in dependencies.`)
if (dependency.startsWith("file:")) {
  fail(`${depName} is linked locally (${dependency}). Run 'node scripts/dev-link.mjs unlink <version>' and commit the registry dependency before releasing.`)
}

if (process.env.ALLOW_UNPUBLISHED !== "1") {
  try {
    execSync(`npm view "${depName}@${dependency.replace(/[\^~]/, "")}" version`, { stdio: "pipe" })
  } catch {
    fail(`No published ${depName} version matches "${dependency}". Publish agent-variants first, or set ALLOW_UNPUBLISHED=1 if this is intentional.`)
  }
}

console.log(`Release dependency ok: ${depName} ${dependency}`)
