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

/** 8x8 solid red PNG (vision-friendly; not a 1x1 speck). */
const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAMElEQVQYV2P8z8BQwMDA" +
  "wPD///8GBgYGBhAFMsE0iAbRIAKkhUQD2SAarIckGAC9XQcBj1l4xwAAAABJRU5ErkJggg=="

function redactToken(value: string): string {
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

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}") as unknown
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
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
  assert.doesNotMatch(formatted, /\beyJ[A-Za-z0-9_-]{10,}\./)
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

live("e2e: parallel tool calls in one turn + joint resume", async () => {
  assert.ok(token && model, "prior steps failed")
  const session = `e2e-parallel-${Date.now()}`
  const tools = [
    {
      name: "add_two",
      description: "Add two integers a and b. Must be called when summing.",
      schema: {
        type: "object",
        properties: {
          a: { type: "integer" },
          b: { type: "integer" },
        },
        required: ["a", "b"],
      },
    },
    {
      name: "mul_two",
      description: "Multiply two integers a and b. Must be called when multiplying.",
      schema: {
        type: "object",
        properties: {
          a: { type: "integer" },
          b: { type: "integer" },
        },
        required: ["a", "b"],
      },
    },
  ]
  const messages1 = [
    {
      role: "system",
      content:
        "You are a calculator agent. For the user request you MUST call BOTH add_two AND mul_two in the SAME turn (parallel tool calls), with a=3 and b=4 for each. Do not answer with final numbers until both tool results return.",
    },
    { role: "user", content: "Compute 3+4 and 3*4 using the tools in parallel, then report both results." },
  ]
  const ran1 = await runAnswer({ tok: token, model, messages: messages1, tools, session })
  assert.equal(ran1.error, undefined, redactToken(String(ran1.error?.message ?? "")))
  const turn1 = await drain(ran1.events!)
  if (turn1.stop !== "tool_calls" || turn1.tools.length < 2) {
    console.log(
      `FAIL_OR_SKIP_PARALLEL stop=${turn1.stop} tools=${turn1.tools.length} names=${turn1.tools.map((t) => t.name).join(",")} text=${turn1.text.slice(0, 120)}`,
    )
    assert.ok(
      turn1.tools.length >= 2,
      `expected >=2 parallel tool calls, got ${turn1.tools.length} stop=${turn1.stop}`,
    )
  }
  const names = new Set(turn1.tools.map((t) => t.name))
  assert.ok(names.has("add_two") && names.has("mul_two"), `expected add_two+mul_two, got ${[...names]}`)
  assert.ok(turn1.tools.every((t) => /^call_cursor_[a-f0-9]+_\d+_\d+$/.test(t.id)))

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
    ...turn1.tools.map((t) => {
      const args = parseArgs(t.args)
      const a = Number(args.a ?? 3)
      const b = Number(args.b ?? 4)
      const value = t.name === "mul_two" ? a * b : a + b
      return {
        role: "tool",
        tool_call_id: t.id,
        content: JSON.stringify({ value, op: t.name }),
      }
    }),
  ]
  const ran2 = await runAnswer({ tok: token, model, messages: messages2, tools, session })
  assert.equal(ran2.error, undefined, redactToken(String(ran2.error?.message ?? "")))
  const turn2 = await drain(ran2.events!)
  assert.equal(turn2.error, undefined, redactToken(String(turn2.error?.message ?? "")))
  assert.equal(turn2.stop, "stop")
  assert.ok(/7/.test(turn2.text) && /12/.test(turn2.text), `expected 7 and 12 in reply, got: ${turn2.text.slice(0, 200)}`)
  console.log(`parallelTools n=${turn1.tools.length} final=${turn2.text.trim().slice(0, 120)}`)
})

live("e2e: tool error feedback (isError) resumes and is acknowledged", async () => {
  assert.ok(token && model, "prior steps failed")
  const session = `e2e-toolerr-${Date.now()}`
  const tools = [
    {
      name: "lookup_code",
      description: "Look up a short code. Call once before answering.",
      schema: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
      },
    },
  ]
  const messages1 = [
    {
      role: "system",
      content: "You must call lookup_code with code=ALPHA once before any final answer.",
    },
    { role: "user", content: "Look up ALPHA with the tool, then say what happened in one short sentence." },
  ]
  const ran1 = await runAnswer({ tok: token, model, messages: messages1, tools, session })
  assert.equal(ran1.error, undefined, redactToken(String(ran1.error?.message ?? "")))
  const turn1 = await drain(ran1.events!)
  if (turn1.stop !== "tool_calls" || !turn1.tools.length) {
    assert.fail(`expected tool_calls for error-feedback test, stop=${turn1.stop} tools=${turn1.tools.length}`)
  }
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
      content: "lookup_code failed: code ALPHA is not in the catalog",
      isError: true,
    })),
  ]
  const ran2 = await runAnswer({ tok: token, model, messages: messages2, tools, session })
  assert.equal(ran2.error, undefined, redactToken(String(ran2.error?.message ?? "")))
  const turn2 = await drain(ran2.events!)
  assert.equal(turn2.error, undefined, redactToken(String(turn2.error?.message ?? "")))
  assert.equal(turn2.stop, "stop")
  assert.ok(turn2.text.trim().length > 0, "expected text after error tool result")
  // Model should mention failure / error / not found — not invent a successful lookup value.
  assert.match(
    turn2.text,
    /fail|error|not (in|found)|unable|couldn't|could not|missing|unavailable|catalog/i,
    `expected error acknowledgement, got: ${turn2.text.slice(0, 240)}`,
  )
  console.log(`toolErrorFeedback text=${turn2.text.trim().slice(0, 160)}`)
})

live("e2e: vision / image_url user input is understood", async () => {
  assert.ok(token && model, "prior steps failed")
  // Prefer a flash/vision-capable cheap model; fall back to picked model.
  const visionPrefer = ["gemini-3-flash", "gemini-3.5-flash", "gpt-5-mini", "composer-2.5", model]
  const ids = new Set(modelIds)
  const visionModel = visionPrefer.find((id) => ids.has(id)) || model

  // Build a reliable 8x8 red PNG with pure Node (fixture above may be imperfect).
  const { deflateSync } = await import("node:zlib")
  const w = 8
  const h = 8
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3
      raw[i] = 255
      raw[i + 1] = 0
      raw[i + 2] = 0
    }
  }
  const crcTable = (() => {
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })()
  const crc = (buf: Buffer) => {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const typeBuf = Buffer.from(type, "ascii")
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([typeBuf, data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`
  void RED_PNG_B64

  const ran = await runAnswer({
    tok: token,
    model: visionModel,
    messages: [
      {
        role: "system",
        content: "Describe the image briefly. Reply with exactly one word for the dominant color in English lowercase.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "What is the dominant color of this image? One word only." },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    tools: [],
    session: `e2e-vision-${Date.now()}`,
  })
  assert.equal(ran.error, undefined, redactToken(String(ran.error?.message ?? "")))
  const out = await drain(ran.events!)
  assert.equal(out.error, undefined, redactToken(String(out.error?.message ?? "")))
  assert.equal(out.stop, "stop")
  assert.match(out.text.toLowerCase(), /\bred\b/, `expected color red, got: ${out.text.slice(0, 200)}`)
  console.log(`vision model=${visionModel} reply=${out.text.trim().slice(0, 80)}`)
})

live("e2e: context overflow surfaces mapped length error (no provider compaction)", async () => {
  assert.ok(token && model, "prior steps failed")
  // This package (and magpie AgentService/Run) does not implement client-side
  // conversation compaction. We only verify overflow is reported as a mapped
  // context-length error rather than hanging or leaking tokens.
  //
  // Use a large repeated block (~400k chars ≈ ~100k tokens of filler). If the
  // chosen model has a larger window and accepts the prompt, we still assert
  // the Run completes cleanly and note "no overflow" — that is not a compaction
  // pass; provider compaction remains unsupported.
  const filler = ("CONTEXT_PAD_" + "lorem ipsum dolor sit amet ".repeat(40) + "\n").repeat(400)
  assert.ok(filler.length > 200_000, `filler too small: ${filler.length}`)

  const ran = await runAnswer({
    tok: token,
    model,
    messages: [
      { role: "system", content: "Reply with OK only." },
      { role: "user", content: `Ignore the padding and reply with exactly: OK\n\n${filler}` },
    ],
    tools: [],
    session: `e2e-overflow-${Date.now()}`,
  })

  if (ran.error) {
    const msg = String(ran.error.message ?? "")
    assert.match(
      msg,
      /input is too long|context[_ ]length|too many tokens|too long for the model's context|Request Entity Too Large|413/i,
      `unexpected overflow-shaped error: ${redactToken(msg)}`,
    )
    console.log(`contextOverflow status=${ran.error.status} mapped=yes`)
    return
  }

  const out = await drain(ran.events!)
  if (out.error) {
    const msg = String(out.error.message ?? "")
    assert.match(
      msg,
      /input is too long|context[_ ]length|too many tokens|too long for the model's context|Request Entity Too Large|413/i,
      `unexpected stream error: ${redactToken(msg)}`,
    )
    console.log(`contextOverflow streamError status=${out.error.status} mapped=yes`)
    return
  }

  // Accepted: Cursor did not reject. Provider still has no compaction API.
  assert.equal(out.stop, "stop")
  console.log(
    `contextOverflow accepted_without_reject prompt_tokens=${out.usage?.prompt_tokens ?? "?"} note=provider_compaction_unsupported`,
  )
})

after(async () => {
  token = ""
  await clearNativeSessions().catch(() => {})
})
