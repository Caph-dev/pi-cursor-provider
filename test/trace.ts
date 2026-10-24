import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import http2 from "node:http2"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, afterEach, before, mock, test } from "node:test"
import { inspect } from "node:util"
import { tokenKey } from "../src/cache.ts"
import { frame, pb } from "../src/codec.ts"
import { registerCursorDoctor } from "../src/doctor.ts"
import { clearLedger } from "../src/ledger.ts"
import { clearAgentCache, clearMaxOnly, nativeSessions, resetH1, runAnswer, type RunAnswerOptions } from "../src/run.ts"
import { Account, trace, traceForTests, type Trace } from "../src/trace.ts"

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0cmFjZSJ9.c2lnbmF0dXJlLXRyYWNlLXRlc3Q"
const OTHER = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvdGhlciJ9.c2lnbmF0dXJlLW90aGVyLXRlc3Q"
const saved = { token: process.env.CURSOR_ACCESS_TOKEN, dir: process.env.PI_CODING_AGENT_DIR }
const servers: (() => Promise<void>)[] = []

before(() => {
  process.env.CURSOR_ACCESS_TOKEN = TOKEN
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "cursor-trace-"))
})

after(() => {
  for (const [key, value] of [["CURSOR_ACCESS_TOKEN", saved.token], ["PI_CODING_AGENT_DIR", saved.dir]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

afterEach(async () => {
  traceForTests(false)
  mock.restoreAll()
  for (const close of servers.splice(0)) await close()
  await nativeSessions.clear()
  resetH1()
  clearAgentCache()
  clearMaxOnly()
  clearLedger()
})

function journal(): Trace {
  traceForTests(true)
  assert.ok(trace, "traceForTests(true) turns the journal on")
  return trace
}

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function doctor(): Promise<string> {
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined
  registerCursorDoctor({ registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler } } as never)
  let text = ""
  await handler?.("", { ui: { notify: (message: string) => { text = message } } })
  return text
}

/** The doctor's lines for one turn, from its heading to the next turn's. */
function turnLines(text: string, turn: number): string[] {
  const lines = text.split("\n")
  const start = lines.findIndex((line) => line.startsWith(`  Turn ${turn} at `))
  assert.notEqual(start, -1, `turn ${turn} is listed`)
  const end = lines.findIndex((line, i) => i > start && !line.startsWith("    "))
  return lines.slice(start, end === -1 ? undefined : end)
}

async function answer(extra: Partial<RunAnswerOptions> = {}) {
  const ran = await runAnswer({
    tok: TOKEN,
    model: "composer-test",
    messages: [{ role: "user", content: "hi" }],
    rawModels: [],
    session: `trace-${Math.random()}`,
    resolveAgentURL: async () => "https://a.example/agent",
    headerWaitMs: 2_000,
    ...extra,
  })
  const events: unknown[] = []
  for await (const event of ran.events ?? []) events.push(event)
  return { ...ran, events }
}

const message = (body: Buffer) => frame(body)
const text = (s: string) => message(pb().bytes(1, pb().bytes(1, pb().str(1, s).done())).done())
function end(json = "") {
  const last = frame(Buffer.from(json))
  last[0] = 2
  return last
}

/** A local h2c server. Each Run gets reply's frames once the client has sent its first message. */
async function cursor(reply: () => Buffer[], delayMs = 0): Promise<(origin: string) => unknown> {
  const server = http2.createServer()
  const sessions = new Set<http2.Http2Session>()
  server.on("session", (session) => sessions.add(session))
  server.on("stream", (stream) => {
    stream.on("error", () => {})
    stream.respond({ ":status": 200 })
    stream.once("data", async () => {
      await later(delayMs)
      for (const f of reply()) stream.write(f)
      stream.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  servers.push(async () => {
    for (const session of sessions) session.destroy()
    await new Promise((resolve) => server.close(resolve))
  })
  return () => {
    const session = http2.connect(`http://127.0.0.1:${port}`)
    sessions.add(session)
    return session
  }
}

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

test("the doctor lists each turn with its transport, and why HTTP/1.1 took over", async () => {
  journal()
  await answer({ connect: await cursor(() => [text("done"), end()]) })
  mock.method(http2, "connect", () => {
    throw new Error("alpn negotiation failed")
  })
  mock.method(globalThis, "fetch", async () => new Response("no", { status: 503 }))
  await answer({ headerWaitMs: 30 })
  await answer({ headerWaitMs: 30 })
  const report = await doctor()
  const clock = "\\d\\d:\\d\\d:\\d\\dZ"
  assert.match(turnLines(report, 1).join("\n"), new RegExp(`^  Turn 1 at ${clock}, composer-test, this account\n(.*\n)*    run: h2 to a\\.example$`, "m"))
  assert.match(turnLines(report, 2).join("\n"), new RegExp(`^    run: h1 to api2\\.cursor\\.sh\\. HTTP/2 to a\\.example failed \\(alpn negotiation failed\\), sticky until ${clock}\\.$`, "m"))
  assert.match(turnLines(report, 3).join("\n"), new RegExp(`^    run: h1 to api2\\.cursor\\.sh, sticky until ${clock}$`, "m"))
})
