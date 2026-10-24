import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import http2 from "node:http2"
import test, { mock } from "node:test"
import { resetH1, runAnswer } from "../src/run.ts"

test("default connect arms the header timer with headerWaitMs", async () => {
  resetH1()
  const delays: number[] = []
  const ids: Array<ReturnType<typeof setTimeout>> = []
  const orig = globalThis.setTimeout
  const wrapped = (fn: () => void, ms?: number) => {
    delays.push(Number(ms))
    const id = orig(fn, ms)
    ids.push(id)
    return id
  }
  globalThis.setTimeout = wrapped as typeof setTimeout
  mock.method(http2, "connect", () => {
    const session = new EventEmitter() as EventEmitter & { request: () => never }
    session.request = () => {
      throw new Error("stop after the header timer is armed")
    }
    return session
  })
  try {
    await runAnswer({
      tok: "test-token-test-token",
      model: "composer",
      messages: [{ role: "user", content: "hi" }],
      rawModels: [],
      resolveAgentURL: async () => "https://agent.example/v1",
      headerWaitMs: 1234,
    }).catch(() => undefined)
  } finally {
    for (const id of ids) clearTimeout(id)
    globalThis.setTimeout = orig
    mock.restoreAll()
    resetH1()
  }
  assert.ok(delays.includes(1234), `timer delays were ${delays.join(",")}`)
})
