import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Provider, RefreshModelsContext } from "@earendil-works/pi-ai"
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

function register(): Provider<"cursor-run"> {
  let provider: Provider<"cursor-run"> | undefined
  extension({
    registerProvider(config: Provider<"cursor-run">) {
      provider = config
    },
    registerCommand() {},
    on() {},
  } as never)
  assert.ok(provider, "the extension registered the cursor provider")
  return provider
}

function ctx(token: string, force = false, signal = new AbortController().signal): RefreshModelsContext {
  return {
    credential: { type: "api_key", key: token },
    allowNetwork: true,
    force,
    signal,
    publish: async ({ update }) => {
      if (!signal.aborted) update?.()
      return true
    },
  }
}

const ids = (provider: Provider<"cursor-run">) => provider.getModels().map((model) => model.id)

test("a failed refresh does not return another credential's catalog", async () => {
  // hidden rules come from this test's own config dir, not the user's cursor.json
  const agentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "cursor-credentials-"))
  const provider = register()
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    if ((headers.get("authorization") ?? "").includes(TOKEN_B)) return new Response("no", { status: 500 })
    return catalog(String(url))
  }) as typeof fetch
  try {
    await provider.refreshModels?.(ctx(TOKEN_A, true))
    const first = ids(provider)
    assert.ok(first.length > 0)
    await provider.refreshModels?.(ctx(TOKEN_B, true))
    assert.deepEqual(ids(provider), [], "a failed refresh for B must not serve A's models")

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
    const pending = provider.refreshModels?.(ctx(TOKEN_A, true, ac.signal))
    const began = Date.now()
    while (!started && Date.now() - began < 2_000) await new Promise((resolve) => setTimeout(resolve, 10))
    ac.abort()
    await pending
    globalThis.fetch = (async () => new Response("no", { status: 500 })) as typeof fetch
    await provider.refreshModels?.(ctx(TOKEN_A, true))
    assert.deepEqual(ids(provider), first, "A keeps its own catalogue after a failed refresh")
  } finally {
    globalThis.fetch = original
    if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = agentDir
  }
})
