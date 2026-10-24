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
import { STEP_WAIT, clearLedger } from "../src/ledger.ts"
import { clearAgentCache, clearMaxOnly, nativeSessions, resetH1, runAnswer, type RunAnswerOptions } from "../src/run.ts"
import { Account, trace, traceForTests, type Trace } from "../src/trace.ts"

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0cmFjZSJ9.c2lnbmF0dXJlLXRyYWNlLXRlc3Q"
const OTHER = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvdGhlciJ9.c2lnbmF0dXJlLW90aGVyLXRlc3Q"
const saved = { token: process.env.CURSOR_ACCESS_TOKEN, dir: process.env.PI_CODING_AGENT_DIR }
const wait = { ...STEP_WAIT }
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
  Object.assign(STEP_WAIT, wait)
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

/** A local h2c server. Each Run gets reply's bytes once the client has sent its first message. cut resets the stream after them. */
async function cursor(reply: () => Buffer[], { status = 200, delayMs = 0, cut = false } = {}): Promise<(origin: string) => unknown> {
  const server = http2.createServer()
  const sessions = new Set<http2.Http2Session>()
  server.on("session", (session) => sessions.add(session))
  server.on("stream", (stream) => {
    stream.on("error", () => {})
    stream.respond({ ":status": status })
    stream.once("data", async () => {
      await later(delayMs)
      for (const f of reply()) stream.write(f)
      if (cut) stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR)
      else stream.end()
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

const historical = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "", tool_calls: [{ id: "call_cursor_ab_0_0", type: "function", function: { name: "bash", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "call_cursor_ab_0_0", content: "ok" },
  { role: "user", content: "next" },
]

test("the doctor shows a native Run created, or declined with prepare's reason", async () => {
  journal()
  const connect = await cursor(() => [text("done"), end()])
  const created = await answer({ connect })
  const declined = await answer({ connect, messages: historical })
  assert.deepEqual([created.error, declined.error], [undefined, undefined])
  const report = await doctor()
  assert.deepEqual(turnLines(report, 1).slice(1), ["    native: created", "    run: h2 to a.example"])
  assert.deepEqual(turnLines(report, 2).slice(1), ["    native: declined, historical native calls", "    run: h2 to a.example"])
})

test("the doctor shows why a native owner ended, which fail() forgets", async () => {
  journal()
  const connect = await cursor(() => [end(JSON.stringify({ error: { code: "unavailable", message: "overloaded" } }))])
  const ran = await answer({ connect })
  assert.equal(ran.error?.message, "overloaded")
  assert.deepEqual(turnLines(await doctor(), 1).slice(1), [
    "    native: created",
    "    run: h2 to a.example",
    "    owner ended: failed, composer-test (overloaded)",
    "    failed (503, overloaded)",
  ])
})

test("CURSOR_DEBUG keeps region and max-mode retry reasons and the doctor prints them", async () => {
  journal()
  const regional = () => {
    throw new Error("not in this region")
  }
  await answer({
    connect: regional,
    resolveAgentURL: async (_token: string, fresh: boolean) => (fresh ? "https://b.example/agent" : "https://a.example/agent"),
  })
  await answer({ connect: regional })
  await answer({
    model: "composer-max",
    connect: () => {
      throw new Error("Max Mode required")
    },
  })
  const report = await doctor()
  assert.match(turnLines(report, 1).join("\n"), /^ {4}region error \(502, not in this region\)\. Retried on b\.example\.$/m)
  assert.match(turnLines(report, 2).join("\n"), /^ {4}region error \(502, not in this region\)\. Not retried because the agent host did not change and the Run used HTTP\/2\.$/m)
  assert.match(turnLines(report, 3).join("\n"), /^ {4}max mode required for composer-max \(502, Max Mode required\)\. Retried with max mode\.$/m)
})

test("the doctor shows a failed turn's reason without the token, its fingerprint, a bearer header, or a URL path", async () => {
  journal()
  await answer({
    connect: () => {
      throw new Error(`Bearer ${TOKEN} rejected at https://a.example/agent/secret-path`)
    },
  })
  const report = await doctor()
  assert.match(turnLines(report, 1).join("\n"), /^ {4}failed \(502, Bearer \[token\] rejected at a\.example\)$/m)
  for (const leak of [TOKEN, tokenKey(TOKEN).slice(0, 8), `Bearer ${TOKEN.slice(0, 6)}`, "/secret-path"]) {
    assert.equal(report.includes(leak), false, leak)
  }
})

test("the doctor says when a failed Run's error body was cut short", async () => {
  journal()
  const connect = await cursor(() => [Buffer.from('{"error":{"code":"internal","message":"bro')], { status: 500, cut: true })
  const ran = await answer({ connect, messages: historical })
  assert.equal(ran.error?.status, 500)
  assert.match(turnLines(await doctor(), 1).join("\n"), /^ {4}failed \(500, .*\), error body cut short$/m)
})

test("the doctor shows which agent host GetServerConfig named, or why the turn used another", async () => {
  journal()
  let config = () => Response.json({ agentUrlConfig: { agentUrl: "https://agent-eu.example/v1/team-path" } })
  mock.method(globalThis, "fetch", async (url: string | URL) =>
    String(url).endsWith("GetServerConfig") ? config() : new Response("no", { status: 503 }))
  await answer({ connect: await cursor(() => [text("done"), end()]), resolveAgentURL: undefined })
  config = () => new Response("down", { status: 500 })
  await answer({
    resolveAgentURL: undefined,
    connect: () => {
      throw new Error("not in this region")
    },
  })
  clearAgentCache()
  config = () => Response.json({})
  await answer({ connect: await cursor(() => [text("done"), end()]), resolveAgentURL: undefined })
  const report = await doctor()
  assert.equal(turnLines(report, 1)[1], "    endpoint: agent-eu.example, named by GetServerConfig")
  assert.match(turnLines(report, 2).join("\n"), /^ {4}endpoint: kept agent-eu\.example \(.+\)$/m)
  assert.equal(turnLines(report, 3)[1], "    endpoint: agentn.global.api5.cursor.sh, the global default (GetServerConfig named no agent host)")
  assert.equal(report.includes("/team-path"), false)
})

const update = (num: number, body: Buffer) => message(pb().bytes(1, pb().bytes(num, body)).done())
const toolCall = message(
  pb().bytes(2, pb().varint(1, 7).str(15, "x1").bytes(11, pb().str(1, "pi-bash").str(3, "call_1").str(5, "bash").done()).done()).done(),
)

test("usage reads a tool step makes after runAnswer returns stay in its turn, folded", async () => {
  journal()
  Object.assign(STEP_WAIT, { first: 0, every: 5, until: 40 })
  let usage = 503
  mock.method(globalThis, "fetch", async () => new Response("no", { status: usage }))
  const step = {
    connect: await cursor(() => [update(27, pb().varint(1, 1).done()), toolCall]),
    messages: historical,
    tools: [{ name: "bash", description: "", schema: { type: "object", properties: {} } }],
  }
  const first = await answer(step)
  assert.equal((first.events.at(-1) as { stop?: string }).stop, "tool_calls")
  usage = 403
  await answer(step)
  const report = await doctor()
  assert.match(turnLines(report, 1).join("\n"), /^ {4}usage read unavailable \(503\) ×\d+$/m)
  assert.match(turnLines(report, 2).join("\n"), /^ {4}usage read refused \(403\)$/m)
  assert.equal(report.includes("Outside any turn"), false)
  assert.match(report, /^ {2}This account: .*Cursor refuses its usage events until \d\d:\d\d:\d\dZ\.$/m)
})
