import assert from "node:assert/strict"
import test from "node:test"
import { CACHE_CAP, tokenKey } from "../src/cache.ts"
import { MODELS_KEEP } from "../src/client.ts"
import { modelCacheKeys, usable } from "../src/models.ts"
import { agentURL, endpointCacheKeys } from "../src/run.ts"
import { clearPlanCache, fetchUsage, planCacheKeys } from "../src/usage.ts"

const PLAN_TTL = 60 * 60 * 1000
const ENDPOINT_TTL = 10 * 60 * 1000

function catalog(url: string): Response {
  if (url.includes("GetPlanInfo")) return Response.json({ planInfo: { planName: "Pro" } })
  if (url.includes("GetServerConfig")) return Response.json({ agentUrlConfig: { agentUrl: "https://agent.example" } })
  if (url.includes("AvailableModels")) {
    return Response.json({
      models: [{ name: "composer-test", clientDisplayName: "Composer", variants: [{}] }],
    })
  }
  if (url.includes("GetUsableModels")) return Response.json({ models: [] })
  return Response.json({})
}

function clock() {
  const real = Date.now
  let now = real()
  Date.now = () => now
  return {
    advance(ms: number) {
      now += ms
    },
    restore() {
      Date.now = real
    },
  }
}

test("plan, model, and endpoint caches expire and stay capped", async () => {
  clearPlanCache()
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.signal?.aborted) {
      return Promise.reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))
    }
    return catalog(String(url))
  }) as typeof fetch
  const time = clock()
  const token = "cache-token-cache-token"
  try {
    await fetchUsage(token, [])
    await usable(token, true)
    await agentURL(token, true)
    assert.deepEqual(planCacheKeys(), [tokenKey(token)])
    assert.deepEqual(modelCacheKeys(), [tokenKey(token)])
    assert.deepEqual(endpointCacheKeys(), [tokenKey(token)])
    assert.equal(planCacheKeys().includes(token), false)

    time.advance(PLAN_TTL + 1)
    const aborted = new AbortController()
    aborted.abort()
    await assert.rejects(fetchUsage(token, [], aborted.signal))
    assert.deepEqual(planCacheKeys(), [])

    time.advance(MODELS_KEEP)
    await assert.rejects(usable(token, false, aborted.signal))
    assert.deepEqual(modelCacheKeys(), [])

    time.advance(ENDPOINT_TTL)
    await assert.rejects(agentURL(token, false, aborted.signal))
    assert.deepEqual(endpointCacheKeys(), [])

    globalThis.fetch = (async (url: string) => catalog(String(url))) as typeof fetch
    for (let i = 0; i < CACHE_CAP + 1; i++) {
      const next = `cache-token-${i}-xxxxxxxxxxxxxxxx`
      await fetchUsage(next, [])
      await usable(next, true)
      await agentURL(next, true)
    }
    assert.ok(planCacheKeys().length <= CACHE_CAP)
    assert.ok(modelCacheKeys().length <= CACHE_CAP)
    assert.ok(endpointCacheKeys().length <= CACHE_CAP)
    assert.equal(planCacheKeys().every((key) => /^[0-9a-f]{64}$/.test(key)), true)
  } finally {
    time.restore()
    globalThis.fetch = original
    clearPlanCache()
  }
})
