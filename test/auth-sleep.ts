import assert from "node:assert/strict"
import { getEventListeners } from "node:events"
import test from "node:test"
import { sleep } from "../src/auth.ts"

test("finished sleeps leave no abort listener on the shared signal", async () => {
  const controller = new AbortController()
  for (let i = 0; i < 20; i++) await sleep(1, controller.signal)
  assert.equal(getEventListeners(controller.signal, "abort").length, 0)
})

test("abort during sleep rejects and leaves no listener", async () => {
  const controller = new AbortController()
  const pending = sleep(30_000, controller.signal)
  controller.abort()
  await assert.rejects(pending, /Cursor sign-in cancelled/)
  assert.equal(getEventListeners(controller.signal, "abort").length, 0)
})

test("a poll sleep resolves on abort and leaves no listener", async () => {
  const controller = new AbortController()
  for (let i = 0; i < 20; i++) await sleep(1, controller.signal, "resolve")
  assert.equal(getEventListeners(controller.signal, "abort").length, 0)
  const pending = sleep(30_000, controller.signal, "resolve")
  controller.abort()
  await pending
  assert.equal(getEventListeners(controller.signal, "abort").length, 0)
})
