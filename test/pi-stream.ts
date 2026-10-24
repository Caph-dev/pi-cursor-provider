import assert from "node:assert/strict"
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai"
import type { Api, AssistantMessageEvent, Model, SimpleStreamOptions } from "@earendil-works/pi-ai"
import test from "node:test"
import { emitCursorEvents } from "../src/pi-stream.ts"

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
    for (const item of items) yield item
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
