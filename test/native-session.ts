import assert from "node:assert/strict"
import { test } from "node:test"
import { pb } from "../src/codec.ts"
import { NativeSessionPool } from "../src/native-session.ts"
import { conversation } from "../src/run.ts"

const tools = [{ name: "echo", description: "echo", schema: { type: "object" }, schemaText: '{"type":"object"}' }]
const wire = { pb, exec: () => null, usageOf: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }), failure: () => ({ status: 500, message: "x" }) }

function chat(messages: unknown[]) {
  return { model: "synthetic-model", messages }
}

test("conversation estimates prompt tokens from text and tool schemas", () => {
  const conv = conversation(chat([{ role: "user", content: "hello" }]), tools)
  assert.equal(conv.estimate, Math.floor(conv.estimate))
  assert.ok(conv.estimate > 0)
})

test("prepare with no native handle is a create, not a resume", () => {
  const pool = new NativeSessionPool()
  const prepared = pool.prepare("synthetic-token", chat([{ role: "user", content: "hello" }]), "session-a", tools) as {
    fallback?: string
    owner?: unknown
    selected?: boolean
    account?: string
  }
  assert.equal(prepared.fallback, undefined)
  assert.equal(prepared.owner, undefined)
  assert.equal(prepared.selected, true)
  assert.equal(typeof prepared.account, "string")
  const owner = pool.create(prepared, { id: "synthetic-model", maxMode: false, params: [] }, wire) as any
  assert.equal(owner.state, "opening")
})

test("prepare falls back when the call_cursor handle has no owner", () => {
  const pool = new NativeSessionPool()
  const prepared = pool.prepare(
    "synthetic-token",
    chat([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_cursor_ab_0_0", type: "function", function: { name: "echo", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_cursor_ab_0_0", content: "ok" },
    ]),
    "session-a",
    tools,
  ) as { fallback?: string }
  assert.deepEqual(prepared, { fallback: "owner unavailable" })
})

test("a sealed batch resumes on the same owner through a fake transport", async () => {
  const pool = new NativeSessionPool()
  const opening = chat([{ role: "user", content: "hello" }])
  const prepared = pool.prepare("synthetic-token", opening, "session-a", tools)
  const owner = pool.create(prepared, { id: "synthetic-model", maxMode: false, params: [] }, wire) as any
  assert.ok(owner)
  const writes: Buffer[] = []
  let closed = 0
  owner.chatTools = tools
  owner.bind({ send: (b: Buffer) => writes.push(Buffer.from(b)), close: () => closed++ }, new Map(), 4)
  owner.listed(1)
  owner.acceptCall({ requestID: 7, execID: "exec-1", nativeID: "native-1", name: "echo", args: "{}" })
  assert.equal(owner.state, "awaiting-results")
  assert.equal(closed, 0)
  const id = owner.segment.calls[0].id
  assert.match(id, /^call_cursor_[a-f0-9]+_0_0$/)

  const streamed = owner.response().events
  const seen = []
  while (true) {
    const next = await streamed.next()
    if (next.done) break
    seen.push(next.value)
    if (next.value?.stop) break
  }
  assert.equal(seen.at(-1)?.stop, "tool_calls")
  assert.equal(seen.some((e) => e.tool?.id === id), true)
  owner.delivered()

  const again = pool.prepare(
    "synthetic-token",
    chat([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id, type: "function", function: { name: "echo", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: id, content: "tool says ok" },
    ]),
    "session-a",
    tools,
  ) as { owner?: unknown; fallback?: string }
  assert.equal(again.owner, owner)
  assert.equal(again.fallback, undefined)
  const resumed = owner.resume({ ...again, estimate: 8 }, undefined)
  assert.equal(owner.state, "running")
  assert.ok(writes.length > 0)
  assert.equal(typeof resumed.events.next, "function")
  assert.equal(closed, 0)
})
