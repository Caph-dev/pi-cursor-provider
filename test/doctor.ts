import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import http2 from "node:http2"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, mock, test } from "node:test"
import { tokenKey } from "../src/cache.ts"
import { failure, pb } from "../src/codec.ts"
import { registerCursorDoctor } from "../src/doctor.ts"
import { STEP_WAIT, clearLedger, misses, owe, owed, unreadable, usageKey } from "../src/ledger.ts"
import { agentURL, clearAgentCache, clearMaxOnly, endpointCacheKeys, nativeSessions, resetH1, runAnswer } from "../src/run.ts"
import { traceForTests } from "../src/trace.ts"

const TOKEN = "doctor-token-doctor-token"
const OTHER = "other-token-other-token-x"
const NOW = Date.UTC(2026, 9, 25, 13, 55, 0)
const saved = { token: process.env.CURSOR_ACCESS_TOKEN, dir: process.env.PI_CODING_AGENT_DIR }

let now = NOW
let respond: (url: string) => Response | Promise<Response> = () => new Response("no", { status: 503 })

beforeEach(() => {
  now = NOW
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "cursor-doctor-"))
  process.env.CURSOR_ACCESS_TOKEN = TOKEN
  traceForTests(false)
  mock.method(Date, "now", () => now)
  mock.method(globalThis, "fetch", async (url: string | URL) => respond(String(url)))
})

afterEach(async () => {
  mock.restoreAll()
  for (const [key, value] of [["CURSOR_ACCESS_TOKEN", saved.token], ["PI_CODING_AGENT_DIR", saved.dir]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  traceForTests(false)
  resetH1()
  clearAgentCache()
  clearMaxOnly()
  clearLedger()
  await nativeSessions.clear()
})

async function read(args = ""): Promise<{ text: string; level?: string }> {
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined
  registerCursorDoctor({ registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler } } as never)
  const notices: { text: string; level?: string }[] = []
  await handler?.(args, { ui: { notify: (text: string, level?: string) => notices.push({ text, level }) } })
  assert.equal(notices.length, 1, "the doctor sends one notice")
  return notices[0]
}

function serverConfig(agentUrl: string) {
  respond = (url) => (url.endsWith("GetServerConfig") ? Response.json({ agentUrlConfig: { agentUrl } }) : new Response("no", { status: 503 }))
}

const wire = { pb, exec: () => null, usageOf: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }), failure }

function owner(tok: string, selector: string): any {
  const chat = { model: "synthetic-model", messages: [{ role: "user", content: "hello" }] }
  const made: any = nativeSessions.create(nativeSessions.prepare(tok, chat, selector, []), { id: "synthetic-model", maxMode: false, params: [] }, wire)
  assert.equal(made.state, "opening", "create returned an owner")
  return made
}

async function complete(made: any) {
  made.bind({ send() {}, close() {} }, new Map(), 4)
  await made.pump([{ data: pb().bytes(1, pb().bytes(1, pb().str(1, "done").done())).done() }, { end: true, data: Buffer.alloc(0) }])
  assert.equal(made.state, "complete")
}

async function stickHttp1() {
  mock.method(http2, "connect", () => {
    throw new Error("alpn negotiation failed")
  })
  await runAnswer({
    tok: TOKEN,
    model: "composer-test",
    messages: [{ role: "user", content: "hi" }],
    rawModels: [],
    session: "doctor-h1",
    resolveAgentURL: async () => "https://agent.example/v1",
    headerWaitMs: 30,
  })
}

test("the doctor shows the transport, agent host, native owners, and ledger without a token or a path", async () => {
  serverConfig("https://agent-eu.example/v1/team-path")
  await agentURL(TOKEN, true)
  await agentURL(OTHER, true)
  await stickHttp1()
  await complete(owner(OTHER, "doctor-other"))
  owner(TOKEN, "doctor-session")
  owe(usageKey(TOKEN, "conversation-a"), { since: NOW, n: 2, ready: NOW })
  misses.set(tokenKey(TOKEN), 3)
  unreadable.set(tokenKey(OTHER), NOW)
  const { text, level } = await read()
  assert.equal(level, "warning")
  assert.match(text, /^Cursor doctor at 13:55:00Z$/m)
  assert.match(text, /^Credential: environment\. Token not shown\./m)
  assert.match(text, /^Transport: h1, sticky until 14:05:00Z\. HTTP\/2 failed on this network, so Runs use HTTP\/1\.1 at api2\.cursor\.sh until then\.$/m)
  assert.match(text, /^Agent host: agent-eu\.example, named by GetServerConfig, asked again after 14:05:00Z\. 1 other account has a cached host\.$/m)
  assert.match(text, /^Native owners: 1 active, 1 kept for replay \(limits 8 per account, 32 per process\)\.$/m)
  assert.match(text, /^ {2}complete, synthetic-model, 0 tool rounds, kept for replay, another account$/m)
  assert.match(text, /^ {2}opening, synthetic-model, 0 tool rounds, lifetime ends 14:10:00Z, this account$/m)
  assert.match(text, /^Ledger: 2 Runs owed over 1 conversation, 0 collections running, 1 account unreadable\.$/m)
  assert.match(text, /^ {2}This account: 2 Runs owed, 3 usage misses in a row, so steps skip the usage wait\. Usage events readable\.$/m)
  assert.match(text, /^Decision journal off\. Start Pi with CURSOR_DEBUG=1 to record retry and fallback reasons\.$/m)
  for (const secret of [TOKEN, OTHER, tokenKey(TOKEN), tokenKey(TOKEN).slice(0, 8), tokenKey(OTHER).slice(0, 8), "/team-path"]) {
    assert.equal(text.includes(secret), false, secret)
  }
})

test("a doctor read changes no store, and two reads at the same clock match", async () => {
  serverConfig("https://agent-eu.example/v1")
  await agentURL(TOKEN, true)
  const live = owner(TOKEN, "doctor-session")
  unreadable.set(tokenKey(TOKEN), NOW)
  owed.set(usageKey(TOKEN, "old"), { since: NOW, n: 1, ready: NOW, carry: null })
  now = NOW + STEP_WAIT.owedFor + 1
  respond = () => assert.fail("the doctor sent a request")
  const first = await read()
  const second = await read()
  assert.equal(second.text, first.text)
  assert.equal(first.level, "info")
  assert.match(first.text, /^Agent host: none cached for this account\. The next turn asks GetServerConfig\.$/m)
  assert.match(first.text, /^ {2}This account: 0 Runs owed, 0 usage misses in a row\. Usage events readable\.$/m)
  assert.deepEqual(endpointCacheKeys(), [tokenKey(TOKEN)])
  assert.equal(unreadable.has(tokenKey(TOKEN)), true)
  assert.equal(owed.has(usageKey(TOKEN, "old")), true)
  assert.equal(live.state, "opening")
  assert.equal(nativeSessions.state().owners.length, 1)
})

test("the doctor says when it was given arguments and when the journal has no turn yet", async () => {
  traceForTests(true)
  const { text } = await read("extra")
  assert.match(text, /^Decision journal on \(CURSOR_DEBUG\)\. No turn has run yet\.$/m)
  assert.equal(text.endsWith("\nThis command does not take arguments."), true)
})
