// cursor.json decides which models /model offers. A pattern globs the id, a
// missing or malformed file hides nothing, and hiding never touches the ids
// usage reads.
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import { configPath, hidden, hiddenPatterns, visible } from "../src/config.ts"

const dirs: string[] = []

function wrote(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cursor-config-"))
  dirs.push(dir)
  const file = join(dir, "cursor.json")
  writeFileSync(file, text)
  return file
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

test("cursor.json lives in PI_CODING_AGENT_DIR, else ~/.pi/agent", () => {
  assert.equal(configPath({ PI_CODING_AGENT_DIR: "/tmp/agent" }), join("/tmp/agent", "cursor.json"))
  assert.equal(configPath({}), join(process.env.HOME ?? "", ".pi/agent/cursor.json"))
})

test("patterns are trimmed strings; anything else is dropped", () => {
  const file = wrote(JSON.stringify({ hiddenModels: ["  gpt-5  ", "", 7, null, "claude-*"] }))
  assert.deepEqual(hiddenPatterns(file), ["gpt-5", "claude-*"])
})

test("no file, invalid JSON and a wrong shape hide nothing", () => {
  assert.deepEqual(hiddenPatterns(join(tmpdir(), "cursor-config-absent", "cursor.json")), [])
  assert.deepEqual(hiddenPatterns(wrote("{ not json")), [])
  assert.deepEqual(hiddenPatterns(wrote(JSON.stringify({ hiddenModels: "gpt-5" }))), [])
  assert.deepEqual(hiddenPatterns(wrote("null")), [])
})

test("a pattern matches the whole id, ignoring case", () => {
  assert.equal(hidden(["gpt-5"], "gpt-5"), true)
  assert.equal(hidden(["gpt-5"], "gpt-5-mini"), false)
  assert.equal(hidden(["gpt-5"], "GPT-5"), true)
})

test("* stands for any run, and nothing else is a wildcard", () => {
  assert.equal(hidden(["claude-*"], "claude-4.5-sonnet"), true)
  assert.equal(hidden(["claude-*"], "gpt-5"), false)
  assert.equal(hidden(["*-thinking"], "claude-4.5-opus-thinking"), true)
  assert.equal(hidden(["claude-4.5"], "claude-4.5-sonnet"), false)
  // the dot is literal, not "any character"
  assert.equal(hidden(["claude-4.5"], "claude-4x5"), false)
  // and so is the question mark, which must not throw either
  assert.equal(hidden(["a?c"], "a?c"), true)
  assert.equal(hidden(["a?c"], "abc"), false)
  assert.equal(hidden(["?"], "gpt-5"), false)
  assert.equal(hidden(["?"], "?"), true)
})

test("cursor/ is accepted on the id and on the pattern", () => {
  assert.equal(hidden(["gpt-5"], "cursor/gpt-5"), true)
  assert.equal(hidden(["cursor/gpt-5"], "gpt-5"), true)
  assert.equal(hidden(["cursor/gpt-*"], "cursor/gpt-5-mini"), true)
})

test("a pattern without @size hides every context size of that model", () => {
  assert.equal(hidden(["claude-4.5-sonnet"], "claude-4.5-sonnet@300k"), true)
  assert.equal(hidden(["claude-4.5-sonnet@300k"], "claude-4.5-sonnet@300k"), true)
  assert.equal(hidden(["claude-4.5-sonnet@300k"], "claude-4.5-sonnet@1m"), false)
  assert.equal(hidden(["claude-*"], "claude-4.5-sonnet@300k"), true)
})

test("visible keeps order and hides only what matches", () => {
  const models = [{ id: "auto" }, { id: "gpt-5" }, { id: "claude-4.5-sonnet@300k" }]
  assert.deepEqual(visible(models, []).map((m) => m.id), ["auto", "gpt-5", "claude-4.5-sonnet@300k"])
  assert.deepEqual(visible(models, ["claude-*"]).map((m) => m.id), ["auto", "gpt-5"])
  assert.deepEqual(visible(models, ["*@300k"]).map((m) => m.id), ["auto", "gpt-5"])
  assert.deepEqual(visible(models, ["*"]), [])
})
