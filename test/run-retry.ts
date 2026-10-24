import assert from "node:assert/strict"
import test from "node:test"
import { clearMaxOnly, nativeSessions, resetH1, runAnswer } from "../src/run.ts"

function owners(): number {
  return (nativeSessions as unknown as { entries: { size: number } }).entries.size
}

const TOKEN = "retry-token-retry-token"

function answer(extra: Record<string, unknown>) {
  return runAnswer({
    tok: TOKEN,
    model: "composer-test",
    messages: [{ role: "user", content: "hi" }],
    rawModels: [],
    session: `retry-${Math.random()}`,
    resolveAgentURL: async () => "https://a.example/agent",
    ...extra,
  })
}

test("a regional error retries once only when the agent URL changes", async () => {
  resetH1()
  clearMaxOnly()
  let peak = 0
  let connects = 0
  const connect = () => {
    connects += 1
    peak = Math.max(peak, owners())
    throw new Error("not in this region")
  }
  let fresh = 0
  await answer({
    connect,
    resolveAgentURL: async (_token: string, again: boolean) => {
      if (again) fresh += 1
      return again ? "https://b.example/agent" : "https://a.example/agent"
    },
  })
  assert.equal(fresh, 1)
  assert.equal(connects, 2)
  assert.equal(peak, 1)
  assert.equal(owners(), 0)

  connects = 0
  await answer({
    connect,
    resolveAgentURL: async () => "https://a.example/agent",
  })
  assert.equal(connects, 1)
  assert.equal(owners(), 0)
})

test("an aborted regional or max-mode error does not open another Run", async () => {
  resetH1()
  clearMaxOnly()
  const regional = new AbortController()
  let connects = 0
  let fresh = 0
  await answer({
    signal: regional.signal,
    connect: () => {
      connects += 1
      regional.abort()
      throw new Error("not in this region")
    },
    resolveAgentURL: async (_token: string, again: boolean) => {
      if (again) fresh += 1
      return again ? "https://b.example/agent" : "https://a.example/agent"
    },
  })
  assert.equal(connects, 1)
  assert.equal(fresh, 0)

  const max = new AbortController()
  const seen: boolean[] = []
  connects = 0
  await answer({
    signal: max.signal,
    connect: () => {
      connects += 1
      max.abort()
      throw new Error("Max Mode required")
    },
    onPayload: async (payload: unknown) => {
      const body = payload as { maxMode?: boolean }
      seen.push(body.maxMode === true)
    },
  })
  assert.equal(connects, 1)
  assert.deepEqual(seen, [false])
  assert.equal(owners(), 0)
})

test("max mode retries once and the next turn already asks for it", async () => {
  resetH1()
  clearMaxOnly()
  const seen: boolean[] = []
  const connect = () => {
    throw new Error("Max Mode required")
  }
  await answer({
    model: "composer-max",
    connect,
    onPayload: async (payload: unknown) => {
      const body = payload as { maxMode?: boolean }
      seen.push(body.maxMode === true)
    },
  })
  assert.deepEqual(seen, [false, true])
  assert.equal(owners(), 0)

  seen.length = 0
  let connects = 0
  await answer({
    model: "composer-max",
    connect: () => {
      connects += 1
      throw new Error("later failure")
    },
    onPayload: async (payload: unknown) => {
      const body = payload as { maxMode?: boolean }
      seen.push(body.maxMode === true)
    },
  })
  assert.deepEqual(seen, [true])
  assert.equal(connects, 1)
})
