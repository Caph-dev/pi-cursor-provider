/**
 * Live Cursor account e2e (real network).
 *
 * Opt-in only: CURSOR_E2E=1 npm run test:e2e
 * Default `npm test` skips these so the suite stays offline.
 *
 * Never logs access tokens. Failures report credential source type only.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { resolveAccessToken, type AuthSource } from "../src/auth.ts"
import { usable } from "../src/models.ts"
import { clearNativeSessions } from "../src/native-session.ts"
import { runAnswer } from "../src/run.ts"
import { fetchUsage, formatUsage } from "../src/usage.ts"

const LIVE = process.env.CURSOR_E2E === "1"
const CHEAP = ["gemini-3-flash", "gemini-3.5-flash", "glm-5p3-flash", "composer-2.5", "gpt-5-mini", "auto"]

function redactToken(value: string): string {
  // Defense in depth if an assertion message ever embeds a token-like string.
  return value.replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted-jwt]")
}

async function drain(
  events: AsyncIterable<{
    text?: string
    tool?: { id: string; name: string; args: string }
    stop?: string
    usage?: { prompt_tokens?: number; completion_tokens?: number }
    error?: { status?: number; message?: string }
  }>,
) {
  let text = ""
  let stop = ""
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined
  const tools: { id: string; name: string; args: string }[] = []
  let error: { status?: number; message?: string } | undefined
  for await (const ev of events) {
    if (ev.text) text += ev.text
    if (ev.tool) tools.push({ id: ev.tool.id, name: ev.tool.name, args: ev.tool.args ?? "{}" })
    if (ev.stop) {
      stop = ev.stop
      usage = ev.usage
    }
    if (ev.error) error = ev.error
  }
  return { text, stop, usage, tools, error }
}

const live = LIVE ? test : test.skip

let authSource: AuthSource | undefined
let token = ""
let model = ""
let modelIds: string[] = []

live("e2e: resolveAccessToken finds a credential (source only)", async () => {
  const auth = await resolveAccessToken()
  assert.ok(auth, "Cursor is not signed in. Need CURSOR_ACCESS_TOKEN, /login cursor, or cursor-agent auth.json")
  assert.ok(["environment", "pi-oauth", "cursor-agent", "keychain", "ide-state"].includes(auth.source))
  assert.ok(auth.token.length >= 20)
  authSource = auth.source
  token = auth.token
  console.log(`auth.source=${authSource}`)
})

live("e2e: AvailableModels / usable picks a cheap or flash model", async () => {
  assert.ok(token, "prior auth step failed")
  const raw = await usable(token, true)
  assert.ok(raw.length > 0, "Cursor listed no models")
  modelIds = raw.map((m: { id: string }) => m.id)
  const ids = new Set(modelIds)
  model = CHEAP.find((id) => ids.has(id)) || modelIds[0]!
  assert.ok(model)
  console.log(`modelCount=${modelIds.length} pickedModel=${model}`)
})

live("e2e: simple Run without tools returns text", async () => {
  assert.ok(token && model, "prior steps failed")
  const ran = await runAnswer({
    tok: token,
    model,
    messages: [
      { role: "system", content: "Reply with a single short sentence." },
      { role: "user", content: "What is 2+2? Answer with only the number and a period." },
    ],
    tools: [],
    session: `e2e-simple-${Date.now()}`,
  })
  assert.equal(ran.error, undefined, redactToken(String(ran.error?.message ?? "")))
  assert.ok(ran.events)
  const out = await drain(ran.events!)
  assert.equal(out.error, undefined, redactToken(String(out.error?.message ?? "")))
  assert.equal(out.stop, "stop")
  assert.ok(out.text.trim().length > 0, "expected assistant text")
  assert.equal(out.tools.length, 0)
  console.log(`simpleRun textLen=${out.text.length} stop=${out.stop} hasUsage=${!!out.usage}`)
})

live("e2e: fetchUsage returns billing-period windows", async () => {
  assert.ok(token, "prior auth step failed")
  const report = await fetchUsage(token, modelIds.length ? modelIds : [model || "auto"])
  assert.ok(!report.error, report.error ? `usage error: ${report.error}` : "")
  assert.ok(report.windows.length > 0, "expected at least one usage window")
  const formatted = formatUsage(report)
  assert.match(formatted, /Cursor Models|Total|Plan:/)
  assert.doesNotMatch(formatted, /\beyJ[A-Za-z0-9_-]{10,}\./) // no JWT in output
  console.log(
    `usage plan=${report.plan ?? "?"} windows=${report.windows.map((w) => `${w.name}:${Math.round(w.used * 100) / 100}`).join("|")}`,
  )
})

live("e2e: native tool continuation resumes call_cursor_ results", async () => {
  assert.ok(token && model, "prior steps failed")
  const session = `e2e-native-${Date.now()}`
  const echoTool = {
    name: "echo_word",
    description: "Echo a single word. Call this before answering when the user asks for an echo.",
    schema: {
      type: "object",
      properties: { word: { type: "string", description: "Word to echo" } },
      required: ["word"],
    },
  }
  const messages1 = [
    {
      role: "system",
      content: "You must call echo_word exactly once with word=ping before answering. Do not answer without the tool.",
    },
    { role: "user", content: "Use echo_word with word=ping, then tell me the echoed result in one short sentence." },
  ]

  const ran1 = await runAnswer({ tok: token, model, messages: messages1, tools: [echoTool], session })
  assert.equal(ran1.error, undefined, redactToken(String(ran1.error?.message ?? "")))
  const turn1 = await drain(ran1.events!)
  if (turn1.stop !== "tool_calls" || !turn1.tools.length) {
    console.log(`SKIP_NATIVE reason=no tool_calls on turn1 stop=${turn1.stop} tools=${turn1.tools.length}`)
    return
  }
  assert.ok(
    turn1.tools.every((t) => /^call_cursor_[a-f0-9]+_\d+_\d+$/.test(t.id)),
    `expected call_cursor_ ids, got ${turn1.tools.map((t) => t.id).join(",")}`,
  )

  const messages2 = [
    ...messages1,
    {
      role: "assistant",
      content: turn1.text,
      tool_calls: turn1.tools.map((t) => ({
        id: t.id,
        type: "function",
        function: { name: t.name, arguments: t.args || "{}" },
      })),
    },
    ...turn1.tools.map((t) => ({
      role: "tool",
      tool_call_id: t.id,
      content: JSON.stringify({ echoed: "ping", ok: true }),
    })),
  ]

  const ran2 = await runAnswer({ tok: token, model, messages: messages2, tools: [echoTool], session })
  assert.equal(ran2.error, undefined, redactToken(String(ran2.error?.message ?? "")))
  const turn2 = await drain(ran2.events!)
  assert.equal(turn2.error, undefined, redactToken(String(turn2.error?.message ?? "")))
  assert.equal(turn2.stop, "stop")
  assert.ok(turn2.text.trim().length > 0, "expected final text after tool resume")
  console.log(`nativeResume turn1Tools=${turn1.tools.length} turn2TextLen=${turn2.text.length}`)
})

after(async () => {
  token = ""
  await clearNativeSessions().catch(() => {})
})
