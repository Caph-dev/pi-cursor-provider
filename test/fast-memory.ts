import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { canonicalCwd, fastMemoryPath, readFastMemory, writeFastDirectory } from "../src/fast-memory.ts"

const root = mkdtempSync(join(tmpdir(), "cursor-fast-file-"))
after(() => rmSync(root, { recursive: true, force: true }))

test("fast memory keeps enabled models by canonical directory and drops an empty one", () => {
  const dir = mkdtempSync(join(root, "case-"))
  const project = join(dir, "project")
  const alias = join(dir, "alias")
  mkdirSync(join(project, "nested"), { recursive: true })
  symlinkSync(project, alias)
  const path = join(dir, "cursor-fast.json")
  try {
    assert.equal(fastMemoryPath({ PI_CODING_AGENT_DIR: dir }), path)
    assert.equal(fastMemoryPath({}), join(process.env.HOME ?? "", ".pi", "agent", "cursor-fast.json"))
    assert.deepEqual([...readFastMemory(path)], [])
    writeFileSync(path, "{ not json")
    assert.deepEqual([...readFastMemory(path)], [])

    const key = canonicalCwd(project)
    if (!key) assert.fail("project has no canonical path")
    assert.equal(writeFastDirectory(join(alias, "nested", ".."), [" grok ", "grok", "", 7 as never], path), true)
    assert.deepEqual(readFastMemory(path).get(key), ["grok"])
    const raw = JSON.parse(readFileSync(path, "utf8")) as { directories: Record<string, string[]> }
    assert.deepEqual(Object.keys(raw.directories), [key])

    assert.equal(writeFastDirectory(project, [], path), true)
    assert.equal(readFastMemory(path).has(key), false)
    assert.equal(writeFastDirectory(" ", ["grok"], path), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a malformed fast memory file is ignored entry by entry", () => {
  const dir = mkdtempSync(join(root, "malformed-"))
  const path = join(dir, "cursor-fast.json")
  try {
    writeFileSync(path, JSON.stringify({
      directories: { "/work": ["kept", " ", 3], " ": ["dropped"], nope: "grok" },
      extra: true,
    }))
    assert.deepEqual([...readFastMemory(path)], [["/work", ["kept"]]])
    writeFileSync(path, JSON.stringify({ directories: ["/work"] }))
    assert.deepEqual([...readFastMemory(path)], [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
