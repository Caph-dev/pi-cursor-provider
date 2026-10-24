import assert from "node:assert/strict"
import type { RefreshModelsContext } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent"
import test from "node:test"
import extension from "../src/index.ts"

const TOKEN_A = "a".repeat(24)
const TOKEN_B = "b".repeat(24)

function catalog(url: string): Response {
  if (url.includes("GetUsableModels")) return Response.json({ models: [] })
  return Response.json({
    models: [{ name: "composer-test", clientDisplayName: "Composer", variants: [{}] }],
  })
}

function ctx(token: string, force = false, signal = new AbortController().signal): RefreshModelsContext {
  return {
    credential: { type: "api_key", key: token },
    allowNetwork: true,
    force,
    signal,
    publish: async () => true,
  }
}

test("a failed refresh does not return another credential's catalog", async () => {
  let refresh: ((context: RefreshModelsContext) => Promise<ProviderModelConfig[]>) | undefined
  extension({
    registerProvider(_id: string, provider: { refreshModels?: (context: RefreshModelsContext) => Promise<ProviderModelConfig[]> }) {
      refresh = provider.refreshModels
    },
    registerCommand() {},
  } as unknown as ExtensionAPI)
  assert.ok(refresh)
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    if ((headers.get("authorization") ?? "").includes(TOKEN_B)) return new Response("no", { status: 500 })
    return catalog(String(url))
  }) as typeof fetch
  try {
    const first = await refresh(ctx(TOKEN_A, true))
    assert.ok(first.length > 0)
    const second = await refresh(ctx(TOKEN_B, true))
    assert.deepEqual(
      second.map((model) => model.id),
      [],
    )
    const ac = new AbortController()
    let started = false
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      started = true
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))
        })
      })
    }) as typeof fetch
    const pending = refresh(ctx(TOKEN_A, true, ac.signal))
    const began = Date.now()
    while (!started && Date.now() - began < 2_000) await new Promise((resolve) => setTimeout(resolve, 10))
    ac.abort()
    await pending
    globalThis.fetch = (async () => new Response("no", { status: 500 })) as typeof fetch
    const after = await refresh(ctx(TOKEN_A, true))
    assert.deepEqual(
      after.map((model) => model.id),
      first.map((model) => model.id),
    )
  } finally {
    globalThis.fetch = original
  }
})
