import assert from "node:assert/strict"
import test from "node:test"
import { onH1, resetH1 } from "../src/run.ts"

test("resetH1 clears sticky HTTP/1.1 preference", () => {
  resetH1()
  assert.equal(onH1(), false)
})
