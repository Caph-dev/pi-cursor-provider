import assert from "node:assert/strict"
import { getEventListeners } from "node:events"
import test from "node:test"
import { sleep } from "../src/auth.ts"

test("finished sleeps leave no abort listener on the shared signal", async () => {
  const controller = new AbortController()
  for (let i = 0; i < 20; i++) await sleep(1, controller.signal)
  assert.equal(getEventListeners(controller.signal, "abort").length, 0)
})
