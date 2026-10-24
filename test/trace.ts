import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { inspect } from "node:util"
import { tokenKey } from "../src/cache.ts"
import { Account, trace, traceForTests, type Trace } from "../src/trace.ts"

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0cmFjZSJ9.c2lnbmF0dXJlLXRyYWNlLXRlc3Q"
const OTHER = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvdGhlciJ9.c2lnbmF0dXJlLW90aGVyLXRlc3Q"

afterEach(() => traceForTests(false))

function journal(): Trace {
  traceForTests(true)
  assert.ok(trace, "traceForTests(true) turns the journal on")
  return trace
}

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("note ignores a kind it does not know", async () => {
  const t = journal()
  await t.within({ token: TOKEN }, async () => {
    t.note("bogus" as never, {} as never)
    t.note("toString" as never, {} as never)
  })
  assert.deepEqual(t.turns()[0].entries, [])
})

test("identical neighbours in a turn fold into one entry with a count", async () => {
  const t = journal()
  await t.within({ token: TOKEN }, async () => {
    for (const status of [503, 503, 503, 429, 503]) t.note("usage", { status })
  })
  assert.deepEqual(
    t.turns()[0].entries.map((e) => [e.kind === "usage" && e.outcome === "unavailable" ? e.status : 0, e.count]),
    [[503, 3], [429, 1], [503, 1]],
  )
})

test("a turn keeps 32 decisions and counts the ones after", async () => {
  const t = journal()
  await t.within({ token: TOKEN }, async () => {
    for (let i = 0; i < 34; i++) t.note("usage", { status: 500 + i })
  })
  const [log] = t.turns()
  assert.equal(log.entries.length, 32)
  assert.equal(log.dropped, 2)
})

test("the journal keeps the last 16 turns, oldest first", async () => {
  const t = journal()
  for (let i = 0; i < 18; i++) await t.within({ token: TOKEN, model: `model-${i}` }, async () => {})
  assert.deepEqual(t.turns().map((log) => log.turn), Array.from({ length: 16 }, (_, i) => i + 3))
  assert.equal(t.turns().at(-1)?.model, "model-17")
})

test("two concurrent turns keep their decisions apart across awaits and timers", async () => {
  const t = journal()
  const turn = (token: string, status: number, wait: number) =>
    t.within({ token }, async () => {
      await later(wait)
      t.note("usage", { status })
      await later(wait)
      t.note("usage", { status, refused: true })
    })
  await Promise.all([turn(TOKEN, 503, 15), turn(OTHER, 429, 5)])
  const [first, second] = t.turns()
  assert.ok(first.account?.same(Account.of(TOKEN)))
  assert.deepEqual(first.entries.map((e) => (e.kind === "usage" && e.outcome !== "failed" ? `${e.outcome} ${e.status}` : "")), ["unavailable 503", "refused 503"])
  assert.deepEqual(second.entries.map((e) => (e.kind === "usage" && e.outcome !== "failed" ? `${e.outcome} ${e.status}` : "")), ["unavailable 429", "refused 429"])
})

test("carry keeps decisions made while a returned stream is read inside its turn", async () => {
  const t = journal()
  async function* events() {
    await later(1)
    t.note("usage", { status: 503 })
    yield 1
  }
  const [carried, bare] = await t.within({ token: TOKEN }, async () => [t.carry(events()), events()])
  for await (const _ of carried) {}
  for await (const _ of bare) {}
  const [turn, outside] = t.turns()
  assert.equal(turn.entries.length, 1)
  assert.equal(outside.turn, 0)
  assert.equal(outside.account, null)
  assert.equal(outside.entries.length, 1)
})

test("a reason keeps no token, bearer header, fingerprint, or URL path", async () => {
  const t = journal()
  const message = `Bearer ${TOKEN} rejected for ${TOKEN} at https://a.example/agent/secret-path, key ${tokenKey(TOKEN)}`
  await t.within({ token: TOKEN }, async () => {
    t.note("failed", { error: { status: 401, message } })
    t.note("usage", { error: Object.assign(new Error("word ".repeat(60)), { code: "E_LONG" }) })
  })
  const [failed, usage] = t.turns()[0].entries
  assert.ok(failed.kind === "failed" && usage.kind === "usage" && usage.outcome === "failed")
  assert.equal(failed.why, "Bearer [token] rejected for [token] at a.example, key [hex]")
  assert.equal(usage.why.length, 200)
  assert.equal(usage.why.endsWith("…"), true)
})

test("an account compares fingerprints and prints only as a placeholder", () => {
  const account = Account.of(TOKEN)
  assert.equal(String(account), "[account]")
  assert.equal(`${account}`, "[account]")
  assert.equal(JSON.stringify({ account }), '{"account":"[account]"}')
  assert.equal(inspect({ account }), "{ account: [account] }")
  assert.equal(account.is(tokenKey(TOKEN)), true)
  assert.equal(account.is(tokenKey(OTHER)), false)
  assert.equal(account.same(Account.of(TOKEN)), true)
  assert.equal(account.same(Account.of(OTHER)), false)
})

test("CURSOR_DEBUG turns the journal on unless it is empty, 0, false, off, or no", async () => {
  const saved = process.env.CURSOR_DEBUG
  const cases: [string, boolean][] = [["1", true], ["true", true], ["yes", true], ["", false], ["0", false], ["false", false], ["OFF", false], ["no", false]]
  try {
    for (const [value, on] of cases) {
      process.env.CURSOR_DEBUG = value
      const fresh = await import(new URL(`../src/trace.ts?debug=${encodeURIComponent(value)}`, import.meta.url).href)
      assert.equal(fresh.trace !== undefined, on, `CURSOR_DEBUG=${JSON.stringify(value)}`)
    }
  } finally {
    if (saved === undefined) delete process.env.CURSOR_DEBUG
    else process.env.CURSOR_DEBUG = saved
  }
})
