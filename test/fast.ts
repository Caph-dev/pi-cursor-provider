import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { normalizeContext } from "@earendil-works/pi-ai"
import type { Model } from "@earendil-works/pi-ai"
import { registerCursorFast } from "../src/fast.ts"
import { piModelConfigs, supportsFast, usable } from "../src/models.ts"
import { nativeSessions, runAnswer } from "../src/run.ts"

const realFetch = globalThis.fetch
const realToken = process.env.CURSOR_ACCESS_TOKEN
let serial = 0

afterEach(async () => {
  globalThis.fetch = realFetch
  if (realToken === undefined) delete process.env.CURSOR_ACCESS_TOKEN
  else process.env.CURSOR_ACCESS_TOKEN = realToken
  await nativeSessions.clear()
})

async function catalogue(sparseFast = false) {
  const token = `fast-test-${++serial}-${"x".repeat(24)}`
  process.env.CURSOR_ACCESS_TOKEN = token
  const variants = ["256k", "500k"].flatMap((context) => ["low", "high"].flatMap((effort) => [false, true].flatMap((fast) => {
    if (context === "500k" && effort === "high" && fast) return []
    return [{
      legacySlug: `grok-test-${effort}${fast ? "-fast" : ""}`,
      isDefaultNonMaxConfig: context === "256k" && effort === "high" && !fast,
      parameterValues: [{ id: "context", value: context }, { id: "reasoning_effort", value: effort }, { id: "fast", value: String(fast) }],
    }]
  })))
  if (sparseFast) variants.push({ legacySlug: "grok-test-sparse-fast", isDefaultNonMaxConfig: false, parameterValues: [{ id: "fast", value: "true" }] })
  globalThis.fetch = (async (url: string) => {
    if (String(url).endsWith("GetServerConfig")) return Response.json({})
    if (String(url).endsWith("GetUsableModels")) return Response.json({ models: variants.map((v) => ({ modelId: v.legacySlug })) })
    assert.ok(String(url).endsWith("AvailableModels"), "only catalogue requests are allowed")
    return Response.json({ models: [{
      name: "grok-test", supportsAgent: true, contextTokenLimit: 500_000, variants,
      parameterDefinitions: [
        { id: "context", parameterType: { enumParameter: { values: [{ value: "256k" }, { value: "500k" }] } } },
        { id: "reasoning_effort", parameterType: { enumParameter: { values: [{ value: "low" }, { value: "high" }] } } },
        { id: "fast", parameterType: { booleanParameter: { values: [{ value: "false" }, { value: "true" }] } } },
      ],
    }, { name: "plain-test", supportsAgent: true, contextTokenLimit: 200_000 }] })
  }) as typeof fetch
  const raw = await usable(token, true)
  const models = piModelConfigs(raw).map((model: any) => ({ ...model, provider: "cursor", baseUrl: "https://cursor.test" })) as Model<any>[]
  return { token, raw, models }
}

function harness(models: Model<any>[]) {
  let model: Model<any> | undefined = models[0]
  let level = "high"
  let idle = true
  let session = "fast-session"
  let entries: any[] = []
  const notices: string[] = []
  const statuses = new Map<string, string | undefined>()
  const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>()
  let command!: (args: string, ctx: any) => Promise<void>
  const pi = {
    on: (name: string, handler: (event: any, ctx: any) => unknown) => hooks.set(name, [...(hooks.get(name) ?? []), handler]),
    registerCommand: (_name: string, config: any) => { command = config.handler },
    getThinkingLevel: () => level,
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  }
  const ctx = {
    get model() { return model },
    modelRegistry: { find: (_provider: string, id: string) => models.find((m) => m.id === id) },
    sessionManager: { getSessionId: () => session, getBranch: () => entries },
    isIdle: () => idle,
    ui: { notify: (message: string) => notices.push(message), setStatus: (key: string, text: string | undefined) => statuses.set(key, text) },
  }
  const controller = registerCursorFast(pi as never)
  const emit = async (name: string) => { for (const hook of hooks.get(name) ?? []) await hook({}, ctx) }
  return {
    controller, ctx, notices, statuses, emit,
    command: (args: string) => command(args, ctx),
    setModel: (next: Model<any> | undefined) => { model = next },
    setLevel: (next: string) => { level = next },
    setIdle: (next: boolean) => { idle = next },
    branch: (next: any[]) => { entries = next },
    newSession: () => { session = "other-session"; entries = [] },
    saved: () => entries,
  }
}

const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] })

test("fast capability matches the current context and normal effort, including after caching", async () => {
  const { raw, models } = await catalogue()
  assert.equal(supportsFast(raw, "grok-test@256k", "high"), true)
  assert.equal(supportsFast(raw, "grok-test@500k", "high"), false)
  assert.equal(supportsFast(raw, "grok-test@500k", "low"), true)
  assert.equal(supportsFast(raw, "plain-test", "high"), false)
  const cached = JSON.parse(JSON.stringify(models))
  assert.ok(cached[0].cursorFastLevels.includes("high"))
  assert.ok(!cached[1].cursorFastLevels.includes("high"))
})

test("a sparse fast variant does not imply support for undeclared context and effort", async () => {
  const { raw } = await catalogue(true)
  assert.equal(supportsFast(raw, "grok-test@500k", "high"), false)
  assert.equal(supportsFast(raw, "grok-test@256k", "high"), true)
})

test("catalogue changes immediately mark an enabled mode unavailable and block its request", async () => {
  const { models, token } = await catalogue()
  const h = harness(models)
  await h.emit("session_start")
  await h.command("on")
  models[0] = { ...models[0], cursorFastLevels: [] } as Model<any>
  h.controller.catalogueChanged()
  assert.equal(h.statuses.get("cursor-fast"), "Cursor fast: on (unavailable)")
  globalThis.fetch = (async (url: string) => Response.json(String(url).endsWith("GetUsableModels")
    ? { models: [{ modelId: "grok-test" }] }
    : { models: [{ name: "grok-test", supportsAgent: true, contextTokenLimit: 256_000 }] })) as typeof fetch
  await usable(token, true)
  const result = await h.controller.stream(models[0], context, { apiKey: token, sessionId: "fast-session", reasoning: "high" }).result()
  assert.match(result.errorMessage!, /fast is enabled but unavailable/)
})

test("command preserves model/thinking and validates arguments, availability, and busy state", async () => {
  const { models } = await catalogue()
  const h = harness(models)
  await h.emit("session_start")
  assert.equal(h.statuses.get("cursor-fast"), "Cursor fast: off")
  await h.command("on")
  assert.equal(h.ctx.model, models[0])
  assert.equal(h.statuses.get("cursor-fast"), "Cursor fast: on")
  assert.deepEqual(h.saved()[0].data, { model: models[0].id, enabled: true })
  await h.command("status")
  assert.match(h.notices.at(-1)!, /thinking high/)
  h.setIdle(false)
  await h.command("off")
  assert.match(h.notices.at(-1)!, /Wait/)
  assert.equal(h.statuses.get("cursor-fast"), "Cursor fast: on")
  h.setIdle(true)
  await h.command("oops")
  assert.match(h.notices.at(-1)!, /Usage/)
  h.setModel(models[1])
  await h.emit("model_select")
  await h.command("on")
  assert.match(h.notices.at(-1)!, /unavailable/)
  h.setLevel("low")
  await h.emit("thinking_level_select")
  await h.command("on")
  h.setLevel("high")
  await h.emit("thinking_level_select")
  assert.equal(h.statuses.get("cursor-fast"), "Cursor fast: on (unavailable)")
  await h.command("off")
  assert.match(h.notices.at(-1)!, /fast: off/)
  h.setModel({ ...models[0], provider: "other" })
  await h.emit("model_select")
  assert.equal(h.statuses.get("cursor-fast"), undefined)
  await h.command("on")
  assert.match(h.notices.at(-1)!, /Select a Cursor/)
})

test("preferences are model-specific, survive reload, and follow session branches", async () => {
  const { models } = await catalogue()
  const h = harness(models)
  await h.emit("session_start")
  await h.command("on")
  await h.emit("session_start")
  assert.equal(h.statuses.get("cursor-fast"), "Cursor fast: on")
  const resumed = harness(models)
  resumed.branch(h.saved())
  await resumed.emit("session_start")
  assert.equal(resumed.statuses.get("cursor-fast"), "Cursor fast: on")
  h.setModel(models[1]); h.setLevel("low")
  await h.emit("model_select")
  assert.equal(h.statuses.get("cursor-fast"), "Cursor fast: off")
  h.setModel(models[0]); h.setLevel("high")
  await h.emit("model_select")
  assert.equal(h.statuses.get("cursor-fast"), "Cursor fast: on")
  h.branch([])
  await h.emit("session_tree")
  assert.equal(h.statuses.get("cursor-fast"), "Cursor fast: off")
  await h.command("on")
  h.newSession()
  await h.emit("session_start")
  assert.equal(h.statuses.get("cursor-fast"), "Cursor fast: off")
})

test("enabled fast reaches the Run payload with context/effort unchanged; off and other sessions stay normal", async () => {
  const { models, token } = await catalogue()
  const h = harness(models)
  await h.emit("session_start")
  await h.command("on")
  const payloads: any[] = []
  const send = async (sessionId = "fast-session", model = models[0], reasoning: "high" | "low" = "high") => {
    const result = await h.controller.stream(model, context, {
      apiKey: token, sessionId, reasoning,
      onPayload: (payload) => { payloads.push(payload); throw new Error("payload captured before transport") },
    }).result()
    assert.match(result.errorMessage!, /payload captured/)
    return payloads.at(-1)
  }
  assert.equal((await send()).model, "grok-test-high-fast")
  const params = Object.fromEntries(payloads[0].params.map((p: any) => [p.id, p.value]))
  assert.deepEqual(params, { context: "256k", reasoning_effort: "high", fast: "true" })
  assert.equal((await send("background-session")).model, "grok-test-high")
  await h.command("off")
  assert.equal((await send()).model, "grok-test-high")
  h.setModel(models[1]); h.setLevel("low")
  await h.command("on")
  const large = await send("fast-session", models[1], "low")
  assert.deepEqual(Object.fromEntries(large.params.map((p: any) => [p.id, p.value])), { context: "500k", reasoning_effort: "low", fast: "true" })
})

test("an enabled mode becomes an explicit request error when thinking loses fast support", async () => {
  const { models, token } = await catalogue()
  const h = harness(models)
  h.setModel(models[1]); h.setLevel("low")
  await h.emit("session_start")
  await h.command("on")
  h.setLevel("high")
  await h.emit("thinking_level_select")
  const result = await h.controller.stream(models[1], context, { apiKey: token, sessionId: "fast-session", reasoning: "high" }).result()
  assert.match(result.errorMessage!, /fast is enabled but unavailable/)
})

test("changing fast rebuilds a tool continuation instead of resuming its old speed", async () => {
  const { raw, token } = await catalogue()
  const tools = [{ name: "echo", description: "echo", schema: { type: "object" } }]
  const messages: any[] = [{ role: "user", content: "hello" }]
  const args = { tok: token, model: "grok-test@256k", effort: "high", session: "native-fast", messages, tools, rawModels: raw, resolveAgentURL: () => "https://cursor.test" }
  await assert.rejects(runAnswer({ ...args, fast: true, onPayload: () => { throw new Error("captured fast") } }), /captured fast/)
  const owner: any = [...(nativeSessions as any).entries][0]
  assert.ok(owner)
  owner.chatTools = tools
  owner.bind({ send: () => {}, close: () => {} }, new Map(), 4)
  owner.listed(1)
  owner.acceptCall({ requestID: 7, execID: "exec-1", nativeID: "native-1", name: "echo", args: "{}" })
  owner.delivered()
  const id = owner.segment.calls[0].id
  messages.push({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "echo", arguments: "{}" } }] }, { role: "tool", tool_call_id: id, content: "ok" })
  await assert.rejects(runAnswer({ ...args, fast: false, onPayload: () => { throw new Error("captured normal rebuild") } }), /captured normal rebuild/)
  assert.equal(owner.state, "awaiting-results")
})
