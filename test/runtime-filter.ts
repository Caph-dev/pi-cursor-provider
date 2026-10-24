// Exercise Pi's runtime reads, not only the extension's refresh return value.
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { Credential, CredentialStore } from "@earendil-works/pi-ai"
import { initTheme, ModelRegistry, ModelRuntime, ModelSelectorComponent } from "@earendil-works/pi-coding-agent"
import register from "../src/index.ts"

const credentials: CredentialStore = {
  read: async () => undefined,
  list: async () => [],
  modify: async (_provider, fn) => fn(undefined),
  delete: async () => {},
}

async function fixture(
  run: (runtime: ModelRuntime, dir: string, calls: string[], state: { credential?: Credential; writes: number }) => Promise<void>,
  modelsConfig?: object,
  credential?: Credential,
) {
  const dir = mkdtempSync(join(tmpdir(), "cursor-runtime-"))
  const originalFetch = globalThis.fetch
  const originalDir = process.env.PI_CODING_AGENT_DIR
  const originalToken = process.env.CURSOR_ACCESS_TOKEN
  const calls: string[] = []
  process.env.PI_CODING_AGENT_DIR = dir
  process.env.CURSOR_ACCESS_TOKEN = "runtime-test-token-xxxxxxxxxxxxxxxxxxxx"
  writeFileSync(join(dir, "cursor.json"), JSON.stringify({ hiddenModels: [] }))
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(String(url))
    if (String(url).endsWith("exchange_user_api_key")) {
      assert.ok(init?.signal instanceof AbortSignal, "OAuth refresh forwards its abort signal")
      return Response.json({ accessToken: "refreshed-oauth-access-xxxxxxxxxxxxxxxxxxxx", refreshToken: "refreshed-token" })
    }
    return Response.json(String(url).endsWith("GetUsableModels")
      ? { models: [{ modelId: "gpt-5" }, { modelId: "claude-test" }] }
      : { models: [
          { name: "gpt-5", clientDisplayName: "GPT-5", supportsAgent: true, contextTokenLimit: 300_000 },
          { name: "claude-test", clientDisplayName: "Claude Test", supportsAgent: true, contextTokenLimit: 200_000 },
        ] })
  }) as typeof fetch
  try {
    const modelsPath = modelsConfig ? join(dir, "models.json") : null
    if (modelsPath) writeFileSync(modelsPath, JSON.stringify(modelsConfig))
    const state = { credential, writes: 0 }
    const store: CredentialStore = credential ? {
      ...credentials,
      read: async (id) => id === "cursor" ? state.credential : undefined,
      list: async () => state.credential ? [{ providerId: "cursor", type: state.credential.type }] : [],
      modify: async (id, fn) => {
        assert.equal(id, "cursor")
        const next = await fn(state.credential)
        if (next) {
          state.credential = next
          state.writes++
        }
        return state.credential
      },
    } : credentials
    const runtime = await ModelRuntime.create({ credentials: store, modelsPath, refreshOnCreate: false })
    const registry = new ModelRegistry(runtime)
    await register({
      registerProvider: registry.registerProvider.bind(registry),
      registerCommand: () => {},
      on: () => {},
    } as never)
    const refreshed = await runtime.refresh({ providers: ["cursor"], allowNetwork: true, force: true })
    assert.equal(refreshed.errors.size, 0)
    await run(runtime, dir, calls, state)
  } finally {
    globalThis.fetch = originalFetch
    if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalDir
    if (originalToken === undefined) delete process.env.CURSOR_ACCESS_TOKEN
    else process.env.CURSOR_ACCESS_TOKEN = originalToken
    rmSync(dir, { recursive: true, force: true })
  }
}

const ids = (models: readonly { id: string }[]) => models.map((m) => m.id)

test("reload restores the complete catalogue from Pi's cache without network access", async () => {
  await fixture(async (runtime, dir, calls) => {
    writeFileSync(join(dir, "cursor.json"), JSON.stringify({ hiddenModels: ["gpt-*"] }))
    const registry = new ModelRegistry(runtime)
    await register({
      registerProvider: registry.registerProvider.bind(registry),
      registerCommand: () => {},
      on: () => {},
    } as never)
    const before = calls.length
    await runtime.refresh({ providers: ["cursor"], allowNetwork: false })
    assert.deepEqual(ids(runtime.getAvailableSnapshot().filter((m) => m.provider === "cursor")), ["claude-test"])
    writeFileSync(join(dir, "cursor.json"), JSON.stringify({ hiddenModels: [] }))
    assert.deepEqual(ids(await runtime.getAvailable("cursor")), ["gpt-5", "claude-test"])
    assert.equal(calls.length, before)
    globalThis.fetch = (async () => { throw new Error("offline after reload") }) as typeof fetch
    await runtime.refresh({ providers: ["cursor"], allowNetwork: true, force: true })
    assert.deepEqual(ids(runtime.getAvailableSnapshot().filter((m) => m.provider === "cursor")), ["gpt-5", "claude-test"])
  })
})

test("runtime availability reads apply cursor.json without refreshing the remote catalogue", async () => {
  await fixture(async (runtime, dir, calls) => {
    assert.deepEqual(ids(await runtime.getAvailable("cursor")), ["gpt-5", "claude-test"])
    const before = calls.length
    writeFileSync(join(dir, "cursor.json"), JSON.stringify({ hiddenModels: ["gpt-*"] }))
    assert.deepEqual(ids(await runtime.getAvailable("cursor")), ["claude-test"])
    assert.equal(runtime.getModel("cursor", "gpt-5"), undefined)
    writeFileSync(join(dir, "cursor.json"), JSON.stringify({ hiddenModels: [] }))
    assert.deepEqual(ids(await runtime.getAvailable("cursor")), ["gpt-5", "claude-test"])
    assert.equal(calls.length, before)
  })
})

test("a failed network refresh still updates the picker snapshot from local rules", async () => {
  await fixture(async (runtime, dir) => {
    writeFileSync(join(dir, "cursor.json"), JSON.stringify({ hiddenModels: ["gpt-*"] }))
    globalThis.fetch = (async () => { throw new Error("offline") }) as typeof fetch
    await runtime.refresh({ providers: ["cursor"], allowNetwork: true, force: true })
    assert.deepEqual(ids(runtime.getAvailableSnapshot().filter((m) => m.provider === "cursor")), ["claude-test"])
    writeFileSync(join(dir, "cursor.json"), JSON.stringify({ hiddenModels: [] }))
    await runtime.refresh({ providers: ["cursor"], allowNetwork: false })
    assert.deepEqual(ids(runtime.getAvailableSnapshot().filter((m) => m.provider === "cursor")), ["gpt-5", "claude-test"])
  })
})

test("reopening the TUI model selector applies edited rules after its own refresh", async () => {
  await fixture(async (runtime, dir) => {
    initTheme("dark", false)
    writeFileSync(join(dir, "cursor.json"), JSON.stringify({ hiddenModels: ["gpt-*"] }))
    let finishRender!: () => void
    const rendered = new Promise<void>((resolve) => { finishRender = resolve })
    let selector: ModelSelectorComponent | undefined
    const tui = { requestRender: () => {
      if (selector?.render(100).join("\n").includes("Model catalogs refreshed.")) finishRender()
    } }
    selector = new ModelSelectorComponent(
      tui as ConstructorParameters<typeof ModelSelectorComponent>[0],
      undefined, runtime, [], () => {}, () => {},
    )
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      // Pi renders the previous snapshot first; no manual refresh before opening.
      assert.ok(selector.render(100).join("\n").includes("gpt-5"))
      await Promise.race([
        rendered,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("model selector did not finish refreshing")), 2000)
        }),
      ])
      const refreshed = selector.render(100).join("\n")
      assert.ok(refreshed.includes("claude-test"))
      assert.ok(!refreshed.includes("gpt-5"))
    } finally {
      clearTimeout(timeout)
      selector.dispose()
    }
  })
})

test("models.json additions are filtered by native availability policy", async () => {
  await fixture(async (runtime, dir) => {
    assert.ok((await runtime.getAvailable("cursor")).some((m) => m.id === "custom-gpt"))
    writeFileSync(join(dir, "cursor.json"), JSON.stringify({ hiddenModels: ["custom-*"] }))
    assert.ok(!(await runtime.getAvailable("cursor")).some((m) => m.id === "custom-gpt"))
    await runtime.refresh({ providers: ["cursor"], allowNetwork: false })
    assert.ok(!runtime.getAvailableSnapshot().some((m) => m.provider === "cursor" && m.id === "custom-gpt"))
  }, { providers: { cursor: { api: "cursor-run", baseUrl: "https://cursor.test", models: [{ id: "custom-gpt" }] } } })
})

test("native OAuth credentials remain usable and subscription-backed", async () => {
  await fixture(async (runtime) => {
    assert.equal((await runtime.checkAuth("cursor"))?.type, "oauth")
    assert.equal((await runtime.getAuth("cursor"))?.auth.apiKey, "oauth-test-access-xxxxxxxxxxxxxxxxxxxx")
    assert.equal(runtime.isUsingSubscription("cursor"), true)
  }, undefined, {
    type: "oauth", access: "oauth-test-access-xxxxxxxxxxxxxxxxxxxx", refresh: "refresh-test", expires: Date.now() + 3_600_000,
  })
})

test("expired native OAuth credentials are refreshed and saved once", async () => {
  await fixture(async (runtime, _dir, calls, state) => {
    const before = calls.filter((url) => url.endsWith("exchange_user_api_key")).length
    assert.equal(before, 1)
    assert.equal((await runtime.getAuth("cursor"))?.auth.apiKey, "refreshed-oauth-access-xxxxxxxxxxxxxxxxxxxx")
    assert.equal((await runtime.getAuth("cursor"))?.auth.apiKey, "refreshed-oauth-access-xxxxxxxxxxxxxxxxxxxx")
    assert.equal(calls.filter((url) => url.endsWith("exchange_user_api_key")).length, before)
    assert.ok(state.credential?.type === "oauth")
    assert.equal(state.credential.refresh, "refreshed-token")
    assert.ok(state.credential.expires > Date.now())
    assert.equal(state.writes, 1)
  }, undefined, {
    type: "oauth", access: "expired-oauth-access-xxxxxxxxxxxxxxxxxxxx", refresh: "expired-refresh", expires: Date.now() - 1000,
  })
})
