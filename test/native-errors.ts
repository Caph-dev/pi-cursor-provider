import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { afterEach, test } from "node:test"
import { pb } from "../src/codec.ts"
import { NATIVE_LIMITS, NativeSessionError, NativeSessionPool, nativeFields, nativeMcpArgs } from "../src/native-session.ts"

const token = "synthetic-token"
const tools = [{ name: "echo", description: "echo", schema: { type: "object" }, schemaText: '{"type":"object"}' }]
const resolution = { id: "synthetic-model", maxMode: false, params: [] }
const wire = {
  pb,
  exec: () => null,
  usageOf: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }),
  failure: (status: number, data: Buffer) => (data.length ? JSON.parse(String(data)) : { status, message: "" }),
}
const opening = [{ role: "user", content: "hello" }]
const image = { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }

const pools: NativeSessionPool[] = []
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.clear()))
})

function newPool(limits: Partial<typeof NATIVE_LIMITS> = {}) {
  const pool = new NativeSessionPool({ ...NATIVE_LIMITS, ...limits })
  pools.push(pool)
  return pool
}

function chat(messages: unknown[]) {
  return { model: "synthetic-model", messages }
}

function prepare(pool: NativeSessionPool, messages: unknown[], tok = token, selector = "session-a"): any {
  return pool.prepare(tok, chat(messages), selector, tools)
}

function create(pool: NativeSessionPool, tok = token, selector = "session-a"): any {
  return pool.create(prepare(pool, opening, tok, selector), resolution, wire)
}

function bind(owner: any, blobs = new Map<string, Buffer>()) {
  const writes: Buffer[] = []
  owner.bind({ send: (b: Buffer) => writes.push(Buffer.from(b)), close() {} }, blobs, 4)
  return writes
}

function running(limits: Partial<typeof NATIVE_LIMITS> = {}, blobs = new Map<string, Buffer>()) {
  const owner = create(newPool(limits))
  return { owner, writes: bind(owner, blobs) }
}

const execCall = (requestID: number) => ({ requestID, execID: `exec-${requestID}`, nativeID: `native-${requestID}`, name: "echo", args: "{}" })

async function sealed(pool: NativeSessionPool, calls = 1, selector = "session-a") {
  const owner = create(pool, token, selector)
  const writes = bind(owner)
  owner.listed(calls)
  for (let i = 0; i < calls; i++) owner.acceptCall(execCall(7 + i))
  const events = owner.response().events
  const ids: string[] = []
  for (let e = await events.next(); !e.value.stop; e = await events.next()) ids.push(e.value.tool.id)
  return { owner, writes, ids }
}

const call = (id: string, args = "{}") => ({ id, type: "function", function: { name: "echo", arguments: args } })
const asked = (ids: string[], fields = {}) => ({ role: "assistant", content: "", tool_calls: ids.map((id) => call(id)), ...fields })
const result = (id: string, content: unknown = "ok") => ({ role: "tool", tool_call_id: id, content })
const results = (ids: string[]) => ids.map((id) => result(id))
const answered = (ids: string[]) => [...opening, asked(ids), ...results(ids)]

const update = (num: number, body: Buffer) => ({ data: pb().bytes(1, pb().bytes(num, body)).done() })
const text = (s: string) => update(1, pb().str(1, s).done())
const turnEnded = update(14, Buffer.alloc(0))
const end = (error?: { status: number; message: string }) => ({ end: true, data: Buffer.from(error ? JSON.stringify(error) : "") })
const reply = async (owner: any) => (await owner.response().events.next()).value

async function complete(owner: any) {
  bind(owner)
  await owner.pump([text("done"), end()])
}

function nativeError(status: number, message: string) {
  return (e: unknown) => {
    assert.ok(e instanceof NativeSessionError)
    assert.deepEqual({ status: (e as NativeSessionError & { status: number }).status, message: e.message }, { status, message })
    return true
  }
}

const malformed: [string, Buffer, string][] = [
  ["a varint that never ends", Buffer.from([0x80]), "malformed native protobuf"],
  ["field number zero", Buffer.from([0x00]), "malformed native protobuf field"],
  ["a length past the end", Buffer.from([0x0a, 0x05, 0x01]), "truncated native protobuf"],
  ["a group wire type", Buffer.from([0x0b]), "unsupported native protobuf wire type"],
]
for (const [name, input, message] of malformed) {
  test(`nativeFields rejects ${name}`, () => {
    assert.throws(() => nativeFields(input), nativeError(502, message))
  })
}

test("nativeFields reads up to maxFields fields and rejects one more", () => {
  const two = pb().varint(1, 1).varint(2, 2).done()
  assert.equal(nativeFields(two, 2).length, 2)
  assert.throws(() => nativeFields(two, 1), nativeError(502, "native protobuf field limit reached"))
})

const entry = (value: Buffer) => pb().bytes(2, pb().str(1, "a").bytes(2, value)).done()
const list = pb().bytes(6, pb().bytes(1, pb().str(3, "x"))).done()

test("nativeMcpArgs decodes a nested list within the default limits", () => {
  assert.deepEqual(nativeMcpArgs(entry(list)).args, { a: ["x"] })
})

const badArgs: [string, Buffer, string, Partial<typeof NATIVE_LIMITS>?][] = [
  ["an envelope over argumentBytes", pb().str(1, "pi-echo").done(), "native MCP argument byte limit reached", { argumentBytes: 1 }],
  ["a tool name sent as a varint", pb().varint(1, 5).done(), "invalid native MCP argument field type"],
  ["a tool name that is not UTF-8", pb().bytes(1, Buffer.from([0xff])).done(), "invalid UTF-8 in native MCP arguments"],
  ["a list nested past argumentDepth", entry(list), "native MCP argument nesting limit reached", { argumentDepth: 0 }],
  ["a null value other than NULL_VALUE", entry(pb().varint(1, 1).done()), "invalid native protobuf NullValue"],
  ["a number that is not finite", entry(pb().double(2, Infinity).done()), "nonfinite native MCP argument number"],
]
for (const [name, input, message, limits] of badArgs) {
  test(`nativeMcpArgs rejects ${name}`, () => {
    assert.throws(() => nativeMcpArgs(input, { ...NATIVE_LIMITS, ...limits }), nativeError(502, message))
  })
}

test("prepare falls back on history it cannot retain", async () => {
  const outputBytes = 1024
  const pool = newPool({ outputBytes })
  assert.deepEqual(pool.prepare(token, { model: "synthetic-model" }, "session-a", tools), { fallback: "history retention limit" })
  const { owner, ids } = await sealed(pool)
  owner.delivered()
  assert.deepEqual(prepare(pool, [...opening, asked(ids), result(ids[0], "x".repeat(outputBytes + 1))]), { fallback: "history retention limit" })
  assert.equal(prepare(pool, answered(ids)).owner, owner)
})

test("prepare falls back when the results span two owners' batches", async () => {
  const pool = newPool()
  const a = await sealed(pool, 1, "session-a")
  const b = await sealed(pool, 1, "session-b")
  a.owner.delivered()
  b.owner.delivered()
  assert.deepEqual(prepare(pool, answered([...a.ids, ...b.ids])), { fallback: "different native batches" })
  assert.equal(prepare(pool, answered(a.ids)).owner, a.owner)
})

test("prepare falls back when another account or other controls claim the batch", async () => {
  const pool = newPool()
  const { owner, ids } = await sealed(pool)
  owner.delivered()
  assert.deepEqual(prepare(pool, answered(ids), "other-token"), { fallback: "owner incompatible or expired" })
  assert.deepEqual(pool.prepare(token, { ...chat(answered(ids)), model: "other-model" }, "session-a", tools), {
    fallback: "owner incompatible or expired",
  })
  assert.equal(prepare(pool, answered(ids)).owner, owner)
})

test("prepare never submits a batch twice and replays only its delivered answer", async () => {
  const pool = newPool()
  const { owner, ids, writes } = await sealed(pool)
  owner.delivered()
  owner.resume({ ...prepare(pool, answered(ids)), estimate: 8 }, undefined)
  const sent = writes.length
  assert.ok(sent > 0)
  assert.deepEqual(prepare(pool, answered(ids)), { fallback: "result already submitted or busy" })
  await owner.pump([text("answer"), end()])
  owner.delivered()
  assert.deepEqual(prepare(pool, [...opening, asked(ids), result(ids[0], "changed")]), { fallback: "result already submitted or busy" })
  const replayed = owner.resume(prepare(pool, answered(ids)), undefined).events
  assert.deepEqual((await replayed.next()).value, { text: "answer" })
  assert.equal((await replayed.next()).value.usage.magpie_native.accounting, "replayed")
  assert.equal(writes.length, sent)
})

test("prepare falls back to owner busy until the sealed answer is delivered", async () => {
  const pool = newPool()
  const { owner, ids } = await sealed(pool)
  assert.deepEqual(prepare(pool, answered(ids)), { fallback: "owner busy" })
  owner.delivered()
  assert.equal(prepare(pool, answered(ids)).owner, owner)
})

test("prepare retires an owner near its lifetime deadline and then finds no owner", async () => {
  const pool = newPool()
  const { owner, ids } = await sealed(pool)
  owner.delivered()
  owner.expireIn(120_000)
  assert.equal(prepare(pool, answered(ids)).owner, owner)
  owner.expireIn(1000)
  assert.deepEqual(prepare(pool, answered(ids)), { fallback: "owner near lifetime deadline" })
  assert.deepEqual(await reply(owner), { error: { status: 410, message: "native Run retired before lifetime deadline" } })
  assert.deepEqual(prepare(pool, answered(ids)), { fallback: "owner unavailable" })
})

const attachment = { role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" }, image] }
const incompatible: [string, (ids: string[]) => unknown[], string, number?][] = [
  ["the history before the calls changed", (ids) => [{ role: "user", content: "hullo" }, asked(ids), ...results(ids)], "native continuation history diverged"],
  ["the results arrive without their assistant", (ids) => [...opening, ...results(ids)], "native continuation is missing its assistant tool calls"],
  ["the assistant has a field the native path does not know", (ids) => [...opening, asked(ids, { name: "pi" }), ...results(ids)], "unsupported assistant fields in native continuation"],
  ["the assistant shows an image", (ids) => [...opening, asked(ids, { content: [image] }), ...results(ids)], "unsupported native assistant display"],
  ["a call is not a function call", (ids) => [...opening, asked(ids, { tool_calls: ids.map((id) => ({ ...call(id), type: "custom" })) }), ...results(ids)], "unsupported native continuation tool call"],
  ["a call's arguments are not JSON", (ids) => [...opening, asked(ids, { tool_calls: ids.map((id) => call(id, "not json")) }), ...results(ids)], "invalid tool arguments in native continuation"],
  ["the assistant text changed", (ids) => [...opening, asked(ids, { content: "changed" }), ...results(ids)], "native continuation assistant output changed"],
  ["a call's arguments changed", (ids) => [...opening, asked(ids, { tool_calls: ids.map((id) => call(id, '{"text":"hi"}')) }), ...results(ids)], "native continuation tool calls changed"],
  ["a user message among the results carries a call's ID", (ids) => [...opening, asked(ids), { role: "user", tool_call_id: ids[1], content: "wait" }, result(ids[0])], "new input cannot be interleaved with pending native results", 2],
  ["a result repeats", (ids) => [...answered(ids), result(ids[0])], "duplicate native tool result"],
  ["a result answers an unknown call", (ids) => [...opening, asked(ids), result(ids[0]), result("call_other")], "unknown native tool result", 2],
  ["a result has no content", (ids) => [...opening, asked(ids), result(ids[0], null)], "unsupported native tool result"],
  ["an image attachment follows a result with no content", (ids) => [...opening, asked(ids), result(ids[0], null), attachment], "unsupported native tool result"],
  ["a result part is neither text nor an image", (ids) => [...opening, asked(ids), result(ids[0], [{ type: "file", file: { file_id: "f" } }])], "unsupported native tool result content"],
  ["a result image is empty", (ids) => [...opening, asked(ids), result(ids[0], [{ type: "image_url", image_url: { url: "data:image/png;base64," } }])], "invalid native result image"],
  ["only one of two parallel results arrives", (ids) => [...opening, asked(ids), result(ids[0])], "all parallel native tool results must be submitted together", 2],
]
for (const [name, history, detail, calls = 1] of incompatible) {
  test(`prepare falls back and leaves the owner resumable when ${name}`, async () => {
    const pool = newPool()
    const { owner, ids } = await sealed(pool, calls)
    owner.delivered()
    assert.deepEqual(prepare(pool, history(ids)), { fallback: "history incompatible with retained owner", detail })
    assert.equal(prepare(pool, answered(ids)).owner, owner)
  })
}

test("prepare falls back on earlier native calls followed by new input", () => {
  const pool = newPool()
  const next = { role: "user", content: "next" }
  assert.deepEqual(prepare(pool, [...answered(["call_cursor_ab_0_0"]), next]), { fallback: "historical native calls" })
  assert.equal(prepare(pool, [...answered(["call_1"]), next]).fallback, undefined)
})

test("prepare falls back to owner busy while its selector has a live owner", async () => {
  const pool = newPool()
  const owner = create(pool)
  assert.deepEqual(prepare(pool, opening), { fallback: "owner busy" })
  await owner.cancel("the Chat response was cancelled")
  assert.equal(prepare(pool, opening).fallback, undefined)
})

test("create falls back to owner busy when another create took the selector after prepare", async () => {
  const pool = newPool()
  const first = prepare(pool, opening)
  const second = prepare(pool, opening)
  const owner = pool.create(first, resolution, wire) as any
  assert.deepEqual(pool.create(second, resolution, wire), { fallback: "owner busy" })
  await owner.cancel("the Chat response was cancelled")
  assert.equal((pool.create(second, resolution, wire) as any).state, "opening")
})

test("create falls back at the account cap until that account has a finished owner", async () => {
  const pool = newPool({ perAccount: 1 })
  await complete(create(pool, "other-token", "session-x"))
  const owner = create(pool)
  const next = prepare(pool, opening, token, "session-b")
  assert.deepEqual(pool.create(next, resolution, wire), { fallback: "account owner limit" })
  await complete(owner)
  assert.equal((pool.create(next, resolution, wire) as any).state, "opening")
})

test("create falls back at the process cap until some owner has finished", async () => {
  const pool = newPool({ perProcess: 1 })
  const owner = create(pool, "token-a")
  const next = prepare(pool, opening, "token-b")
  assert.deepEqual(pool.create(next, resolution, wire), { fallback: "process owner limit" })
  await complete(owner)
  assert.equal((pool.create(next, resolution, wire) as any).state, "opening")
})

test("create falls back for opening history the native digest rejects", () => {
  const pool = newPool()
  for (const [assistant, detail] of [
    [{ role: "assistant", content: [image] }, "unsupported native assistant display"],
    [{ role: "assistant", content: "", tool_calls: [call("call_1", "not json")] }, "invalid tool arguments in native continuation"],
  ] as const) {
    const prepared = prepare(pool, [...opening, assistant, { role: "user", content: "next" }])
    assert.equal(prepared.fallback, undefined)
    assert.deepEqual(pool.create(prepared, resolution, wire), { fallback: "opening history not retainable", detail })
  }
})

test("create hands back prepare's fallback", () => {
  const pool = newPool()
  const prepared = prepare(pool, [...answered(["call_cursor_ab_0_0"]), { role: "user", content: "next" }])
  assert.equal(pool.create(prepared, resolution, wire), prepared)
})

test("bind rejects bootstrap blobs over blobBytes", () => {
  const owner = create(newPool({ blobBytes: 8 }))
  assert.throws(() => bind(owner, new Map([["aa", Buffer.alloc(9)]])), nativeError(503, "native bootstrap blob limit reached"))
})

test("send rejects writes after the owner is cancelled", async () => {
  const { owner } = running()
  await owner.cancel("the Chat response was cancelled")
  assert.throws(() => owner.send(Buffer.from("late")), nativeError(410, "native transport is no longer writable"))
})

test("resume rejects a batch that is already reserved", async () => {
  const pool = newPool()
  const { owner, ids } = await sealed(pool)
  owner.delivered()
  const prepared = { ...prepare(pool, answered(ids)), estimate: 8 }
  owner.resume(prepared, undefined)
  assert.throws(() => owner.resume(prepared, undefined), nativeError(409, "native continuation is already reserved"))
})

test("resume with an aborted signal cancels the owner before it submits", async () => {
  const pool = newPool()
  const { owner, ids, writes } = await sealed(pool)
  owner.delivered()
  const prepared = { ...prepare(pool, answered(ids)), estimate: 8 }
  assert.throws(() => owner.resume(prepared, AbortSignal.abort()), nativeError(410, "the Chat request was already cancelled"))
  assert.deepEqual(writes, [])
})

test("acceptCall rejects a call without an exec request ID", () => {
  const { owner } = running()
  assert.throws(() => owner.acceptCall({ ...execCall(7), requestID: undefined }), nativeError(502, "native tool call is missing its exec request ID"))
})

test("acceptCall rejects arguments that are not a JSON object", () => {
  const { owner } = running()
  assert.throws(() => owner.acceptCall({ ...execCall(7), args: "not json" }), nativeError(400, "invalid tool arguments in native continuation"))
})

test("acceptCall ignores an identical retransmission and rejects a changed one", () => {
  const { owner } = running()
  owner.listed(1)
  owner.acceptCall(execCall(7))
  owner.acceptCall(execCall(7))
  assert.throws(() => owner.acceptCall({ ...execCall(7), args: '{"text":"hi"}' }), nativeError(502, "native exec identity changed during retransmission"))
})

test("acceptCall rejects a new exec after its batch sealed", () => {
  const { owner } = running()
  owner.listed(1)
  owner.acceptCall(execCall(7))
  assert.throws(() => owner.acceptCall(execCall(8)), nativeError(502, "native call arrived after its batch was sealed"))
})

test("acceptCall rejects a native call ID reused by another exec", () => {
  const { owner } = running()
  owner.acceptCall(execCall(7))
  assert.throws(() => owner.acceptCall({ ...execCall(8), nativeID: "native-7" }), nativeError(502, "native tool-call ID was reused for another exec"))
})

test("listed rejects a count below one", () => {
  const { owner } = running()
  assert.throws(() => owner.listed(0), nativeError(502, "invalid native tool count"))
})

test("listed rejects a count below the calls already made", () => {
  const { owner } = running()
  owner.acceptCall(execCall(7))
  owner.acceptCall(execCall(8))
  assert.throws(() => owner.listed(1), nativeError(502, "native tool batch exceeded its declared count"))
})

test("store accepts a bootstrap blob's own bytes and rejects different ones", () => {
  const data = Buffer.from("bootstrap")
  const id = createHash("sha256").update(data).digest()
  const { owner } = running({}, new Map([[id.toString("hex"), data]]))
  owner.store(id, Buffer.from(data))
  assert.throws(() => owner.store(id, Buffer.from("changed")), nativeError(502, "native content-addressed bootstrap blob changed"))
})

test("store and checkpointReceived share blobBytes", () => {
  const { owner } = running({ blobBytes: 8 })
  owner.store(Buffer.from([1]), Buffer.alloc(6))
  assert.throws(() => owner.checkpointReceived(Buffer.alloc(3)), nativeError(503, "native checkpoint retention limit reached"))
  owner.checkpointReceived(pb().varint(1, 1).done())
  assert.throws(() => owner.store(Buffer.from([2]), Buffer.alloc(1)), nativeError(503, "native blob retention limit reached"))
})

test("pump fails the Run on a truncated frame", async () => {
  const { owner } = running()
  await owner.pump([{ data: Buffer.from([0x0a, 0x05, 0x01]) }])
  assert.deepEqual(await reply(owner), { error: { status: 502, message: "truncated native protobuf" } })
})

test("pump fails the Run when its output passes outputBytes", async () => {
  const outputBytes = 256
  const { owner } = running({ outputBytes })
  await owner.pump([text("x".repeat(outputBytes))])
  assert.deepEqual(await reply(owner), { error: { status: 503, message: "native output/history retention limit reached" } })
})

test("pump fails the Run on text after its batch sealed", async () => {
  const { owner } = await sealed(newPool())
  await owner.pump([text("late")])
  assert.deepEqual(await reply(owner), { error: { status: 502, message: "native output arrived outside a running Chat segment" } })
})

test("pump fails the Run when the turn ends with nothing said", async () => {
  const { owner } = running()
  await owner.pump([turnEnded])
  assert.deepEqual(await reply(owner), { error: { status: 502, message: "an empty reply (Cursor ended the turn without text or a tool call)" } })
})

test("pump fails the Run when the turn ends with an unresolved call", async () => {
  const { owner } = running()
  owner.acceptCall(execCall(7))
  await owner.pump([turnEnded])
  assert.deepEqual(await reply(owner), { error: { status: 502, message: "Cursor ended a turn with unresolved native tool calls" } })
})

test("pump fails the Run when Cursor cancels a pending exec", async () => {
  const { owner } = running()
  owner.acceptCall(execCall(7))
  await owner.pump([{ data: pb().bytes(5, pb().bytes(1, pb().varint(1, 7))).done() }])
  assert.deepEqual(await reply(owner), {
    error: { status: 410, message: "Cursor cancelled a pending native tool exec; late results cannot be submitted" },
  })
})

test("pump fails the Run on an interaction query", async () => {
  const { owner } = running()
  await owner.pump([{ data: pb().bytes(7, Buffer.alloc(0)).done() }])
  assert.deepEqual(await reply(owner), { error: { status: 502, message: "unsupported native interaction query" } })
})

test("pump refuses a KV blob with an empty ID and fails the Run", async () => {
  const { owner, writes } = running()
  await owner.pump([{ data: pb().bytes(4, pb().varint(1, 5).bytes(3, pb().bytes(2, Buffer.from("data")))).done() }])
  assert.deepEqual(writes.at(-1), pb().bytes(3, pb().varint(1, 5).bytes(3, pb().bytes(1, pb().str(1, "native blob could not be retained")))).done())
  assert.deepEqual(await reply(owner), { error: { status: 502, message: "native blob ID is empty" } })
})

test("pump fails the Run when the stream stops mid-reply", async () => {
  const { owner } = running()
  await owner.pump([text("partial")])
  assert.deepEqual(await reply(owner), { error: { status: 502, message: "native reply broke off before completing its turn or tool batch: EOF" } })
})

test("pump fails the Run when the stream ends before any answer", async () => {
  const { owner } = running()
  await owner.pump([end()])
  assert.deepEqual(await reply(owner), { error: { status: 502, message: "native Run ended before TurnEnded or a complete final answer" } })
})

test("pump fails the Run with the status the stream ended on", async () => {
  const { owner } = running()
  await owner.pump([end({ status: 503, message: "overloaded" })])
  assert.deepEqual(await reply(owner), { error: { status: 503, message: "overloaded" } })
})
