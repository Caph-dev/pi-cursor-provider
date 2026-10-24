import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import http2 from "node:http2"
import test, { mock } from "node:test"
import { onH1, resetH1, runAnswer } from "../src/run.ts"

test("resetH1 clears sticky HTTP/1.1 preference", () => {
  resetH1()
  assert.equal(onH1(), false)
})

const TOKEN = "transport-token-transport"

function coded(message: string, code?: string): Error {
  return Object.assign(new Error(message), code ? { code } : {})
}

async function attempt(fail: Error | "hang", headerWaitMs = 30): Promise<{ connects: number; fetches: number }> {
  let connects = 0
  let fetches = 0
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    fetches += 1
    return new Response("no", { status: 503 })
  }) as typeof fetch
  mock.method(http2, "connect", () => {
    connects += 1
    if (fail === "hang") {
      const session = new EventEmitter() as EventEmitter & {
        request: () => EventEmitter
        destroy: () => void
        close: () => void
      }
      session.request = () => {
        const req = new EventEmitter() as EventEmitter & { close: () => void }
        req.close = () => {}
        return req
      }
      session.destroy = () => {}
      session.close = () => {}
      return session
    }
    throw fail
  })
  try {
    await runAnswer({
      tok: TOKEN,
      model: "composer-test",
      messages: [{ role: "user", content: "hi" }],
      rawModels: [],
      session: `transport-${connects}-${Math.random()}`,
      resolveAgentURL: async () => "https://agent.example/v1",
      headerWaitMs,
    })
  } finally {
    globalThis.fetch = original
    mock.restoreAll()
  }
  return { connects, fetches }
}

test("HTTP/2 sticks only when the failure is HTTP/2 itself", async () => {
  const cases: Array<{ name: string; fail: Error | "hang"; sticky: boolean }> = [
    { name: "ECONNREFUSED", fail: coded("connect ECONNREFUSED", "ECONNREFUSED"), sticky: false },
    { name: "ENOTFOUND", fail: coded("getaddrinfo ENOTFOUND", "ENOTFOUND"), sticky: false },
    { name: "ERR_HTTP2_STREAM_ERROR", fail: coded("stream closed", "ERR_HTTP2_STREAM_ERROR"), sticky: false },
    { name: "ERR_HTTP2_GOAWAY", fail: coded("goaway", "ERR_HTTP2_GOAWAY"), sticky: true },
    { name: "alpn", fail: coded("alpn negotiation failed"), sticky: true },
    { name: "nghttp2", fail: coded("nghttp2 closed the session"), sticky: true },
    { name: "protocol error", fail: coded("protocol error"), sticky: true },
    { name: "business error", fail: coded("the model is not available"), sticky: false },
    { name: "header timeout", fail: "hang", sticky: true },
  ]
  for (const item of cases) {
    resetH1()
    const first = await attempt(item.fail)
    assert.equal(onH1(), item.sticky, item.name)
    assert.equal(first.connects, 1, item.name)
    assert.ok(first.fetches > 0, item.name)
    const second = await attempt(item.fail)
    assert.equal(second.connects, item.sticky ? 0 : 1, item.name)
    resetH1()
  }
})

test("aborting a turn that fell back to HTTP/1.1 settles without another HTTP/2 connect", async () => {
  resetH1()
  const controller = new AbortController()
  let connects = 0
  const original = globalThis.fetch
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    queueMicrotask(() => controller.abort())
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))
      })
    })
  }) as typeof fetch
  mock.method(http2, "connect", () => {
    connects += 1
    throw coded("getaddrinfo ENOTFOUND", "ENOTFOUND")
  })
  try {
    const pending = runAnswer({
      tok: TOKEN,
      model: "composer-test",
      messages: [{ role: "user", content: "hi" }],
      rawModels: [],
      session: "transport-abort",
      signal: controller.signal,
      resolveAgentURL: async () => "https://agent.example/v1",
      headerWaitMs: 30,
    })
    const raced = await Promise.race([
      pending.then(
        () => "settled",
        () => "settled",
      ),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
    ])
    assert.equal(raced, "settled")
    assert.equal(connects, 1)
    assert.equal(onH1(), false)
  } finally {
    globalThis.fetch = original
    mock.restoreAll()
    resetH1()
  }
})
