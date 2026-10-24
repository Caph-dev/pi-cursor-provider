// A tool step whose usage event shows only after its wait says 0 used,
// and the conversation's next step collects it. That step's own count is
// its usage; what it collected of an earlier step goes apart, as
// magpie_deferred: a client that reads prompt_tokens as how full the
// context is (pi) once saw an earlier step's prompt added to its own.
import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { pb } from "../src/codec.ts"
import { clearLedger, ledger, owed, misses, STEP_WAIT, usageKey } from "../src/ledger.ts"
import { decode } from "../src/run.ts"

const realFetch = globalThis.fetch
const wait = { ...STEP_WAIT }

afterEach(() => {
  globalThis.fetch = realFetch
  Object.assign(STEP_WAIT, wait)
  clearLedger()
})

const update = (num: number, body: Buffer) => ({ data: pb().bytes(1, pb().bytes(num, body)).done() })
const listed = update(27, pb().varint(1, 1).done())
const call = {
  data: pb()
    .bytes(2, pb().varint(1, 7).str(15, "x1").bytes(11, pb().str(1, "pi-bash").str(3, "call_1").str(5, "bash").done()).done())
    .done(),
}
const tools = [{ name: "bash", description: "", schema: { type: "object", properties: {} } }]

async function step(book: ReturnType<typeof ledger>) {
  const out: { usage?: Record<string, unknown> }[] = []
  for await (const p of decode([listed, call], {
    send() {},
    close() {},
    blobs: new Map(),
    tools,
    estimate: 1,
    stepUsage: book.own.bind(book),
    owedUsage: book.owed.bind(book),
  })) {
    out.push(p as { usage?: Record<string, unknown> })
  }
  book.done()
  return out.at(-1)?.usage as {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details: { cached_tokens: number; cache_write_tokens: number }
    magpie_deferred?: {
      prompt_tokens: number
      completion_tokens: number
      cached_tokens: number
      cache_write_tokens: number
    }
  }
}

const E1 = { inputTokens: 2, outputTokens: 1913, cacheReadTokens: 177533, cacheWriteTokens: 3735 }
const E2 = { inputTokens: 4, outputTokens: 2240, cacheReadTokens: 181266, cacheWriteTokens: 4400 }
const prompt = (e: typeof E1) => e.inputTokens + e.cacheReadTokens + e.cacheWriteTokens

test("a step's prompt_tokens is its own Run's; what it collected of an earlier step is magpie_deferred", async () => {
  Object.assign(STEP_WAIT, { first: 0, every: 10, until: 40, owedAt: 0 })
  const conv = "8a462df8-0000-4000-8000-000000000001"
  const since = Date.now() - 30_000
  const shown: unknown[] = []
  globalThis.fetch = (async () => Response.json({ usageEventsDisplay: shown.map((e) => ({ ...(e as object) })) })) as typeof fetch

  const u1 = await step(ledger("tok", conv, since, undefined, true))
  assert.equal(u1.prompt_tokens, 0)
  assert.equal(u1.magpie_deferred, undefined)

  shown.push({ timestamp: String(since + 2000), conversationId: conv, tokenUsage: E1 })
  const since2 = Date.now()
  shown.push({ timestamp: String(since2 + 2000), conversationId: conv, tokenUsage: E2 })
  const u2 = await step(ledger("tok", conv, since2, undefined, true))

  assert.equal(u2.prompt_tokens, prompt(E2))
  assert.equal(u2.total_tokens, prompt(E2) + E2.outputTokens)
  assert.deepEqual(u2.prompt_tokens_details, { cached_tokens: E2.cacheReadTokens, cache_write_tokens: E2.cacheWriteTokens })
  assert.deepEqual(u2.magpie_deferred, {
    prompt_tokens: prompt(E1),
    completion_tokens: E1.outputTokens,
    cached_tokens: E1.cacheReadTokens,
    cache_write_tokens: E1.cacheWriteTokens,
  })
  assert.equal(u1.prompt_tokens + u2.prompt_tokens + (u2.magpie_deferred?.prompt_tokens ?? 0), prompt(E1) + prompt(E2))
})

test("distinct same-millisecond events in one response are billed together, not again on later fetches", async () => {
  Object.assign(STEP_WAIT, { first: 0, every: 1, until: 5, owedAt: 60_000 })
  const tok = "same-millisecond-account"
  const conv = "same-millisecond-conversation"
  const since = Date.now() - 30_000
  let shown: unknown[] = []
  globalThis.fetch = (async () => Response.json({ usageEventsDisplay: shown })) as typeof fetch
  const first = await step(ledger(tok, conv, since, undefined, true))
  const second = await step(ledger(tok, conv, since + 1, undefined, true))
  assert.deepEqual([first.prompt_tokens, second.prompt_tokens], [0, 0])
  const timestamp = String(since + 2000)
  shown = [E1, E2].map((tokenUsage) => ({ timestamp, conversationId: conv, tokenUsage }))
  const final = ledger(tok, conv, Date.now(), undefined, true)
  const billed = await final.owed(true)
  final.done()
  assert.deepEqual(billed, {
    input: E1.inputTokens + E2.inputTokens,
    output: E1.outputTokens + E2.outputTokens,
    cacheRead: E1.cacheReadTokens + E2.cacheReadTokens,
    cacheWrite: E1.cacheWriteTokens + E2.cacheWriteTokens,
    reasoning: 0,
  })
  assert.equal(owed.has(usageKey(tok, conv)), false)
  const next = await step(ledger(tok, conv, since + 2, undefined, true))
  assert.equal(next.prompt_tokens, 0)
  assert.equal(next.magpie_deferred, undefined)
})

test("a step that owed nothing has no magpie_deferred", async () => {
  Object.assign(STEP_WAIT, { first: 0, every: 10, until: 200, owedAt: 0 })
  const conv = "8a462df8-0000-4000-8000-000000000002"
  const since = Date.now()
  globalThis.fetch = (async () =>
    Response.json({
      usageEventsDisplay: [{ timestamp: String(since + 2000), conversationId: conv, tokenUsage: E1 }],
    })) as typeof fetch
  const u = await step(ledger("tok", conv, since, undefined, true))
  assert.equal(u.prompt_tokens, prompt(E1))
  assert.equal(u.magpie_deferred, undefined)
})

test("clearLedger empties owed and misses", () => {
  owed.set("x", { since: Date.now(), n: 1, ready: Date.now(), carry: null })
  misses.set("y", 2)
  clearLedger()
  assert.equal(owed.size, 0)
  assert.equal(misses.size, 0)
})
