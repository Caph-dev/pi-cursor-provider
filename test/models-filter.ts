// The wiring, not just the matcher: refresh publishes the complete catalogue,
// and provider reads apply cursor.json even without another network request.
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import type { Provider, RefreshModelsContext } from "@earendil-works/pi-ai"
import register from "../src/index.ts"
import { clearLimitsRetry } from "../src/limits.ts"

const realFetch = globalThis.fetch
const dirs: string[] = []
let tokens = 0

afterEach(() => {
  globalThis.fetch = realFetch
  clearLimitsRetry()
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

// A merged (unified) account is served the picker's models but only a few are
// inside the included allowance: a Run for any other one is refused with 429.
const twoModels = {
  models: [
    {
      name: "gpt-5",
      clientDisplayName: "GPT-5",
      supportsAgent: true,
      contextTokenLimit: 300_000,
      variants: [{ legacySlug: "gpt-5", isDefaultNonMaxConfig: true, parameterValues: [{ id: "context", value: "300k" }] }],
      parameterDefinitions: [{ id: "context", parameterType: { enumParameter: { values: [{ value: "300k" }] } } }],
    },
    { name: "claude-test", clientDisplayName: "Claude Test", supportsAgent: true, contextTokenLimit: 200_000 },
  ],
}

function stubPlan(calls: string[], plan: unknown, period: () => Response): void {
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url))
    if (String(url).endsWith("GetPlanInfo")) return new Response(JSON.stringify(plan), { status: 200 })
    if (String(url).includes("GetCurrentPeriodUsage")) return period()
    const body = String(url).endsWith("GetUsableModels")
      ? { models: [{ modelId: "gpt-5" }, { modelId: "claude-test" }] }
      : twoModels
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
}

test("a merged plan publishes only the models its included allowance covers", async () => {
  await withEnv(withConfig([]), async () => {
    const calls: string[] = []
    stubPlan(calls, { planInfo: { planName: "Super" }, isMerged: true }, () => Response.json({ autoBucketModels: ["gpt-5"] }))
    const { refreshModels } = await registered()
    assert.deepEqual(await listed(refreshModels, true), ["gpt-5@300k"])
    assert.equal(calls.some((u) => u.includes("GetCurrentPeriodUsage")), true)
  })
})

test("a Cursor plan keeps every model and asks for no period report", async () => {
  await withEnv(withConfig([]), async () => {
    const calls: string[] = []
    stubPlan(calls, { planInfo: { planName: "Pro" }, isMerged: false, nextUpgrade: { tier: "ultra" } }, () => Response.json({}))
    const { refreshModels } = await registered()
    assert.deepEqual(await listed(refreshModels, true), ["gpt-5@300k", "claude-test"])
    assert.equal(calls.some((u) => u.includes("GetCurrentPeriodUsage")), false)
  })
})

test("a merged plan whose period report fails keeps every model", async () => {
  await withEnv(withConfig([]), async () => {
    const calls: string[] = []
    stubPlan(calls, { planInfo: { planName: "Super" }, isMerged: true }, () => new Response("no", { status: 500 }))
    const { refreshModels } = await registered()
    assert.deepEqual(await listed(refreshModels, true), ["gpt-5@300k", "claude-test"])
  })
})

test("an upgrade offer alone does not make an account merged", async () => {
  await withEnv(withConfig([]), async () => {
    const calls: string[] = []
    stubPlan(calls, { planInfo: { planName: "Pro" }, isMerged: false, nextUpgrade: { tier: "unified_ultra" } }, () =>
      Response.json({ autoBucketModels: ["gpt-5"] }),
    )
    const { refreshModels } = await registered()
    assert.deepEqual(await listed(refreshModels, true), ["gpt-5@300k", "claude-test"])
    assert.equal(calls.some((u) => u.includes("GetCurrentPeriodUsage")), false)
  })
})

test("the plan filter follows the default variant, not any variant of the model", async () => {
  await withEnv(withConfig([]), async () => {
    const calls: string[] = []
    const efforts = [{ value: "low" }, { value: "high" }]
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url))
      if (String(url).endsWith("GetPlanInfo")) return Response.json({ planInfo: { planName: "Super" }, isMerged: true })
      if (String(url).includes("GetCurrentPeriodUsage")) return Response.json({ autoBucketModels: ["a-high", "b-high"] })
      if (String(url).endsWith("GetUsableModels")) return Response.json({ models: [{ modelId: "a-low" }, { modelId: "a-high" }, { modelId: "b-high" }] })
      const model = (name: string, at: string, other: string) => ({
        name,
        clientDisplayName: name,
        supportsAgent: true,
        contextTokenLimit: 200_000,
        parameterDefinitions: [{ id: "effort", parameterType: { enumParameter: { values: efforts } } }],
        variants: [
          { legacySlug: `${name}-${at}`, isDefaultNonMaxConfig: true, parameterValues: [{ id: "effort", value: at }] },
          { legacySlug: `${name}-${other}`, parameterValues: [{ id: "effort", value: other }] },
        ],
      })
      // `a` starts at the effort the allowance does not cover, `b` at the one it does
      return Response.json({ models: [model("a", "low", "high"), model("b", "high", "low")] })
    }) as typeof fetch
    const { refreshModels } = await registered()
    assert.deepEqual(await listed(refreshModels, true), ["b"])
    assert.ok(calls.some((u) => u.includes("GetCurrentPeriodUsage")))
  })
})

test("showAllModels in cursor.json offers every model a merged plan lists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cursor-wiring-"))
  dirs.push(dir)
  writeFileSync(join(dir, "cursor.json"), JSON.stringify({ showAllModels: true }))
  await withEnv(dir, async () => {
    const calls: string[] = []
    stubPlan(calls, { planInfo: { planName: "Super" }, isMerged: true }, () => Response.json({ autoBucketModels: ["gpt-5"] }))
    const { refreshModels } = await registered()
    assert.deepEqual(await listed(refreshModels, true), ["gpt-5@300k", "claude-test"])
  })
})

test("showAllModels skips the plan lookups and restores the catalogue without the network", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cursor-wiring-"))
  dirs.push(dir)
  writeFileSync(join(dir, "cursor.json"), JSON.stringify({ showAllModels: true }))
  await withEnv(dir, async () => {
    const calls: string[] = []
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url))
      if (String(url).includes("DashboardService")) throw new Error("the override asks for no plan")
      const body = String(url).endsWith("GetUsableModels")
        ? { models: [{ modelId: "gpt-5" }, { modelId: "claude-test" }] }
        : twoModels
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch
    const { refreshModels } = await registered()
    assert.deepEqual(await listed(refreshModels, true), ["gpt-5@300k", "claude-test"])
    assert.equal(calls.some((u) => u.includes("DashboardService")), false)
  })
})

test("turning the override on restores the excluded models without another request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cursor-wiring-"))
  dirs.push(dir)
  writeFileSync(join(dir, "cursor.json"), JSON.stringify({ hiddenModels: [] }))
  await withEnv(dir, async () => {
    const calls: string[] = []
    stubPlan(calls, { planInfo: { planName: "Super" }, isMerged: true }, () => Response.json({ autoBucketModels: ["gpt-5"] }))
    const { refreshModels } = await registered()
    assert.deepEqual(await listed(refreshModels, true), ["gpt-5@300k"])
    const before = calls.length
    writeFileSync(join(dir, "cursor.json"), JSON.stringify({ showAllModels: true }))
    assert.deepEqual(await listed(refreshModels, false), ["gpt-5@300k", "claude-test"])
    assert.equal(calls.length, before, "the restored catalogue needs no request")
  })
})

test("an abort during the period report publishes no catalogue", async () => {
  await withEnv(withConfig([]), async () => {
    const original = globalThis.fetch
    let periodStarted = false
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      const href = String(url)
      if (href.endsWith("GetPlanInfo")) return Promise.resolve(Response.json({ planInfo: { planName: "Super" }, isMerged: true }))
      if (href.includes("GetCurrentPeriodUsage")) {
        periodStarted = true
        return new Promise((_resolve, reject) => {
          const fail = () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))
          if (init?.signal?.aborted) return fail()
          init?.signal?.addEventListener("abort", fail, { once: true })
        })
      }
      return Promise.resolve(Response.json(String(href).endsWith("GetUsableModels") ? { models: [] } : twoModels))
    }) as typeof fetch
    try {
      const controller = new AbortController()
      const { provider, refreshModels } = await registered()
      const pending = refreshModels({
        allowNetwork: true,
        force: true,
        signal: controller.signal,
        credential: undefined,
      })
      const started = Date.now()
      while (!periodStarted && Date.now() - started < 2_000) await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(periodStarted, true)
      controller.abort()
      await assert.rejects(pending, /aborted/)
      assert.deepEqual(provider.getModels(), [])
    } finally {
      globalThis.fetch = original
    }
  })
})

test("a period report that fails after a good one keeps the coverage it knew", async () => {
  await withEnv(withConfig([]), async () => {
    const calls: string[] = []
    let periodOk = true
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url))
      if (String(url).endsWith("GetPlanInfo")) return Response.json({ planInfo: { planName: "Super" }, isMerged: true })
      if (String(url).includes("GetCurrentPeriodUsage")) {
        return periodOk ? Response.json({ autoBucketModels: ["gpt-5"] }) : new Response("no", { status: 500 })
      }
      const body = String(url).endsWith("GetUsableModels")
        ? { models: [{ modelId: "gpt-5" }, { modelId: "claude-test" }] }
        : twoModels
      return Response.json(body)
    }) as typeof fetch
    const { refreshModels } = await registered()
    assert.deepEqual(await listed(refreshModels, true), ["gpt-5@300k"])
    periodOk = false
    assert.deepEqual(await listed(refreshModels, true), ["gpt-5@300k"], "the picker does not reopen")
  })
})
