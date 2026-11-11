// /cursor-provider-update: the one place a person can refresh the models.dev
// limits and the catalogue on demand.
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import register from "../src/index.ts"
import { clearLimitsRetry, limitsPath, packageVersion, readLimits } from "../src/limits.ts"

const realFetch = globalThis.fetch
const dirs: string[] = []
let tokens = 0

afterEach(() => {
  globalThis.fetch = realFetch
  clearLimitsRetry()
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const DOC = { xai: { models: { "grok-4.7": { id: "xai/grok-4.7", limit: { output: 500000 } } } } }

const picker = {
  models: [{ name: "grok-4.7", clientDisplayName: "Grok 4.7", supportsAgent: true, contextTokenLimit: 256000, variants: [{ legacySlug: "grok-4.7" }] }],
}

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), "cursor-update-"))
  dirs.push(dir)
  const env = { ...process.env }
  process.env.PI_CODING_AGENT_DIR = dir
  process.env.CURSOR_ACCESS_TOKEN = `update-token-${++tokens}-${"x".repeat(20)}`
  const calls: string[] = []
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url))
    if (String(url).startsWith("https://models.dev/")) return Response.json(DOC)
    if (String(url).endsWith("GetPlanInfo")) return Response.json({})
    const body = String(url).endsWith("GetUsableModels") ? { models: [{ modelId: "grok-4.7" }] } : picker
    return Response.json(body)
  }) as typeof fetch

  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>()
  const notices: string[] = []
  const refreshes: unknown[] = []
  let provider: { refreshModels?: (ctx: unknown) => Promise<void> } | undefined
  const pi = {
    registerProvider: (config: { refreshModels?: (ctx: unknown) => Promise<void> }) => {
      provider = config
    },
    registerEntryRenderer: () => {},
    registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, spec.handler),
    registerTool: () => {},
    on: () => {},
    getSettings: () => ({}),
    appendEntry: () => {},
  }
  await register(pi as never)
  const ctx = {
    signal: new AbortController().signal,
    hasUI: true,
    ui: { notify: (message: string) => notices.push(message) },
    modelRegistry: {
      refresh: async (options: { allowNetwork: boolean; signal: AbortSignal }) => {
        refreshes.push(options)
        await provider?.refreshModels?.({
          ...options,
          force: true,
          credential: { type: "api_key", key: process.env.CURSOR_ACCESS_TOKEN },
          publish: async ({ update }: { update?: () => void }) => {
            update?.()
            return true
          },
        })
        return { providers: ["cursor"] }
      },
    },
  }
  return {
    dir,
    calls,
    notices,
    refreshes,
    ctx,
    command: (name: string) => {
      const handler = commands.get(name)
      assert.ok(handler, `${name} is registered`)
      return handler
    },
    restore: () => {
      process.env = env
    },
  }
}

test("the update command refetches the limits, stores them, and refreshes the catalogue", async () => {
  const h = await harness()
  try {
    assert.equal(existsSync(limitsPath()), false)
    await h.command("cursor-provider-update")("", h.ctx)
    assert.equal(existsSync(limitsPath()), true, "the index is stored for the next session")
    assert.equal(readLimits(limitsPath()).index.get("grok-4-7"), 500000)
    assert.equal(readLimits(limitsPath()).version, packageVersion())
    assert.equal(h.calls.some((url) => url.startsWith("https://models.dev/")), true)
    assert.equal(h.refreshes.length, 1, "a catalogue refresh follows the limits read")
    assert.match(h.notices.join("\n"), /Cursor model catalogue: 1 models, 1 model limits\./)
  } finally {
    h.restore()
  }
})

test("the update command says so when models.dev cannot be read", async () => {
  const h = await harness()
  try {
    globalThis.fetch = (async (url: string) => {
      if (String(url).startsWith("https://models.dev/")) return new Response("no", { status: 503 })
      return Response.json(String(url).endsWith("GetUsableModels") ? { models: [{ modelId: "grok-4.7" }] } : picker)
    }) as typeof fetch
    await h.command("cursor-provider-update")("", h.ctx)
    assert.match(h.notices.join("\n"), /no model limits/)
    assert.equal(existsSync(limitsPath()), false, "a failed read stores nothing")
  } finally {
    h.restore()
  }
})

test("the command rejects arguments the way /cursor.usage does", async () => {
  const h = await harness()
  try {
    await h.command("cursor-provider-update")("now", h.ctx)
    assert.match(h.notices.join("\n"), /This command does not take arguments\./)
  } finally {
    h.restore()
  }
})
