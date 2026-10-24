// The wiring, not just the matcher: refresh publishes the complete catalogue,
// and provider reads apply cursor.json even without another network request.
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import type { Provider, RefreshModelsContext } from "@earendil-works/pi-ai"
import register from "../src/index.ts"

const realFetch = globalThis.fetch
const dirs: string[] = []
let tokens = 0

afterEach(() => {
  globalThis.fetch = realFetch
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

/** A cursor.json in a fresh config dir, returned through PI_CODING_AGENT_DIR. */
function withConfig(hiddenModels: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "cursor-wiring-"))
  dirs.push(dir)
  writeFileSync(join(dir, "cursor.json"), JSON.stringify({ hiddenModels }))
  return dir
}

/** Point the extension at `dir` and a token of its own, restoring both after. */
async function withEnv<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const agentDir = process.env.PI_CODING_AGENT_DIR
  const token = process.env.CURSOR_ACCESS_TOKEN
  // a token of its own keeps usable() from serving another test's cached list
  process.env.CURSOR_ACCESS_TOKEN = `wiring-token-${++tokens}-${"x".repeat(20)}`
  process.env.PI_CODING_AGENT_DIR = dir
  try {
    return await run()
  } finally {
    if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = agentDir
    if (token === undefined) delete process.env.CURSOR_ACCESS_TOKEN
    else process.env.CURSOR_ACCESS_TOKEN = token
  }
}

// the picker entry modelsOf reads, and the usable id the account has
const picker = {
  models: [
    {
      name: "gpt-5",
      clientDisplayName: "GPT-5",
      supportsAgent: true,
      contextTokenLimit: 300_000,
      variants: [
        { legacySlug: "gpt-5", isDefaultNonMaxConfig: true, parameterValues: [{ id: "context", value: "300k" }] },
      ],
      parameterDefinitions: [{ id: "context", parameterType: { enumParameter: { values: [{ value: "300k" }] } } }],
    },
  ],
}

function stubFetch(calls: string[]): void {
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url))
    const body = String(url).endsWith("GetUsableModels") ? { models: [{ modelId: "gpt-5" }] } : picker
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
}

/** The provider factory as Pi would have called it, keeping what it registered. */
async function registered() {
  let provider: Provider | undefined
  const pi = {
    registerProvider: (config: Provider) => {
      provider = config
    },
    registerCommand: () => {},
    on: () => {},
    getSettings: () => ({}),
  }
  await register(pi as never)
  assert.ok(provider, "the extension registered the cursor provider")
  const registeredProvider = provider
  return {
    provider: registeredProvider,
    refreshModels: async (ctx: Omit<RefreshModelsContext, "publish">) => {
      await registeredProvider.refreshModels?.({
        ...ctx,
        publish: async ({ update }) => {
          if (ctx.signal.aborted) return false
          update?.()
          return true
        },
      })
      return registeredProvider.getModels()
    },
  }
}

const listed = async (refresh: (ctx: Omit<RefreshModelsContext, "publish">) => Promise<readonly { id: string }[]>, allowNetwork: boolean) =>
  (
    await refresh({
      allowNetwork,
      force: true,
      signal: new AbortController().signal,
      credential: undefined,
    })
  ).map((m) => m.id)

test("a first-load network failure is reported instead of publishing an empty catalogue", async () => {
  await withEnv(withConfig([]), async () => {
    globalThis.fetch = (async () => { throw new Error("catalogue offline") }) as typeof fetch
    const { refreshModels } = await registered()
    await assert.rejects(listed(refreshModels, true), /catalogue offline/)
  })
})

test("a refresh returns the picker list without the models cursor.json hides", async () => {
  await withEnv(withConfig(["gpt-5"]), async () => {
    const calls: string[] = []
    stubFetch(calls)
    const { refreshModels } = await registered()
    assert.deepEqual(await listed(refreshModels, true), [])
    assert.ok(calls.some((u) => u.includes("AvailableModels")))
  })
})

test("no cursor.json keeps every model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cursor-wiring-"))
  dirs.push(dir)
  await withEnv(dir, async () => {
    stubFetch([])
    const { refreshModels } = await registered()
    assert.deepEqual(await listed(refreshModels, true), ["gpt-5@300k"])
  })
})

test("a refresh without the network re-reads cursor.json, hides and restores models", async () => {
  const dir = withConfig([])
  await withEnv(dir, async () => {
    const calls: string[] = []
    stubFetch(calls)
    const { refreshModels } = await registered()
    assert.deepEqual(await listed(refreshModels, true), ["gpt-5@300k"])
    const before = calls.length
    writeFileSync(join(dir, "cursor.json"), JSON.stringify({ hiddenModels: ["gpt-*"] }))
    assert.deepEqual(await listed(refreshModels, false), [])
    // the catalogue is kept, so lifting the rule brings the model back
    writeFileSync(join(dir, "cursor.json"), JSON.stringify({ hiddenModels: [] }))
    assert.deepEqual(await listed(refreshModels, false), ["gpt-5@300k"])
    assert.equal(calls.length, before, "a refresh without the network makes no request")
  })
})
