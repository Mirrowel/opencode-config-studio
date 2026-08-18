/**
 * Unit tests for the core library, run against compiled dist/ output.
 * Throws on failure; prints one line per passing test.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const dist = (name) => pathToFileURL(path.join(root, "dist", `${name}.js`)).href

const { applySet, applyDelete, parseJsonc, editConfigFile, createConfigFile, getValueAtPath, detectFormatting, formatPath } = await import(dist("jsonc"))
const { discoverConfigFiles, mergeWithProvenance, getIn, provenanceAt, findUneditableLayers } = await import(dist("discovery"))
const { deriveVariantsFromMeta, reasoningEffortBody, reasoningBudgetBody, computeBaseDefaults, computeSmallModelOptions, analyzeModel, analyzeProviders, bodyOneLine } = await import(dist("catalog"))
const { diffBodies, buildInlineConfig } = await import(dist("sink"))
const { isOwnSpec, ensureTuiRegistration, ourRootDir, PLUGIN_NPM_NAME } = await import(dist("selfwire"))
const { fuzzyScore, rankOptions } = await import(dist("search"))
const { loadSettings, saveSettings, settingsPath, moduleEnabled, setModuleEnabled, setModuleOption, moduleOption, DEFAULT_HIDDEN_SECTIONS } = await import(dist("settings"))
const { applyOpsToData, getAtPath } = await import(dist("jsonc"))
const { isStandaloneAgentVariantsSpec, findStandaloneAgentVariants, removeStandaloneHits } = await import(dist("standalone"))
const cache = await import(dist("providercache"))
const { buildMigrationPlan, savableParentFields, CONFIG_SAVABLE_PARENT_FIELDS } = await import(dist("migration"))
const palette = await import(dist("palette-category"))

function assert(condition, message) {
  if (!condition) throw new Error(`assert failed: ${message}`)
}

function section(name) {
  console.log(`- ${name}`)
}

// ---------------------------------------------------------------------------
// jsonc edit engine
// ---------------------------------------------------------------------------

{
  section("jsonc: comment preservation on nested set")
  const before = [
    "{",
    "  // my schema",
    '  "$schema": "https://opencode.ai/config.json",',
    "  /* provider tweaks */",
    '  "untouched": { "stay": "inline", "compact": true },',
    '  "provider": {',
    '    "zai": {',
    '      "models": {',
    '        "glm-5.2": {',
    '          "variants": {',
    '            "high": { "reasoningEffort": "high" }',
    "          }",
    "        }",
    "      }",
    "    }",
    "  }",
    "}",
  ].join("\n")
  const after = applySet(before, ["provider", "zai", "models", "glm-5.2", "variants", "max"], { reasoningEffort: "max" })
  assert(after.includes("// my schema"), "line comment lost")
  assert(after.includes("/* provider tweaks */"), "block comment lost")
  assert(after.includes('"untouched": { "stay": "inline", "compact": true },'), "untouched sibling block was reflowed")
  assert(getValueAtPath(after, ["provider", "zai", "models", "glm-5.2", "variants", "high", "reasoningEffort"]) === "high", "existing variant value lost")
  assert(getValueAtPath(after, ["provider", "zai", "models", "glm-5.2", "variants", "max", "reasoningEffort"]) === "max", "new value missing")
  // The edit is confined to the touched container: everything before it is byte-identical.
  const marker = '"provider": {'
  assert(after.slice(0, after.indexOf(marker)) === before.slice(0, before.indexOf(marker)), "text before the edited block changed")
}

{
  section("jsonc: real deletion removes the key")
  const before = '{"a": 1, "provider": {"zai": {"models": {"glm-5.2": {"variants": {"high": {"reasoningEffort": "high"}}}}}}, "b": 2}'
  const after = applyDelete(before, ["provider", "zai", "models", "glm-5.2", "variants", "high"])
  assert(getValueAtPath(after, ["provider", "zai", "models", "glm-5.2", "variants", "high"]) === undefined, "key still present")
  assert(getValueAtPath(after, ["a"]) === 1 && getValueAtPath(after, ["b"]) === 2, "siblings lost")
  const report = parseJsonc(after)
  assert(report.errors.length === 0, "deletion introduced parse errors")
}

{
  section("jsonc: nested path creation from minimal file")
  const before = '{\n  "$schema": "https://opencode.ai/config.json"\n}\n'
  const after = applySet(before, ["provider", "zai", "models", "glm-5.3", "options"], { enable_thinking: true })
  assert(getValueAtPath(after, ["provider", "zai", "models", "glm-5.3", "options", "enable_thinking"]) === true, "nested path not created")
  assert(parseJsonc(after).errors.length === 0, "creation introduced parse errors")
}

{
  section("jsonc: formatting detection")
  assert(detectFormatting('{\r\n    "a": 1\r\n}').tabSize === 4, "4-space indent not detected")
  assert(detectFormatting('{\n\t"a": 1\n}').insertSpaces === false, "tab indent not detected")
  assert(detectFormatting("").tabSize === 2, "default tabSize")
}

{
  section("jsonc: editConfigFile end to end with backup")
  const dir = mkdtempSync(path.join(tmpdir(), "config-studio-test-"))
  const stateDir = path.join(dir, "state")
  const file = path.join(dir, "opencode.jsonc")
  try {
    writeFileSync(file, '{\n  // keep me\n  "model": "zai/glm-5.2"\n}\n', "utf8")
    const result = editConfigFile(file, [{ op: "set", path: ["provider", "zai", "models", "glm-5.2", "variants", "fast"], value: { reasoningEffort: "low" } }], { stateDir, reason: "unit test" })
    assert(result.ok, `edit failed: ${result.error}`)
    const text = readFileSync(file, "utf8")
    assert(text.includes("// keep me"), "comment lost on disk")
    assert(text.includes('"fast"'), "new variant missing on disk")
    assert(result.backupId, "no backup created")
    assert(existsSync(path.join(stateDir, "backups")), "backup dir missing")

    const second = editConfigFile(file, [{ op: "delete", path: ["provider", "zai", "models", "glm-5.2", "variants", "fast"] }], { stateDir, reason: "unit test 2" })
    assert(second.ok, `delete failed: ${second.error}`)
    assert(!readFileSync(file, "utf8").includes('"fast"'), "variant still on disk after delete")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  section("jsonc: parse-error files are refused")
  const dir = mkdtempSync(path.join(tmpdir(), "config-studio-test-"))
  const file = path.join(dir, "opencode.jsonc")
  try {
    writeFileSync(file, '{ "broken": ', "utf8")
    const result = editConfigFile(file, [{ op: "set", path: ["model"], value: "zai/glm-5.2" }], { stateDir: path.join(dir, "state"), reason: "unit test" })
    assert(!result.ok, "edit should have been refused")
    assert(result.error?.includes("parse errors"), `unexpected error: ${result.error}`)
    assert(readFileSync(file, "utf8") === '{ "broken": ', "file was modified despite refusal")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  section("jsonc: createConfigFile")
  const dir = mkdtempSync(path.join(tmpdir(), "config-studio-test-"))
  const file = path.join(dir, "opencode.jsonc")
  try {
    const created = createConfigFile(file)
    assert(created.ok, `create failed: ${created.error}`)
    assert(readFileSync(file, "utf8").includes('"$schema"'), "schema header missing")
    const again = createConfigFile(file)
    assert(!again.ok, "second create should fail")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// discovery + provenance merge
// ---------------------------------------------------------------------------

{
  section("discovery: precedence merge with provenance")
  const dir = mkdtempSync(path.join(tmpdir(), "config-studio-test-"))
  const global = path.join(dir, "global")
  const project = path.join(dir, "project")
  const src = path.join(project, "src")
  mkdirSync(global, { recursive: true })
  mkdirSync(src, { recursive: true })
  try {
    writeFileSync(path.join(global, "opencode.jsonc"), JSON.stringify({
      model: "zai/glm-5.2",
      provider: { zai: { models: { "glm-5.2": { options: { store: false }, variants: { high: { reasoningEffort: "high" } } } } } },
    }), "utf8")
    writeFileSync(path.join(src, "opencode.json"), JSON.stringify({
      provider: { zai: { models: { "glm-5.2": { variants: { high: { reasoningEffort: "max" } } } } } },
    }), "utf8")

    const files = discoverConfigFiles({ globalConfigDir: global, envConfigFile: undefined, directory: src, worktree: project })
    const editable = files.filter((file) => file.exists)
    assert(editable.length === 2, `expected 2 files, got ${editable.length}`)
    const projectFile = editable.find((file) => file.kind === "project")
    const globalFile = editable.find((file) => file.kind === "global")
    assert(projectFile && globalFile, "file kinds missing")
    assert(projectFile.precedence > globalFile.precedence, "project should outrank global")

    const merge = mergeWithProvenance(files)
    assert(getIn(merge.merged, ["model"]) === "zai/glm-5.2", "root model lost")
    assert(getIn(merge.merged, ["provider", "zai", "models", "glm-5.2", "options", "store"]) === false, "options lost in merge")
    const variantWinner = provenanceAt(merge, ["provider", "zai", "models", "glm-5.2", "variants", "high"])
    assert(variantWinner.winner === projectFile.id, `variant winner wrong: ${variantWinner.winner}`)
    assert(variantWinner.contributors.length === 2, `contributors wrong: ${variantWinner.contributors.join(",")}`)
    const optionsWinner = provenanceAt(merge, ["provider", "zai", "models", "glm-5.2", "options"])
    assert(optionsWinner.winner === globalFile.id, "options winner wrong")

    const uneditable = findUneditableLayers(merge.merged, { model: "zai/glm-5.2", small_model: "openai/gpt-5.2" })
    const smallModelFinding = uneditable.find((finding) => finding.pointer === "small_model")
    assert(smallModelFinding, "small_model from env layer not detected")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// catalog derivation
// ---------------------------------------------------------------------------

{
  section("catalog: effort derivation")
  const derived = deriveVariantsFromMeta("@ai-sdk/openai-compatible", "glm-5.3", {
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
    limit: { context: 200000, output: 32768 },
  })
  assert(derived, "no derivation")
  assert(JSON.stringify(derived.names) === JSON.stringify(["low", "high", "max"]), `names wrong: ${derived.names.join(",")}`)
  assert(JSON.stringify(derived.bodies["high"]) === JSON.stringify({ reasoningEffort: "high" }), `body wrong: ${JSON.stringify(derived.bodies["high"])}`)
}

{
  section("catalog: budget derivation clamps to output limit")
  const derived = deriveVariantsFromMeta("@ai-sdk/anthropic", "claude-x", {
    reasoning: true,
    reasoning_options: [{ type: "budget_tokens", min: 1024, max: 999999 }],
    limit: { context: 200000, output: 8192 },
  })
  assert(derived && derived.names.includes("max") && derived.names.includes("high"), "budget names missing")
  const maxBody = derived.bodies["max"]
  assert(maxBody && maxBody["thinking"] && maxBody["thinking"]["budgetTokens"] === 8191, `max budget not clamped: ${JSON.stringify(maxBody)}`)
}

{
  section("catalog: toggle derivation for qwen-style models")
  const derived = deriveVariantsFromMeta("@ai-sdk/openai-compatible", "qwen3", {
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
  })
  assert(derived && JSON.stringify(derived.names) === JSON.stringify(["none", "high"]), `toggle names wrong: ${JSON.stringify(derived?.names)}`)
}

{
  section("catalog: reasoning effort bodies per SDK")
  assert(JSON.stringify(reasoningEffortBody("@openrouter/ai-sdk-provider", "m", "high")) === JSON.stringify({ reasoning: { effort: "high" } }), "openrouter body wrong")
  assert(JSON.stringify(reasoningEffortBody("@ai-sdk/openai", "gpt-5", "medium")) === JSON.stringify({ reasoningEffort: "medium", reasoningSummary: "auto", include: ["reasoning.encrypted_content"] }), "openai body wrong")
  assert(reasoningBudgetBody("@ai-sdk/openai-compatible", 1000) === undefined, "budget body for openai-compatible should be undefined")
}

{
  section("catalog: base defaults preview for zai")
  const preview = computeBaseDefaults("@ai-sdk/openai-compatible", "zai-coding-plan", {
    id: "glm-5.3",
    api: { id: "glm-5.3", npm: "@ai-sdk/openai-compatible" },
    capabilities: { reasoning: true },
  })
  const thinking = preview.options["thinking"]
  assert(thinking && thinking["type"] === "enabled" && thinking["clear_thinking"] === false, `zai thinking default wrong: ${JSON.stringify(preview.options)}`)
  assert(preview.approximate === true, "preview must be labeled approximate")
}

{
  section("catalog: small model options use first variant")
  assert(computeSmallModelOptions({ variants: { high: { reasoningEffort: "high" } } }) && JSON.stringify(computeSmallModelOptions({ variants: { high: { reasoningEffort: "high" } } })) === JSON.stringify({ reasoningEffort: "high" }), "small options wrong")
  assert(computeSmallModelOptions({ variants: {} }) === undefined, "empty variants should give undefined")
}

// ---------------------------------------------------------------------------
// model analysis provenance
// ---------------------------------------------------------------------------

{
  section("catalog: analyzeModel attributes config vs catalog")
  const files = [
    {
      id: "global:opencode.jsonc",
      kind: "global",
      label: "opencode.jsonc",
      path: "/tmp/opencode.jsonc",
      precedence: 0,
      exists: true,
      parseErrors: [],
      data: { provider: { zai: { models: { "glm-5.2": { variants: { high: { reasoningEffort: "max" }, custom: { reasoningEffort: "low" }, off: { disabled: true } } } } } } },
      text: "{}",
    },
  ]
  const merge = mergeWithProvenance(files)
  const runtime = {
    id: "glm-5.2",
    name: "GLM-5.2",
    api: { id: "glm-5.2", npm: "@ai-sdk/openai-compatible" },
    capabilities: { reasoning: true },
    options: {},
    variants: { high: { reasoningEffort: "max" }, custom: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" } },
  }
  const modelsDev = { zai: { npm: "@ai-sdk/openai-compatible", models: { "glm-5.2": { reasoning: true, reasoning_options: [{ type: "effort", values: ["high", "medium"] }] } } } }
  const analysis = analyzeModel(runtime, "zai", "glm-5.2", merge, modelsDev)

  const high = analysis.variants.find((variant) => variant.name === "high")
  assert(high, "high variant missing")
  assert(high.keyProvenance.find((key) => key.key === "reasoningEffort")?.source === "config", "high body key should be config-sourced")
  assert(high.resolvedBody["reasoningEffort"] === "max", "resolved body should reflect config override")

  const medium = analysis.variants.find((variant) => variant.name === "medium")
  assert(medium, "medium variant missing")
  assert(medium.files.length === 0, "medium should be catalog-only")
  assert(medium.keyProvenance.find((key) => key.key === "reasoningEffort")?.source === "catalog", "medium key should be catalog-sourced")

  const custom = analysis.variants.find((variant) => variant.name === "custom")
  assert(custom && custom.source === "config", "custom variant should be config-sourced")

  const off = analysis.variants.find((variant) => variant.name === "off")
  assert(off && off.disabled, "off variant should be disabled")
  assert(analysis.variants[analysis.variants.length - 1] === off || off.disabled, "disabled variant present in list")
}

{
  section("catalog: analyzeProviders sorts edited first")
  const files = [
    { id: "g", kind: "global", label: "opencode.jsonc", path: "/g", precedence: 0, exists: true, parseErrors: [], data: { provider: { zai: { models: { "glm-5.2": {} } } } }, text: "" },
  ]
  const merge = mergeWithProvenance(files)
  const providers = [
    { id: "aaa", name: "AAA", models: { m1: {} } },
    { id: "zai", name: "Z.ai", models: {} },
    { id: "bbb", name: "BBB", models: {} },
  ]
  const analyses = analyzeProviders(providers, { zai: "glm-5.2" }, merge)
  assert(analyses[0].providerID === "zai", `edited provider not first: ${analyses[0].providerID}`)
  assert(analyses[0].edited, "zai should be marked edited")
}

{
  section("catalog: bodyOneLine truncates")
  const line = bodyOneLine({ reasoningEffort: "high" }, 10)
  assert(line.length <= 10 && line.endsWith("..."), `truncation wrong: "${line}"`)
}

// ---------------------------------------------------------------------------
// sink helpers
// ---------------------------------------------------------------------------

{
  section("sink: buildInlineConfig redirects baseURL")
  const config = buildInlineConfig({
    providerID: "zai",
    modelID: "glm-5.3",
    runtimeModel: { id: "glm-5.3", name: "GLM-5.3", capabilities: { reasoning: true }, limit: { context: 128000, output: 8192 }, variants: { high: { reasoningEffort: "high" } } },
    providerNpm: "@ai-sdk/openai-compatible",
    variant: "high",
  }, "http://127.0.0.1:45678")
  assert(config["provider"]["zai"]["options"]["baseURL"] === "http://127.0.0.1:45678", "baseURL wrong")
  assert(config["provider"]["zai"]["npm"] === "@ai-sdk/openai-compatible", "npm wrong")
  const model = config["provider"]["zai"]["models"]["glm-5.3"]
  assert(model["reasoning"] === true && model["tool_call"] === true, "capabilities not cloned")
  assert(model["limit"]["context"] === 128000, "limit not cloned")
  assert(model["variants"]["high"]["reasoningEffort"] === "high", "variants not cloned")
  assert(config["agent"]["config-studio-sim"]["model"] === "zai/glm-5.3", "sim agent wrong")
}

{
  section("sink: diffBodies finds added/removed/changed")
  const diff = diffBodies(
    { model: "m", reasoningEffort: "low", extra: 1 },
    { model: "m", reasoningEffort: "high" },
  )
  const changed = diff.find((entry) => entry.pointer === "reasoningEffort")
  const removed = diff.find((entry) => entry.pointer === "extra")
  assert(changed && changed.kind === "changed", "changed entry missing")
  assert(removed && removed.kind === "removed", "removed entry missing")
  assert(diff.length === 2, `unexpected diff size: ${diff.length}`)
}

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------

{
  section("utils: formatPath")
  assert(formatPath(["provider", "zai", "models", "glm-5.2", "variants"]) === "provider.zai.models.glm-5.2.variants", `formatPath wrong: ${formatPath(["provider", "zai", "models", "glm-5.2", "variants"])}`)
}

// ---------------------------------------------------------------------------
// selfwire
// ---------------------------------------------------------------------------

{
  section("selfwire: spec matching")
  // Path-based specs go through fileURLToPath, which is platform-dependent:
  // build the spec from a real temp path so the test is cross-platform.
  const ownRoot = mkdtempSync(path.join(tmpdir(), "selfwire own "))
  try {
    const ownSpec = pathToFileURL(ownRoot).href
    assert(isOwnSpec(PLUGIN_NPM_NAME, "C:/irrelevant"), "npm name should match")
    assert(isOwnSpec(`${PLUGIN_NPM_NAME}@latest`, "C:/irrelevant"), "npm name with tag should match")
    assert(isOwnSpec(ownSpec, ownRoot), "file spec with encoded spaces should match")
    assert(!isOwnSpec("file:///C:/other/plugin", ownRoot), "foreign file spec should not match")
    assert(!isOwnSpec("@mirrowel/opencode-agent-variants", "C:/irrelevant"), "foreign npm name should not match")
    assert(!isOwnSpec(42, "C:/irrelevant"), "non-string should not match")
    assert(ourRootDir().length > 0, "ourRootDir should resolve")
  } finally {
    rmSync(ownRoot, { recursive: true, force: true })
  }
}

{
  section("selfwire: wires opencode.json registration into tui.json")
  const dir = mkdtempSync(path.join(tmpdir(), "config-studio-test-"))
  const globalDir = path.join(dir, "global")
  const pluginRoot = path.join(dir, "plugins", "config-studio")
  mkdirSync(globalDir, { recursive: true })
  mkdirSync(pluginRoot, { recursive: true })
  try {
    const spec = pathToFileURL(pluginRoot).href
    writeFileSync(path.join(globalDir, "opencode.json"), JSON.stringify({ plugin: ["@mirrowel/opencode-agent-variants", spec] }), "utf8")

    const first = ensureTuiRegistration({ globalConfigDir: globalDir, ourRoot: pluginRoot })
    if (first.status !== "wired") throw new Error(`expected wired, got ${first.status} (${first.error ?? ""})`)
    const tuiText = readFileSync(path.join(globalDir, "tui.json"), "utf8")
    if (!tuiText.includes(spec)) throw new Error(`tui.json does not contain the spec: ${tuiText}`)
    if (tuiText.includes("agent-variants")) throw new Error("foreign plugin spec leaked into tui.json")

    const second = ensureTuiRegistration({ globalConfigDir: globalDir, ourRoot: pluginRoot })
    if (second.status !== "already-wired") throw new Error(`expected already-wired, got ${second.status}`)
    if (second.spec !== spec) throw new Error(`spec mismatch: ${second.spec}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  section("selfwire: npm spec and project tui.json detection")
  const dir = mkdtempSync(path.join(tmpdir(), "config-studio-test-"))
  const globalDir = path.join(dir, "global")
  const project = path.join(dir, "project", "src")
  mkdirSync(globalDir, { recursive: true })
  mkdirSync(project, { recursive: true })
  try {
    writeFileSync(path.join(globalDir, "opencode.json"), JSON.stringify({ plugin: [PLUGIN_NPM_NAME] }), "utf8")
    const first = ensureTuiRegistration({ globalConfigDir: globalDir, ourRoot: "C:/somewhere" })
    if (first.status !== "wired" || first.spec !== PLUGIN_NPM_NAME) throw new Error(`npm wiring failed: ${JSON.stringify(first)}`)
    // Project-level tui.json also counts as wired.
    rmSync(path.join(globalDir, "tui.json"))
    writeFileSync(path.join(project, "tui.json"), JSON.stringify({ plugin: [[PLUGIN_NPM_NAME, {}]] }), "utf8")
    const second = ensureTuiRegistration({ globalConfigDir: globalDir, ourRoot: "C:/somewhere", directory: project, worktree: path.join(dir, "project") })
    if (second.status !== "already-wired") throw new Error(`project tui.json not detected: ${second.status}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  section("selfwire: no registration is a no-op")
  const dir = mkdtempSync(path.join(tmpdir(), "config-studio-test-"))
  const globalDir = path.join(dir, "global")
  mkdirSync(globalDir, { recursive: true })
  try {
    writeFileSync(path.join(globalDir, "opencode.json"), JSON.stringify({ model: "zai/glm-5.2" }), "utf8")
    const result = ensureTuiRegistration({ globalConfigDir: globalDir, ourRoot: "C:/somewhere" })
    if (result.status !== "not-registered") throw new Error(`expected not-registered, got ${result.status}`)
    if (existsSync(path.join(globalDir, "tui.json"))) throw new Error("tui.json should not be created")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// search (debounced picker scoring)
// ---------------------------------------------------------------------------

{
  section("search: ranking basics")
  const options = [
    { title: "glm-5.2", value: "a", category: "z.ai" },
    { title: "gpt-5.1", value: "b", category: "OpenAI" },
    { title: "glm-4.7", value: "c", category: "z.ai" },
    { title: "kimi-k2", value: "d", category: "Moonshot" },
  ]
  const ranked = rankOptions(options, "glm")
  if (ranked.length !== 2) throw new Error(`expected 2 glm hits, got ${ranked.length}`)
  if (ranked[0].value !== "a" && ranked[0].value !== "c") throw new Error(`unexpected top hit ${ranked[0].value}`)
  if (rankOptions(options, "zzz").length !== 0) throw new Error("no-match query should exclude everything")
  if (rankOptions(options, "  ").length !== 4) throw new Error("blank query should return all options")
}

{
  section("search: provider-only query matches via category")
  const options = [
    { title: "glm-5.2", value: "a", category: "z.ai" },
    { title: "kimi-k2", value: "d", category: "Moonshot" },
  ]
  const ranked = rankOptions(options, "zai")
  if (ranked.length !== 1 || ranked[0].value !== "a") throw new Error("category match failed")
  // A model matching on title should outrank one matching only on category.
  const mixed = [
    { title: "gpt-5.2", value: "cat-only", category: "OpenAI" },
    { title: "openai-mini", value: "title-hit", category: "Other Corp" },
  ]
  const ranked2 = rankOptions(mixed, "openai")
  if (ranked2[0].value !== "title-hit") throw new Error(`title match should outrank category match, got ${ranked2[0].value}`)
}

{
  section("search: substring beats scattered subsequence")
  const options = [
    { title: "g-l-m-scattered", value: "scattered", category: "" },
    { title: "xglm", value: "substring", category: "" },
  ]
  const ranked = rankOptions(options, "glm")
  if (ranked[0].value !== "substring") throw new Error(`substring should win, got ${ranked[0].value}`)
  if (fuzzyScore("glm", "g-l-m") === Number.NEGATIVE_INFINITY) throw new Error("subsequence should still match")
  if (fuzzyScore("glm", "glx") !== Number.NEGATIVE_INFINITY) throw new Error("missing char must not match")
}

{
  section("search: case-insensitive on both keys")
  const options = [{ title: "GLM-5.2", value: "a", category: "Z.AI" }]
  if (rankOptions(options, "glm")[0]?.value !== "a") throw new Error("lowercase query vs uppercase title failed")
  if (rankOptions(options, "z.ai")[0]?.value !== "a") throw new Error("category case-insensitive failed")
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

{
  section("settings: defaults, persistence, module toggles")
  const dir = mkdtempSync(path.join(tmpdir(), "config-studio-test-"))
  try {
    const initial = loadSettings(dir)
    assert(JSON.stringify(initial.capture.hiddenSections) === JSON.stringify(DEFAULT_HIDDEN_SECTIONS), "default hidden sections should match")
    assert(moduleEnabled(initial, "agent-variants"), "modules default to enabled")

    initial.capture.hiddenSections = ["messages"]
    setModuleEnabled(dir, initial, "agent-variants", false)
    setModuleOption(dir, initial, "agent-variants", "ownMenu", true)
    assert(existsSync(settingsPath(dir)), "settings file should be written")

    const reloaded = loadSettings(dir)
    assert(JSON.stringify(reloaded.capture.hiddenSections) === JSON.stringify(["messages"]), "capture settings should persist")
    assert(!moduleEnabled(reloaded, "agent-variants"), "disabled module should stay disabled")
    assert(moduleOption(reloaded, "agent-variants", "ownMenu", false) === true, "module option should persist")
    assert(moduleOption(reloaded, "agent-variants", "missing", "fallback") === "fallback", "missing option should fall back")
    assert(moduleEnabled(reloaded, "unknown-module"), "unknown modules default to enabled")

    writeFileSync(settingsPath(dir), "{ broken json !!!", "utf8")
    const corrupt = loadSettings(dir)
    assert(JSON.stringify(corrupt.capture.hiddenSections) === JSON.stringify(DEFAULT_HIDDEN_SECTIONS), "corrupt settings fall back to defaults")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// jsonc: applyOpsToData + getAtPath (staged-save overlay)
// ---------------------------------------------------------------------------

{
  section("jsonc: applyOpsToData and getAtPath")
  const data = { provider: { zai: { models: { "glm-5.2": { options: { temperature: 0.2 } } } } }, model: "a/b" }
  const overlay = applyOpsToData(data, [
    { op: "set", path: ["provider", "zai", "models", "glm-5.2", "options", "reasoningEffort"], value: "high" },
    { op: "delete", path: ["model"] },
  ])
  assert(overlay.provider.zai.models["glm-5.2"].options.reasoningEffort === "high", "set op should apply")
  assert(overlay.model === undefined, "delete op should apply")
  assert(data.model === "a/b" && data.provider.zai.models["glm-5.2"].options.reasoningEffort === undefined, "source data must not be mutated")
  assert(getAtPath(overlay, ["provider", "zai", "models", "glm-5.2", "options", "temperature"]) === 0.2, "getAtPath should read nested values")
  assert(getAtPath(overlay, ["provider", "nope"]) === undefined, "getAtPath missing key = undefined")

  const created = applyOpsToData({}, [{ op: "set", path: ["agent", "build", "temperature"], value: 0.7 }])
  assert(created.agent.build.temperature === 0.7, "set should create intermediate objects")

  const arr = applyOpsToData({ plugin: ["a", "b"] }, [{ op: "set", path: ["plugin", 2], value: "c" }])
  assert(JSON.stringify(arr.plugin) === JSON.stringify(["a", "b", "c"]), "array index set should append")

  const removed = applyOpsToData({ plugin: ["a", "b"] }, [{ op: "delete", path: ["plugin", 0] }])
  assert(JSON.stringify(removed.plugin) === JSON.stringify(["b"]), "array index delete should splice")
}

// ---------------------------------------------------------------------------
// standalone agent-variants detection + removal
// ---------------------------------------------------------------------------

{
  section("standalone: spec matching")
  assert(isStandaloneAgentVariantsSpec("@mirrowel/opencode-agent-variants"), "npm name should be standalone")
  assert(isStandaloneAgentVariantsSpec("@mirrowel/opencode-agent-variants@latest"), "npm name with tag should be standalone")
  assert(isStandaloneAgentVariantsSpec("file:///C:/Projects/OC%20Plugins/agent-variants"), "file path to av repo should be standalone")
  assert(isStandaloneAgentVariantsSpec("file:///C:/x/node_modules/@mirrowel/opencode-agent-variants"), "file path to av install should be standalone")
  assert(!isStandaloneAgentVariantsSpec("file:///C:/Projects/OC%20Plugins/opencode-config-studio"), "studio spec should not be standalone")
  assert(!isStandaloneAgentVariantsSpec("@mirrowel/opencode-config-studio"), "studio npm name should not be standalone")
  assert(!isStandaloneAgentVariantsSpec(undefined), "non-string should not be standalone")
}

{
  section("standalone: find + remove across opencode.json and tui.json")
  const dir = mkdtempSync(path.join(tmpdir(), "config-studio-test-"))
  const globalDir = path.join(dir, "global")
  mkdirSync(globalDir, { recursive: true })
  try {
    const avSpec = "file:///C:/Projects/OC%20Plugins/agent-variants"
    writeFileSync(path.join(globalDir, "opencode.json"), JSON.stringify({ plugin: ["@cortexkit/other", avSpec, "file:///C:/Projects/OC%20Plugins/opencode-config-studio"] }), "utf8")
    writeFileSync(path.join(globalDir, "tui.json"), JSON.stringify({ plugin: [avSpec] }), "utf8")

    const hits = findStandaloneAgentVariants({ globalConfigDir: globalDir })
    assert(hits.length === 2, `expected 2 hits (opencode.json + tui.json), got ${hits.length}`)

    const results = removeStandaloneHits(hits, path.join(dir, "state"))
    assert(results.every((result) => !result.error), `removal should succeed: ${JSON.stringify(results)}`)
    const after = JSON.parse(readFileSync(path.join(globalDir, "opencode.json"), "utf8"))
    assert(JSON.stringify(after.plugin) === JSON.stringify(["@cortexkit/other", "file:///C:/Projects/OC%20Plugins/opencode-config-studio"]), `opencode.json plugin array wrong: ${JSON.stringify(after.plugin)}`)
    const tuiAfter = JSON.parse(readFileSync(path.join(globalDir, "tui.json"), "utf8"))
    assert(Array.isArray(tuiAfter.plugin) && tuiAfter.plugin.length === 0, `tui.json plugin array should be empty: ${JSON.stringify(tuiAfter.plugin)}`)

    const recheck = findStandaloneAgentVariants({ globalConfigDir: globalDir })
    assert(recheck.length === 0, "no standalone hits should remain")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  section("standalone: multiple standalone entries in one file")
  const dir = mkdtempSync(path.join(tmpdir(), "config-studio-test-"))
  const globalDir = path.join(dir, "global")
  mkdirSync(globalDir, { recursive: true })
  try {
    writeFileSync(path.join(globalDir, "opencode.json"), JSON.stringify({ plugin: ["@mirrowel/opencode-agent-variants", "middle", "@mirrowel/opencode-agent-variants@1.0.0"] }), "utf8")
    const hits = findStandaloneAgentVariants({ globalConfigDir: globalDir })
    assert(hits.length === 2, `expected 2 hits, got ${hits.length}`)
    const results = removeStandaloneHits(hits, path.join(dir, "state"))
    assert(results.every((result) => !result.error), "removal should succeed")
    const after = JSON.parse(readFileSync(path.join(globalDir, "opencode.json"), "utf8"))
    assert(JSON.stringify(after.plugin) === JSON.stringify(["middle"]), `plugin array wrong: ${JSON.stringify(after.plugin)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  section("jsonc: array element deletion across formats (library bug workaround)")
  const cases = [
    { name: "compact middle", text: JSON.stringify({ plugin: ["a", "middle", "b"] }), path: ["plugin", 1], expect: ["a", "b"] },
    { name: "compact last", text: JSON.stringify({ plugin: ["a", "middle", "b"] }), path: ["plugin", 2], expect: ["a", "middle"] },
    { name: "compact only child", text: JSON.stringify({ plugin: ["x"] }), path: ["plugin", 0], expect: [] },
    { name: "pretty last", text: JSON.stringify({ plugin: ["a", "b"] }, null, 2), path: ["plugin", 1], expect: ["a"] },
    { name: "pretty middle", text: JSON.stringify({ plugin: ["a", "b", "c"] }, null, 2), path: ["plugin", 1], expect: ["a", "c"] },
    { name: "trailing comma last", text: '{ "plugin": ["a", "b", ] }', path: ["plugin", 1], expect: ["a"] },
    { name: "leading comment survives", text: '{\n  // plugins below\n  "plugin": ["a", "b"]\n}', path: ["plugin", 1], expect: ["a"] },
  ]
  for (const item of cases) {
    const after = applyDelete(item.text, item.path)
    const report = parseJsonc(after)
    assert(report.errors.length === 0, `${item.name}: parse errors in result: ${JSON.stringify(after)}`)
    assert(JSON.stringify(report.data.plugin) === JSON.stringify(item.expect), `${item.name}: expected ${JSON.stringify(item.expect)}, got ${JSON.stringify(report.data.plugin)}`)
  }
  // Trailing comments on the deleted separator may go with it (same as the
  // library); comments elsewhere and on surviving elements must survive.
  const commented = applyDelete('{ // header\n "plugin": [\n  "a", // keep a\n  "b",\n  "c"\n ]\n}', ["plugin", 2])
  assert(commented.includes("keep a"), "trailing comment of a surviving element must survive")
  assert(commented.includes("header"), "unrelated comment must survive")
  assert(parseJsonc(commented).errors.length === 0, "commented deletion must stay parseable")
}

// ---------------------------------------------------------------------------
// providercache
// ---------------------------------------------------------------------------

{
  section("providercache: key + hit/miss + TTL")
  const keyA = cache.providerCacheKey({ merged: { a: 1 }, winner: new Map(), contributors: new Map() })
  const keyB = cache.providerCacheKey({ merged: { a: 2 }, winner: new Map(), contributors: new Map() })
  assert(keyA !== keyB, "different config content must produce different keys")
  assert(cache.getCachedProviders(keyA) === undefined, "empty cache must miss")

  const snapshot = { providers: [{ id: "zai" }], defaults: { zai: "glm-5.2" }, source: "provider-list" }
  cache.setCachedProviders(keyA, snapshot, 1000)
  assert(cache.getCachedProviders(keyA, 2000)?.providers.length === 1, "same key within TTL must hit")
  assert(cache.getCachedProviders(keyB, 2000) === undefined, "different key must miss")
  assert(cache.getCachedProviders(keyA, 1000 + 5 * 60 * 1000 + 1) === undefined, "expired cache must miss")
  cache.setCachedProviders(keyB, snapshot, 1000)
  assert(cache.getCachedProviders(keyB, 2000) !== undefined, "latest key wins")
  cache.clearProviderCache()
  assert(cache.getCachedProviders(keyB, 2000) === undefined, "cleared cache must miss")
}

{
  section("providercache: outside-change detection")
  const bases = new Map([["/cfg/opencode.json", '{\n  "model": "a/b"\n}\n']])
  const unchanged = cache.detectOutsideChanges(bases, () => '{\n  "model": "a/b"\n}\n')
  assert(unchanged.length === 0, "identical content must not report changes")
  const changed = cache.detectOutsideChanges(bases, () => '{\n  "model": "a/c"\n}\n')
  assert(changed.length === 1 && changed[0].path === "/cfg/opencode.json", "changed content must report")
  assert(changed[0].diffLines.some((line) => line.includes("+")), `diff should show added lines: ${JSON.stringify(changed[0].diffLines)}`)
  assert(changed[0].diffLines.some((line) => line.includes("-")), "diff should show removed lines")
  const missing = cache.detectOutsideChanges(bases, () => undefined)
  assert(missing.length === 1 && missing[0].diffLines[0].includes("no longer"), "unreadable file must report")
}

// ---------------------------------------------------------------------------
// migration: sidecar parent fields -> config ops
// ---------------------------------------------------------------------------

{
  section("migration: preset resolution + template materialization")
  const sidecar = {
    $schema: "https://opencode.ai/config.json",
    agents: {
      general: {
        parent: {
          model: "light", // preset reference -> must resolve to concrete model
          prompt: "You are {parent}.", // template token -> materialized
          temperature: 0.3, // passthrough
          prompt_prepend: "keep me", // NOT migrated (stays sidecar)
        },
        variants: {},
      },
    },
    models: {
      light: { model: "zai/glm-5.2", temperature: 0.1 },
    },
    routing: { prompt_markers: false },
  }
  const savable = savableParentFields(sidecar, "general")
  assert(JSON.stringify(savable) === JSON.stringify(["model", "temperature", "prompt"]), `savable fields wrong: ${JSON.stringify(savable)}`)

  const plan = buildMigrationPlan(sidecar, "general")
  assert(plan, "plan must build")
  const modelOp = plan.ops.find((op) => op.path.join(".") === "agent.general.model")
  assert(modelOp && modelOp.value === "zai/glm-5.2", `preset must resolve to concrete model: ${JSON.stringify(modelOp)}`)
  const promptOp = plan.ops.find((op) => op.path.join(".") === "agent.general.prompt")
  assert(promptOp && promptOp.value === "You are general.", `template must materialize: ${JSON.stringify(promptOp)}`)
  const tempOp = plan.ops.find((op) => op.path.join(".") === "agent.general.temperature")
  assert(tempOp && tempOp.value === 0.3, "plain values pass through")
  assert(!plan.ops.some((op) => op.path.includes("prompt_prepend")), "prepend fields must not migrate")
  assert(JSON.stringify(plan.sidecarRemovals) === JSON.stringify(["model", "temperature", "prompt"]), `removals wrong: ${JSON.stringify(plan.sidecarRemovals)}`)
  assert(plan.notes.some((note) => note.includes("materialized")), "template materialization must be noted")
}

{
  section("migration: nothing savable + unknown preset kept raw")
  const empty = { agents: { general: { parent: { prompt_append: "x" }, variants: {} } }, models: {}, routing: { prompt_markers: false } }
  assert(savableParentFields(empty, "general").length === 0, "append-only parent has nothing savable")
  assert(buildMigrationPlan(empty, "general") === undefined, "no plan for nothing savable")

  const broken = { agents: { general: { parent: { model: "nonexistent-preset" }, variants: {} } }, models: {}, routing: { prompt_markers: false } }
  const plan = buildMigrationPlan(broken, "general")
  assert(plan, "plan builds for unknown preset")
  const modelOp = plan.ops.find((op) => op.path.join(".") === "agent.general.model")
  assert(modelOp && modelOp.value === "nonexistent-preset", "unresolvable preset keeps raw value")
}

// ---------------------------------------------------------------------------
// palette-category: runtime registry join
// ---------------------------------------------------------------------------

{
  section("palette-category: registry declaration and joins")
  palette.__resetPaletteRegistry()

  const avCommand = { category: "" }
  assert(palette.declarePaletteCategory("Agent Variants", avCommand) === "Agent Variants", "lone declaration returns its own name")
  assert(avCommand.category === "Agent Variants", "lone declaration stamps its command")

  const studioCommand = { category: "" }
  assert(palette.declarePaletteCategory("Config Studio", studioCommand) === "Agent Variants & Config Studio", "second declaration returns the join")
  assert(avCommand.category === "Agent Variants & Config Studio", "earlier command mutated to the join")
  assert(palette.currentPaletteCategory() === "Agent Variants & Config Studio", "live getter matches")

  const soukCommand = { category: "" }
  palette.declarePaletteCategory("Souk", soukCommand)
  const expected = "Agent Variants, Config Studio & Souk"
  assert(soukCommand.category === expected, "three-way join stamped")
  assert(avCommand.category === expected && studioCommand.category === expected, "all commands mutated to the three-way join")

  palette.declarePaletteCategory("Agent Variants")
  assert(palette.currentPaletteCategory() === expected, "duplicate label does not duplicate in the join")

  avCommand.category = "stale"
  palette.reconcilePaletteCategories()
  assert(avCommand.category === expected, "reconcile repairs stale categories")

  palette.__resetPaletteRegistry()
  assert(palette.currentPaletteCategory() === "", "reset clears the registry")
}

console.log("all unit tests passed")
