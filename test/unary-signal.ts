import assert from "node:assert/strict"
import test from "node:test"
import { unary } from "../src/client.ts"
import { usable } from "../src/models.ts"

const TOKEN = "abort-catalog-token-aaaaaaaa"

function catalog(url: string): Response {
  if (url.includes("GetUsableModels")) return Response.json({ models: [] })
  return Response.json({
    models: [{ name: "composer-test", clientDisplayName: "Composer", variants: [{}] }],
  })
}

function aborted(): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" })
}

// Node 22 leaves AbortSignal.timeout unref'd. A bare hanging fetch lets the
// test runner decide the event loop is finished while the assertion is still waiting.
function fetchUntilAbort(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal
    const hold = setTimeout(() => reject(aborted()), 5_000)
    const fail = () => {
      clearTimeout(hold)
      reject(aborted())
    }
    if (!signal || signal.aborted) {
      fail()
      return
    }
    signal.addEventListener("abort", fail, { once: true })
  })
}

test("unary still rejects when its timeout wins", async () => {
  const original = globalThis.fetch
  globalThis.fetch = ((_url: string, init?: RequestInit) => fetchUntilAbort(init)) as typeof fetch
  try {
    await assert.rejects(unary("https://example.test", "aiserver.v1.AiService/AvailableModels", TOKEN, {}, 30))
  } finally {
    globalThis.fetch = original
  }
})

test("aborting a model refresh stops the request and does not keep the catalog", async () => {
  const original = globalThis.fetch
  const signals: AbortSignal[] = []
  const finish: Array<() => void> = []
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal)
    return new Promise((resolve, reject) => {
      const hold = setTimeout(() => reject(aborted()), 5_000)
      const fail = () => {
        clearTimeout(hold)
        reject(aborted())
      }
      if (init?.signal?.aborted) {
        fail()
        return
      }
      init?.signal?.addEventListener("abort", fail, { once: true })
      finish.push(() => {
        clearTimeout(hold)
        resolve(catalog(String(url)))
      })
    })
  }) as typeof fetch
  const ac = new AbortController()
  try {
    const pending = usable(TOKEN, true, ac.signal)
    const started = Date.now()
    while (signals.length < 2 && Date.now() - started < 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(signals.length, 2)
    ac.abort()
    const raced = await Promise.race([
      pending.then(
        () => "cached",
        () => "rejected",
      ),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 200)),
    ])
    assert.equal(raced, "rejected")
    assert.equal(
      signals.every((signal) => signal.aborted),
      true,
    )
    for (const done of finish) done()
    let hits = 0
    globalThis.fetch = (async (url: string) => {
      hits += 1
      return catalog(String(url))
    }) as typeof fetch
    await usable(TOKEN, false)
    assert.ok(hits > 0, "aborted refresh was kept and served again")
  } finally {
    globalThis.fetch = original
  }
})
