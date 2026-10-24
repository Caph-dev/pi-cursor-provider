import assert from "node:assert/strict"
import { test } from "node:test"
import { resolveAccessToken } from "../src/auth.ts"
import { fields, pb, pbStr } from "../src/codec.ts"
import { CURSOR_NOT_SIGNED_IN } from "../src/pi-stream.ts"
import { conversationID } from "../src/run.ts"

const emptyLookup = {
  stored: () => "",
  cliAuth: () => "",
  keychain: () => "",
  ide: () => "",
}

function jwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url")
  return `${header}.${payload}.sig`
}

test("conversationID stays put for one session and its first user message", () => {
  const session = "session-a"
  const first = { role: "user", content: "hello" }
  const base = { messages: [first, { role: "assistant", content: "hi" }] }
  const again = { messages: [first, { role: "user", content: "a later turn" }] }
  const id = conversationID(base, session)
  assert.equal(conversationID(again, session), id)
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  const changed = conversationID({ messages: [{ role: "user", content: "other opening" }] }, session)
  assert.notEqual(changed, id)
  assert.equal(conversationID(base, ""), "")
  assert.equal(conversationID(base, "   "), "")
})

test("resolveAccessToken is undefined when every lookup is empty", async () => {
  const auth = await resolveAccessToken({
    apiKey: "",
    env: { CURSOR_ACCESS_TOKEN: "" },
    lookup: emptyLookup,
  })
  assert.equal(auth, undefined)
})

test("resolveAccessToken reads cursor-agent before the keychain", async () => {
  const token = jwt(Math.floor(Date.now() / 1000) + 3600)
  const auth = await resolveAccessToken({
    apiKey: "",
    env: { CURSOR_ACCESS_TOKEN: "" },
    lookup: {
      stored: () => "",
      cliAuth: () => token,
      keychain: () => jwt(Math.floor(Date.now() / 1000) + 7200),
      ide: () => "",
    },
  })
  assert.equal(auth?.source, "cursor-agent")
  assert.equal(auth?.token, token)
})

test("resolveAccessToken skips an expired cursor-agent token", async () => {
  const auth = await resolveAccessToken({
    apiKey: "",
    env: { CURSOR_ACCESS_TOKEN: "" },
    lookup: {
      ...emptyLookup,
      cliAuth: () => jwt(1),
    },
  })
  assert.equal(auth, undefined)
})

test("missing auth tells the user Cursor isn't signed in", () => {
  assert.match(CURSOR_NOT_SIGNED_IN, /isn't signed in|not signed in/)
})

test("pb roundtrips a string field", () => {
  const encoded = pb().str(1, "hi").done()
  assert.equal(pbStr(fields(encoded), 1), "hi")
})

test("conversation forwards isError on tool results", async () => {
  const { conversation } = await import("../src/run.ts")
  const tools = [
    {
      name: "echo",
      description: "echo",
      schema: { type: "object", properties: {} },
      schemaText: "{}",
    },
  ]
  const chat = {
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "echo", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "boom", isError: true },
    ],
  }
  const { msgs } = conversation(chat, tools)
  const toolMsg = msgs.map((b: Buffer) => JSON.parse(Buffer.from(b).toString())).find((m: { role: string }) => m.role === "tool")
  assert.equal(toolMsg?.content?.[0]?.isError, true)
})

test("statusOf maps context-too-long to 400", async () => {
  const { statusOf } = await import("../src/codec.ts")
  const mapped = statusOf(400, "invalid_argument", "prompt is too long for the model")
  assert.equal(mapped.status, 400)
  assert.match(mapped.message, /input is too long for the model's context/)
})
