/**
 * JSONC edit engine.
 *
 * Edits user config files (opencode.json / opencode.jsonc) surgically through
 * jsonc-parser — the same library OpenCode itself uses to patch its global
 * config in place — so comments, formatting, key order, and trailing commas
 * elsewhere in the file are preserved by construction.
 *
 * Every mutation goes through editConfigFile(): parse-check, backup snapshot,
 * apply edits, atomic write (temp file + rename), and post-write verification.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import * as jsonc from "jsonc-parser"

export type JSONPath = (string | number)[]

export type EditOp =
  | { op: "set"; path: JSONPath; value: unknown }
  | { op: "delete"; path: JSONPath }

export interface FileEditResult {
  ok: boolean
  filePath: string
  before: string
  after: string
  error?: string
  backupId?: string
}

export interface ParseReport {
  data: unknown
  errors: string[]
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseJsonc(text: string): ParseReport {
  const errors: jsonc.ParseError[] = []
  const data = jsonc.parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  return {
    data,
    errors: errors.map((error) => `offset ${error.offset}: ${describeParseError(error.error)}`),
  }
}

function describeParseError(code: number): string {
  switch (code) {
    case jsonc.ParseErrorCode.InvalidSymbol: return "invalid symbol"
    case jsonc.ParseErrorCode.InvalidNumberFormat: return "invalid number format"
    case jsonc.ParseErrorCode.PropertyNameExpected: return "property name expected"
    case jsonc.ParseErrorCode.ValueExpected: return "value expected"
    case jsonc.ParseErrorCode.ColonExpected: return "colon expected"
    case jsonc.ParseErrorCode.CommaExpected: return "comma expected"
    case jsonc.ParseErrorCode.CloseBraceExpected: return "closing brace expected"
    case jsonc.ParseErrorCode.CloseBracketExpected: return "closing bracket expected"
    case jsonc.ParseErrorCode.EndOfFileExpected: return "end of file expected"
    case jsonc.ParseErrorCode.InvalidCommentToken: return "invalid comment"
    case jsonc.ParseErrorCode.UnexpectedEndOfComment: return "unexpected end of comment"
    case jsonc.ParseErrorCode.UnexpectedEndOfString: return "unexpected end of string"
    case jsonc.ParseErrorCode.UnexpectedEndOfNumber: return "unexpected end of number"
    case jsonc.ParseErrorCode.InvalidUnicode: return "invalid unicode escape"
    case jsonc.ParseErrorCode.InvalidEscapeCharacter: return "invalid escape character"
    case jsonc.ParseErrorCode.InvalidCharacter: return "invalid character in string"
    default: return `parse error ${code}`
  }
}

export function isBlank(text: string): boolean {
  return text.trim().length === 0
}

// ---------------------------------------------------------------------------
// Formatting detection
// ---------------------------------------------------------------------------

export function detectFormatting(text: string): jsonc.FormattingOptions {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0 && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
  let insertSpaces = true
  let tabSize = 2
  for (const line of lines) {
    const indent = /^([ \t]+)/.exec(line)
    if (!indent) continue
    if (indent[1].includes("\t")) {
      insertSpaces = false
      tabSize = 4
    } else {
      insertSpaces = true
      tabSize = Math.min(8, Math.max(1, indent[1].length))
    }
    break
  }
  return { insertSpaces, tabSize }
}

// ---------------------------------------------------------------------------
// Reading values at paths
// ---------------------------------------------------------------------------

export function getNodeAtPath(text: string, path: JSONPath): jsonc.Node | undefined {
  const tree = jsonc.parseTree(text)
  if (!tree) return undefined
  return jsonc.findNodeAtLocation(tree, path)
}

export function getValueAtPath(text: string, path: JSONPath): unknown {
  const node = getNodeAtPath(text, path)
  if (!node) return undefined
  return jsonc.getNodeValue(node)
}

export function hasParseErrors(text: string): boolean {
  return parseJsonc(text).errors.length > 0
}

// ---------------------------------------------------------------------------
// Applying edits
// ---------------------------------------------------------------------------

export function applySet(text: string, path: JSONPath, value: unknown): string {
  const edits = jsonc.modify(text, path, value, { formattingOptions: detectFormatting(text) })
  return jsonc.applyEdits(text, edits)
}

export function applyDelete(text: string, path: JSONPath): string {
  const last = path[path.length - 1]
  if (typeof last === "number") {
    const fixed = deleteArrayElementText(text, path)
    if (fixed !== undefined) return fixed
  }
  const edits = jsonc.modify(text, path, undefined, { formattingOptions: detectFormatting(text) })
  return jsonc.applyEdits(text, edits)
}

/**
 * jsonc-parser 3.3.1 corrupts the text when removing the LAST element of an
 * array in compact (single-line) documents. Array-index deletions are
 * therefore computed from the parse tree: last child removes its preceding
 * separator, other children remove themselves plus their trailing comma.
 * Only the removed range is touched - the container never reflows.
 */
function deleteArrayElementText(text: string, path: JSONPath): string | undefined {
  const tree = jsonc.parseTree(text, undefined, { allowTrailingComma: true, disallowComments: false })
  if (!tree) return undefined
  const parent = jsonc.findNodeAtLocation(tree, path.slice(0, -1))
  const index = path[path.length - 1]
  const children = parent?.children
  if (!parent || parent.type !== "array" || !children || typeof index !== "number" || index < 0 || index >= children.length) {
    return undefined
  }
  const node = children[index]!
  if (node.offset < 0) return undefined
  const nodeEnd = node.offset + node.length
  if (index === children.length - 1) {
    const previous = index > 0 ? children[index - 1] : undefined
    const start = previous ? previous.offset + previous.length : parent.offset + 1
    return text.slice(0, start) + text.slice(nodeEnd)
  }
  const next = children[index + 1]!
  return text.slice(0, node.offset) + text.slice(next.offset)
}

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

export function writeTextAtomic(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.config-studio-tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, "utf8")
  try {
    renameSync(tmp, filePath)
  } catch (error) {
    // Windows rename can fail across some setups; fall back to copy + delete.
    try {
      copyFileSync(tmp, filePath)
      rmSync(tmp, { force: true })
    } catch {
      try {
        rmSync(tmp, { force: true })
      } catch {
        // best effort
      }
      throw error
    }
  }
}

// ---------------------------------------------------------------------------
// Backup snapshots
// ---------------------------------------------------------------------------

export interface BackupEntry {
  id: string
  timestamp: number
  target: string
  reason: string
  file: string
}

export interface BackupJournal {
  entries: BackupEntry[]
}

const BACKUP_RETENTION = 40

export function backupsDir(stateDir: string): string {
  return join(stateDir, "backups")
}

function journalPath(stateDir: string): string {
  return join(stateDir, "backup-journal.json")
}

export function loadBackupJournal(stateDir: string): BackupJournal {
  try {
    const file = journalPath(stateDir)
    if (!existsSync(file)) return { entries: [] }
    const parsed = parseJsonc(readFileSync(file, "utf8"))
    if (parsed.errors.length > 0 || !parsed.data || typeof parsed.data !== "object") return { entries: [] }
    const entries = (parsed.data as { entries?: unknown }).entries
    if (!Array.isArray(entries)) return { entries: [] }
    return { entries: entries.filter((entry): entry is BackupEntry => {
      if (!entry || typeof entry !== "object") return false
      const record = entry as Record<string, unknown>
      return typeof record.id === "string" && typeof record.file === "string" && typeof record.target === "string"
    }) }
  } catch {
    return { entries: [] }
  }
}

function saveBackupJournal(stateDir: string, journal: BackupJournal): void {
  try {
    mkdirSync(stateDir, { recursive: true })
    writeTextAtomic(journalPath(stateDir), JSON.stringify(journal, null, 2))
  } catch {
    // Backups are best-effort bookkeeping; never block an edit on them.
  }
}

export function createBackup(stateDir: string, target: string, reason: string, content: string): BackupEntry | undefined {
  try {
    const dir = backupsDir(stateDir)
    mkdirSync(dir, { recursive: true })
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const sanitized = target.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-80)
    const file = join(dir, `${id}.${sanitized}.jsonc`)
    writeFileSync(file, content, "utf8")
    const entry: BackupEntry = { id, timestamp: Date.now(), target, reason, file }
    const journal = loadBackupJournal(stateDir)
    journal.entries.push(entry)
    while (journal.entries.length > BACKUP_RETENTION) journal.entries.shift()
    saveBackupJournal(stateDir, journal)
    return entry
  } catch {
    return undefined
  }
}

export function readBackupContent(entry: BackupEntry): string | undefined {
  try {
    if (!existsSync(entry.file)) return undefined
    return readFileSync(entry.file, "utf8")
  } catch {
    return undefined
  }
}

export function deleteBackup(stateDir: string, id: string): boolean {
  const journal = loadBackupJournal(stateDir)
  const entry = journal.entries.find((item) => item.id === id)
  if (!entry) return false
  try {
    rmSync(entry.file, { force: true })
  } catch {
    // ignore
  }
  journal.entries = journal.entries.filter((item) => item.id !== id)
  saveBackupJournal(stateDir, journal)
  return true
}

// ---------------------------------------------------------------------------
// The guarded edit entry point
// ---------------------------------------------------------------------------

export interface EditConfigOptions {
  stateDir: string
  reason: string
  backup?: boolean
}

export function editConfigFile(filePath: string, ops: EditOp[], options: EditConfigOptions): FileEditResult {
  const before = existsSync(filePath) ? readFileSync(filePath, "utf8") : ""

  if (before.trim().length > 0) {
    const report = parseJsonc(before)
    if (report.errors.length > 0) {
      return { ok: false, filePath, before, after: before, error: `Refusing to edit: file has JSONC parse errors (${report.errors[0]})` }
    }
  }

  let after = before
  try {
    for (const op of ops) {
      after = op.op === "set" ? applySet(after, op.path, op.value) : applyDelete(after, op.path)
    }
  } catch (error) {
    return { ok: false, filePath, before, after: before, error: `Edit failed: ${error instanceof Error ? error.message : String(error)}` }
  }

  if (after === before) {
    return { ok: false, filePath, before, after, error: "No changes were produced" }
  }

  const verify = parseJsonc(after)
  if (verify.errors.length > 0) {
    return { ok: false, filePath, before, after: before, error: `Refusing to write: edit introduced parse errors (${verify.errors[0]})` }
  }

  // Batch verification: replay the ops on the parsed original and compare.
  // (Per-pointer checks cannot express array deletions, where indices shift.)
  const beforeData = before.trim().length > 0 ? parseJsonc(before).data : {}
  const expected = applyOpsToData(beforeData, ops)
  if (JSON.stringify(expected) !== JSON.stringify(verify.data)) {
    return { ok: false, filePath, before, after: before, error: "Verification failed: edits did not land as expected" }
  }

  let backupId: string | undefined
  if (options.backup !== false && before.trim().length > 0) {
    const entry = createBackup(options.stateDir, filePath, options.reason, before)
    backupId = entry?.id
  }

  try {
    writeTextAtomic(filePath, after)
  } catch (error) {
    return { ok: false, filePath, before, after: before, error: `Write failed: ${error instanceof Error ? error.message : String(error)}` }
  }

  // Read-back verification from disk.
  const reread = existsSync(filePath) ? readFileSync(filePath, "utf8") : ""
  if (reread !== after) {
    return { ok: false, filePath, before, after: reread, error: "Read-back mismatch after write; file may have changed concurrently", backupId }
  }

  return { ok: true, filePath, before, after, backupId }
}

export function createConfigFile(filePath: string, schemaUrl = "https://opencode.ai/config.json"): { ok: boolean; error?: string } {
  if (existsSync(filePath)) return { ok: false, error: "File already exists" }
  const content = `{\n  "$schema": "${schemaUrl}"\n}\n`
  try {
    writeTextAtomic(filePath, content)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatPath(path: JSONPath): string {
  return path
    .map((segment, index) => (typeof segment === "number" ? `[${segment}]` : index === 0 ? String(segment) : `.${segment}`))
    .join("")
}

/** Reads a JSON pointer from parsed data (no text round-trip). */
export function getAtPath(data: unknown, path: JSONPath): unknown {
  let current: unknown = data
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined
      current = current[segment]
      continue
    }
    if (!isPlainObject(current)) return undefined
    current = current[segment]
  }
  return current
}

/** Applies EditOps to parsed data, returning a new tree (staged-save overlay). */
export function applyOpsToData<T>(data: T, ops: EditOp[]): T {
  const root = deepClone(data) as Record<string, unknown> | unknown
  if (!isPlainObject(root)) return root as T
  for (const op of ops) {
    if (op.path.length === 0) continue
    const last = op.path[op.path.length - 1]!
    if (typeof last === "number") {
      const containerPath = op.path.slice(0, -1)
      let container = getAtPath(root, containerPath)
      if (container === undefined && op.op === "set") {
        // Mirror jsonc modify: setting an index on a missing array creates it.
        const fresh: unknown[] = []
        setAtPath(root, containerPath, fresh)
        container = fresh
      }
      if (!Array.isArray(container)) continue
      if (op.op === "set") container[last] = deepClone(op.value)
      else container.splice(last, 1)
      continue
    }
    if (op.op === "set") {
      // Ensure intermediate containers exist (mirrors jsonc modify on text).
      let current: Record<string, unknown> = root
      let ok = true
      for (const segment of op.path.slice(0, -1)) {
        if (typeof segment === "number") {
          ok = false
          break
        }
        const next = current[segment]
        if (isPlainObject(next)) {
          current = next
          continue
        }
        if (next === undefined || next === null) {
          const created: Record<string, unknown> = {}
          current[segment] = created
          current = created
          continue
        }
        ok = false
        break
      }
      if (ok) current[last] = deepClone(op.value)
      continue
    }
    const container = getAtPath(root, op.path.slice(0, -1))
    if (isPlainObject(container)) delete container[last]
  }
  return root as T
}

/** Writes a value at a JSON pointer, creating intermediate objects. */
function setAtPath(root: Record<string, unknown>, path: JSONPath, value: unknown): void {
  let current: Record<string, unknown> = root
  for (const segment of path.slice(0, -1)) {
    if (typeof segment === "number") return
    const next = current[segment]
    if (isPlainObject(next)) {
      current = next
      continue
    }
    if (next === undefined || next === null) {
      const created: Record<string, unknown> = {}
      current[segment] = created
      current = created
      continue
    }
    return
  }
  const last = path[path.length - 1]!
  if (typeof last !== "number") current[last] = value
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
