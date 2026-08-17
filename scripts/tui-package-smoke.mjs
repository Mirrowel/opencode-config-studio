import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
const temp = mkdtempSync(path.join(tmpdir(), "config-studio-tui-"))

function run(command, args, options = {}) {
  const npmCli = command === "npm" ? process.env.npm_execpath : undefined
  const executable = npmCli ? process.execPath : command
  const commandArgs = npmCli ? [npmCli, ...args] : args
  const result = spawnSync(executable, commandArgs, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    shell: false,
    env: process.env,
  })
  if (result.status === 0) return result.stdout
  if (result.error) console.error(result.error)
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`)
}

try {
  const packs = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", temp]))
  const packed = Array.isArray(packs) ? packs[0] : Object.values(packs)[0]
  if (!packed?.filename) throw new Error("npm pack returned an unsupported JSON result")
  const tarball = path.join(temp, packed.filename)

  // The agent-variants dependency may be a local file: link (development) or
  // a registry range (not yet published). Either way the smoke stays
  // hermetic: pack the sibling repo and pin it through overrides.
  const agentVariantsDep = pkg.dependencies?.["@mirrowel/opencode-agent-variants"]
  const manifest = { private: true, type: "module", dependencies: { [pkg.name]: `file:${tarball}` } }
  if (agentVariantsDep) {
    const avRoot = path.resolve(root, "..", "agent-variants")
    const avPacks = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", temp], { cwd: avRoot }))
    const avPacked = Array.isArray(avPacks) ? avPacks[0] : Object.values(avPacks)[0]
    if (!avPacked?.filename) throw new Error("npm pack for agent-variants returned an unsupported JSON result")
    manifest.overrides = { "@mirrowel/opencode-agent-variants": `file:${path.join(temp, avPacked.filename)}` }
  }
  writeFileSync(path.join(temp, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: temp })

  const installedRoot = path.join(temp, "node_modules", ...pkg.name.split("/"))
  const installedPackage = JSON.parse(readFileSync(path.join(installedRoot, "package.json"), "utf8"))
  if (installedPackage.exports?.["./tui"]?.import !== "./dist/tui.js") {
    throw new Error("packed TUI export does not target the compiled artifact")
  }
  const artifact = readFileSync(path.join(installedRoot, "dist", "tui.js"), "utf8")
  if (artifact.includes("@opentui/solid/jsx-runtime")) {
    throw new Error("packed TUI uses non-reactive automatic JSX runtime")
  }
  if (!artifact.includes("effect") || !artifact.includes("setProp")) {
    throw new Error("packed TUI is missing Solid reactive property effects")
  }

  const check = [
    'import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"',
    "ensureRuntimePluginSupport()",
    `const mod = await import(${JSON.stringify(`${pkg.name}/tui`)})`,
    'if (mod.default?.id !== "config-studio" || typeof mod.default?.tui !== "function") throw new Error("invalid TUI plugin export")',
    `const wizard = await import(${JSON.stringify("@mirrowel/opencode-agent-variants/wizard")})`,
    'if (typeof wizard.mainMenu !== "function") throw new Error("embedded wizard library not resolvable from packed studio")',
    'console.log("packed TUI import passed")',
  ].join("; ")
  run("bun", ["--conditions=browser", "-e", check], { cwd: temp })
  console.log("packed TUI smoke test passed")
} finally {
  rmSync(temp, { recursive: true, force: true })
}
