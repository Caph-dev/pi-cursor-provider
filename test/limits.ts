import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import { clearLimitsRetry, limitIndexOf, limitKey, limitsForCatalogue, packageVersion, readLimits, refreshLimits, writeLimits } from "../src/limits.ts"
import { piModelConfigs } from "../src/models.ts"

const realFetch = globalThis.fetch
const dirs: string[] = []
afterEach(() => {
  globalThis.fetch = realFetch
  clearLimitsRetry()
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "cursor-limits-"))
  dirs.push(dir)
  return join(dir, "cursor-limits.json")
}

const DOC = {
  xai: { models: { "grok-4.7": { id: "xai/grok-4.7", limit: { context: 256000, output: 500000 } } } },
  anthropic: { models: { "claude-opus-5-5": { id: "claude-opus-5-5", limit: { output: 128000 } } } },
  // one provider listing the same model under two ids still votes once
  aggregator: {
    models: {
      "claude-sonnet-5": { limit: { output: 64000 } },
      "anthropic/claude-sonnet-5": { limit: { output: 64000 } },
    },
  },
  second: { models: { "claude-sonnet-5": { limit: { output: 64000 } } } },
  other: { models: { "claude-sonnet-5": { limit: { output: 96000 } }, glm: { limit: { output: 8192 } } } },
  broken: { models: { "no-limit": { id: "no-limit" }, "": { limit: { output: 10 } } } },
  // a provider whose model id is a bare API keyword
  keyword: { models: { default: { limit: { output: 16384 } } } },
}

test("a model id is spelled the same for Cursor and models.dev", () => {
  assert.equal(limitKey("grok-4.7@256k"), "grok-4-7")
  assert.equal(limitKey("xai/grok-4.7"), "grok-4-7")
  assert.equal(limitKey("moonshotai/Kimi-K3"), "kimi-k3")
  assert.equal(limitKey("GLM-5.2"), "glm-5-2")
  assert.equal(limitKey(" claude-opus-5-5 "), "claude-opus-5-5")
  assert.equal(limitKey(undefined), "")
})

test("the index keeps the output limit most providers report, one vote each, ties to the larger", () => {
  const index = limitIndexOf(DOC)
  assert.equal(index.get("grok-4-7"), 500000)
  assert.equal(index.get("claude-opus-5-5"), 128000)
  // the aggregator's two ids for one model are one vote, so 64000 has two votes
  // (aggregator, second) against other's 96000
  assert.equal(index.get("claude-sonnet-5"), 64000)
  const tie = limitIndexOf({ a: { models: { m: { limit: { output: 64000 } } } }, b: { models: { m: { limit: { output: 96000 } } } } })
  assert.equal(tie.get("m"), 96000)
  // a name without a digit is still a model id
  assert.equal(index.get("glm"), 8192)
  assert.equal(index.has("no-limit"), false)
})

test("the stored index round-trips and a malformed file reads as empty", () => {
  const path = tempFile()
  assert.equal(readLimits(path).index.size, 0)
  assert.equal(writeLimits(new Map([["grok-4-7", 500000]]), path, "9.9.9"), true)
  const stored = readLimits(path)
  assert.equal(stored.index.get("grok-4-7"), 500000)
  assert.equal(stored.version, "9.9.9")
  assert.match(readFileSync(path, "utf8"), /"version":"9\.9\.9"/)
  writeFileSync(path, "{ not json")
  assert.deepEqual([...readLimits(path).index], [])
  writeFileSync(path, JSON.stringify({ version: 7, limits: { a: "x", b: -1, c: 12000 } }))
  assert.deepEqual([...readLimits(path).index], [["c", 12000]])
})

test("this package's version and not another one decides whether the file is current", () => {
  assert.ok(packageVersion().length > 0)
  assert.match(packageVersion(), /^\d+\.\d+\.\d+/)
})

test("a catalogue reads the file while it is current and downloads only when it is not", async () => {
  const path = tempFile()
  let reads = 0
  globalThis.fetch = (async () => {
    reads += 1
    return Response.json(DOC)
  }) as typeof fetch
  // no file yet: the install/update read writes one
  const first = await limitsForCatalogue(undefined, path)
  assert.equal(first.get("grok-4-7"), 500000)
  assert.equal(reads, 1)
  assert.equal(readFileSync(path, "utf8").includes(packageVersion()), true)
  // current file: a session start makes no request
  assert.equal((await limitsForCatalogue(undefined, path)).get("grok-4-7"), 500000)
  assert.equal(reads, 1)
  // a version change refreshes once
  writeLimits(new Map([["grok-4-7", 1]]), path, "0.0.1")
  assert.equal((await limitsForCatalogue(undefined, path)).get("grok-4-7"), 500000)
  assert.equal(reads, 2)
})

test("a forced refresh ignores the backoff, and a failure keeps the stored index", async () => {
  const path = tempFile()
  writeLimits(new Map([["grok-4-7", 500000]]), path)
  let mode: "down" | "ok" = "down"
  let reads = 0
  globalThis.fetch = (async () => {
    reads += 1
    if (mode === "down") throw new Error("models.dev is down")
    return Response.json(DOC)
  }) as typeof fetch
  assert.equal(await refreshLimits(undefined, { path }), undefined)
  assert.equal(reads, 1)
  assert.equal(await refreshLimits(undefined, { path }), undefined)
  assert.equal(reads, 1, "a failure backs off instead of retrying on every call")
  assert.equal(await refreshLimits(undefined, { path, force: true }), undefined)
  assert.equal(reads, 2, "the update command asks anyway")
  mode = "ok"
  assert.equal((await refreshLimits(undefined, { path, force: true }))?.get("claude-opus-5-5"), 128000)
  assert.equal(readLimits(path).index.get("claude-opus-5-5"), 128000, "the fresh index is stored")
  // a stored index that is still there serves a later catalogue without a request
  globalThis.fetch = (async () => {
    reads += 1
    throw new Error("no network")
  }) as typeof fetch
  assert.equal((await limitsForCatalogue(undefined, path)).get("claude-opus-5-5"), 128000)
  assert.equal(reads, 3, "the stored index is current, so nothing is fetched")
})

test("concurrent readers share one download", async () => {
  const path = tempFile()
  let reads = 0
  globalThis.fetch = (async () => {
    reads += 1
    await new Promise((resolve) => setTimeout(resolve, 20))
    return Response.json(DOC)
  }) as typeof fetch
  const [a, b] = await Promise.all([refreshLimits(undefined, { path, force: true }), refreshLimits(undefined, { path, force: true })])
  assert.equal(reads, 1)
  assert.equal(a, b)
})

test("cancelling one caller does not cancel the shared download", async () => {
  const path = tempFile()
  let reads = 0
  globalThis.fetch = (async () => {
    reads += 1
    await new Promise((resolve) => setTimeout(resolve, 20))
    return Response.json(DOC)
  }) as typeof fetch
  const controller = new AbortController()
  const cancelled = refreshLimits(controller.signal, { path, force: true })
  const survivor = refreshLimits(undefined, { path, force: true })
  controller.abort()
  await assert.rejects(cancelled, /aborted/)
  assert.equal((await survivor)?.get("grok-4-7"), 500000)
  assert.equal(reads, 1)
})

test("a model config takes the reported output limit, never more than its context", () => {
  const limits = limitIndexOf(DOC)
  const configs = piModelConfigs(
    [
      { id: "grok-4.7@256k", name: "Grok 4.7 @ 256k", run: "grok-4.7", context: 256000, levels: {}, variants: [] },
      { id: "claude-opus-5-5@1m", name: "Claude Opus 5.5", run: "claude-opus-5-5", context: 1000000, levels: {}, variants: [] },
      { id: "composer-2.5", name: "Composer 2.5", run: "composer-2.5", context: 200000, levels: {}, variants: [] },
      { id: "tiny", name: "Tiny", run: "tiny-model", context: 1000, levels: {}, variants: [] },
    ],
    limits,
  )
  // models.dev says 500k, but the 256k entry cannot answer with more than it takes
  assert.equal(configs[0].maxTokens, 256000)
  assert.equal(configs[1].maxTokens, 128000)
  // no entry: the fallback, still no larger than the context
  assert.equal(configs[2].maxTokens, 32000)
  assert.equal(configs[3].maxTokens, 1000)
  assert.equal(piModelConfigs([{ id: "x", name: "X", run: "x", context: 1000, levels: {}, variants: [] }])[0].maxTokens, 1000)
  // `default` is Cursor's name for auto, not a model id models.dev knows
  assert.equal(piModelConfigs([{ id: "auto", name: "Auto", run: "default", context: 200000, levels: {}, variants: [] }], limits)[0].maxTokens, 32000)
})
