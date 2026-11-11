import assert from "node:assert/strict"
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai"
import type { Api, AssistantMessageEvent, Model, SimpleStreamOptions } from "@earendil-works/pi-ai"
import test from "node:test"
import { emitCursorEvents } from "../src/pi-stream.ts"

let now = 0
performance.now = () => now

const model = {
  id: "composer-test",
  name: "Composer",
  api: "cursor-run",
  provider: "cursor",
  baseUrl: "https://agent.example",
  input: ["text"],
  reasoning: false,
  contextWindow: 200_000,
  maxTokens: 8_000,
  cost: { input: 1_000_000, output: 2_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
} as Model<Api>

type Source = Parameters<typeof emitCursorEvents>[2]

async function play(items: unknown[], options?: SimpleStreamOptions): Promise<AssistantMessageEvent[]> {
  async function* source() {
    for (const item of items) {
      const timed = item as { advanceMs?: number }
      if (timed.advanceMs) now += timed.advanceMs
      yield item
    }
  }
  const stream = createAssistantMessageEventStream()
  const pending = emitCursorEvents(stream, model, source() as Source, options)
  const events: AssistantMessageEvent[] = []
  for await (const event of stream) events.push(event)
  await pending
  return events
}

function types(events: AssistantMessageEvent[]): string[] {
  return events.map((event) => event.type)
}

function terminals(events: AssistantMessageEvent[]): AssistantMessageEvent[] {
  return events.filter((event) => event.type === "done" || event.type === "error")
}

test("text, thinking, and text close each block before the next", async () => {
  const events = await play([{ text: "a" }, { reasoning: "b" }, { text: "c" }])
  assert.deepEqual(types(events), [
    "start",
    "text_start",
    "text_delta",
    "text_end",
    "thinking_start",
    "thinking_delta",
    "thinking_end",
    "text_start",
    "text_delta",
    "text_end",
    "done",
  ])
  assert.equal(events[1]?.type === "text_start" ? events[1].contentIndex : -1, 0)
  assert.equal(events[4]?.type === "thinking_start" ? events[4].contentIndex : -1, 1)
  assert.equal(events[7]?.type === "text_start" ? events[7].contentIndex : -1, 2)
  const done = events.at(-1)
  assert.equal(done?.type === "done" ? done.reason : "", "stop")
})

test("thinking with no following text still ends the thinking block", async () => {
  const events = await play([{ reasoning: "only" }])
  assert.deepEqual(types(events), ["start", "thinking_start", "thinking_delta", "thinking_end", "done"])
  const end = events.find((event) => event.type === "thinking_end")
  assert.equal(end?.type === "thinking_end" ? end.content : "", "only")
})

test("a tool call between text blocks ends as toolUse", async () => {
  const events = await play([
    { text: "before" },
    { tool: { id: "call_1", name: "echo", args: "{\"x\":1}" } },
    { text: "after" },
    { stop: "tool_calls" },
  ])
  assert.deepEqual(types(events), [
    "start",
    "text_start",
    "text_delta",
    "text_end",
    "toolcall_start",
    "toolcall_delta",
    "toolcall_end",
    "text_start",
    "text_delta",
    "text_end",
    "done",
  ])
  const done = events.at(-1)
  assert.equal(done?.type, "done")
  if (done?.type !== "done") return
  assert.equal(done.reason, "toolUse")
  assert.equal(done.message.stopReason, "toolUse")
  const call = done.message.content.find((part) => part.type === "toolCall")
  assert.equal(call?.type === "toolCall" ? call.name : "", "echo")
  assert.deepEqual(call?.type === "toolCall" ? call.arguments : {}, { x: 1 })
})

test("stop usage is copied onto the assistant message and priced", async () => {
  const events = await play([
    { text: "hi" },
    {
      stop: "end",
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 },
        completion_tokens_details: { reasoning_tokens: 4 },
      },
    },
  ])
  const done = events.at(-1)
  assert.equal(done?.type, "done")
  if (done?.type !== "done") return
  assert.deepEqual(done.message.usage, {
    input: 50,
    output: 10,
    cacheRead: 30,
    cacheWrite: 20,
    totalTokens: 110,
    reasoning: 4,
    cost: { input: 50, output: 20, cacheRead: 30, cacheWrite: 20, total: 120 },
  })
})

test("an error event stops once with the normalized message", async () => {
  const events = await play([{ error: { message: "prompt is too long" } }])
  assert.deepEqual(types(events), ["start", "error"])
  const error = events[1]
  assert.equal(error?.type, "error")
  if (error?.type !== "error") return
  assert.equal(error.reason, "error")
  assert.equal(error.error.stopReason, "error")
  assert.equal(error.error.errorMessage, "context_length_exceeded: prompt is too long")
})

test("aborting mid-stream emits one aborted terminal event", async () => {
  const controller = new AbortController()
  async function* source() {
    yield { text: "hi" }
    controller.abort()
    yield { text: "more" }
  }
  const stream = createAssistantMessageEventStream()
  const pending = emitCursorEvents(stream, model, source() as Source, { signal: controller.signal })
  const events: AssistantMessageEvent[] = []
  for await (const event of stream) events.push(event)
  await pending
  assert.deepEqual(types(events), ["start", "text_start", "text_delta", "text_end", "error"])
  assert.equal(terminals(events).length, 1)
  const error = events.at(-1)
  assert.equal(error?.type, "error")
  if (error?.type !== "error") return
  assert.equal(error.reason, "aborted")
  assert.equal(error.error.stopReason, "aborted")
  assert.equal(error.error.errorMessage, "the request was cancelled")
})

test("a stream that never stops still finishes the message", async () => {
  const events = await play([{ text: "hi" }])
  assert.equal(events.at(-1)?.type, "done")
  assert.equal(terminals(events).length, 1)
  const done = events.at(-1)
  if (done?.type !== "done") return
  assert.equal(done.reason, "stop")
  const text = done.message.content.find((part) => part.type === "text")
  assert.equal(text?.type === "text" ? text.text : "", "hi")
})

test("output timing advances on deltas and excludes tool and accounting waits", async () => {
  now = 100
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  let arrived!: () => void
  const ready = new Promise<void>((resolve) => { arrived = resolve })
  async function* source() {
    yield { text: "abcd" }
    now = 1100
    yield { reasoning: "abcdefgh" }
    arrived()
    await waiting
    now = 101100
    yield { tool: { id: "call_1", name: "echo", args: "{}" } }
    yield { stop: "tool_calls", usage: { completion_tokens: 42, cursor_output_source: "measured" } }
  }
  const stream = createAssistantMessageEventStream()
  const pending = emitCursorEvents(stream, model, source() as Source)
  const snapshots: unknown[] = []
  let seen = 0
  const collect = (async () => {
    for await (const event of stream) {
      if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "done") {
        snapshots.push((event as typeof event & { cursorOutputTiming?: unknown }).cursorOutputTiming)
        seen += 1
      }
    }
  })()
  await ready
  while (seen < 2) await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(snapshots.slice(0, 2), [
    { outputTokens: 1, source: "estimated", elapsedMs: 0 },
    { outputTokens: 3, source: "estimated", elapsedMs: 1000, tokensPerSecond: 2, tokensPerSecondSource: "estimated" },
  ])
  release()
  await pending
  await collect
  assert.deepEqual(snapshots.at(-1), { outputTokens: 42, source: "measured", accountingSource: "measured", elapsedMs: 1000, tokensPerSecond: 2, tokensPerSecondSource: "estimated" })
})

test("output timing pauses across a tool wait and does not move after publishing", async () => {
  now = 0
  const items = [
    { text: "abcd" },
    { advanceMs: 1_000, text: "abcd" },
    { advanceMs: 90_000, tool: { id: "call_1", name: "echo", args: "{}" } },
    { advanceMs: 1_000, text: "abcd" },
    { advanceMs: 1_000, text: "abcd" },
  ]
  async function* source() {
    for (const item of items) {
      if (item.advanceMs) now += item.advanceMs
      yield item
    }
  }
  const stream = createAssistantMessageEventStream()
  const pending = emitCursorEvents(stream, model, source() as Source)
  const deltas: Array<{ elapsedMs: number; tokensPerSecond?: number } | undefined> = []
  let final: { elapsedMs: number; tokensPerSecond?: number } | undefined
  for await (const event of stream) {
    const timing = (event as typeof event & { cursorOutputTiming?: { elapsedMs: number; tokensPerSecond?: number } }).cursorOutputTiming
    if (event.type === "text_delta") deltas.push(timing)
    if (event.type === "done") final = timing
  }
  await pending
  const beforeTool = deltas[1]
  const resumed = deltas[3]
  assert.equal(deltas.length, 4)
  assert.equal(beforeTool?.elapsedMs, 1_000)
  assert.equal(beforeTool?.tokensPerSecond, 1)
  assert.equal(resumed?.elapsedMs, 2_000)
  assert.equal(resumed?.tokensPerSecond, 1)
  assert.equal(final?.elapsedMs, 2_000)
  assert.equal(final?.tokensPerSecond, 1)
  now = 180_000
  assert.equal(beforeTool?.elapsedMs, 1_000)
  assert.equal(final?.elapsedMs, 2_000)
})

test("single delta and replay do not produce a speed", async () => {
  const single = await play([{ text: "hello" }, { stop: "stop", usage: { completion_tokens: 0, cursor_output_source: "pending" } }])
  const done = single.at(-1)
  assert.equal(done?.type, "done")
  if (done?.type !== "done") return
  assert.deepEqual((done as typeof done & { cursorOutputTiming?: unknown }).cursorOutputTiming, {
    outputTokens: 2, source: "estimated", accountingSource: "pending", elapsedMs: 0,
  })
  const replay = await play([{ text: "hello", replay: true }, { stop: "stop", replay: true }])
  const replayDone = replay.at(-1)
  assert.equal(replayDone?.type, "done")
  if (replayDone?.type !== "done") return
  assert.equal((replayDone as typeof replayDone & { cursorOutputTiming?: unknown }).cursorOutputTiming, undefined)
})
