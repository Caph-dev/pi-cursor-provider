import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const src = fileURLToPath(new URL("../src/", import.meta.url))

const unguarded = /\btrace!?\.note\(/

test("the gate tells an unguarded trace.note call from a guarded one", () => {
  assert.equal(unguarded.test('trace.note("retry", raw)'), true)
  assert.equal(unguarded.test('this.wire.trace.note("owner-ended", raw)'), true)
  assert.equal(unguarded.test('trace!.note("usage", raw)'), true)
  assert.equal(unguarded.test('trace?.note("retry", raw)'), false)
  assert.equal(unguarded.test('this.wire.trace?.note("owner-ended", raw)'), false)
})

test("every trace.note call in src skips its arguments while CURSOR_DEBUG is off", () => {
  const found = readdirSync(src)
    .filter((name) => name.endsWith(".ts"))
    .flatMap((name) =>
      readFileSync(join(src, name), "utf8")
        .split("\n")
        .flatMap((line, i) => (unguarded.test(line) ? [`${name}:${i + 1}`] : [])),
    )
  assert.deepEqual(found, [])
})
