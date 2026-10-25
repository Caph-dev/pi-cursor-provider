/**
 * Ported from magpie's Cursor provider (MIT):
 * https://github.com/magpie-community/plugins/tree/main/packages/cursor
 * which itself was ported from magpie's Go client (internal/provider/cursor*.go).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { EMPTY, failure, field, fields, pb, pbAny, pbNum, pbStr, pbValue } from "./codec.ts"
import { CALL, GOOS, NAMESPACE, tempDir } from "./client.ts"
import { NativeSessionError, nativeFields, nativeMcpArgs } from "./native-session.ts"

/** A tool decode and exec accept. schemaText may be absent. A missing one stays missing. */
export type ExecTool = { name: string; description?: string; schema?: unknown; schemaText?: string }

export type ChatTool = { name: string; description: string; schema: unknown; schemaText: string }

export type Conversation = { msgs: Buffer[]; last: string; estimate: number }

export type BlobStore = Map<string, Buffer>

/** One frame of a Connect stream: a message, or, with end, the stream's closing JSON. */
export type Frame = { end?: boolean; data: Buffer }

export type ModelParam = { id: string; value: string }

/** One model call's usage as magpie counts it. input is the prompt's uncached rest. */
export type UsageCounts = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }

export type RunError = { status: number; message: string }

export type RunUsage = {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details: { cached_tokens: number; cache_write_tokens: number }
  completion_tokens_details?: { reasoning_tokens: number }
  /** Earlier steps' usage collected with this one. It is not this step's context size. */
  magpie_deferred?: { prompt_tokens: number; completion_tokens: number; cached_tokens: number; cache_write_tokens: number }
  magpie_native?: { accounting: "pending" | "estimated" | "replayed" }
}

/** What a Run streams to the caller. Each event sets one of text, reasoning, tool, stop, or error. */
export type RunEvent = {
  text?: string
  reasoning?: string
  tool?: ToolCall & { index: number }
  stop?: "stop" | "tool_calls"
  usage?: RunUsage
  error?: RunError
}

export type ToolCall = { id: string; name: string; args: string }

export type NativeCall = { requestID: number; execID: string; nativeID: string; name: string; args: string }

/** What onPayload is shown before a Run's request is written. A model it hands back is asked for instead. */
export type Payload = { model: string; maxMode: boolean; params: readonly ModelParam[]; conversationId: string; tools: string[] }

type Field = ReturnType<typeof fields>[number]
type ChatPart = { type?: string; text?: string; image_url?: string | { url?: string }; file?: { filename?: string } }
type ChatCall = { id: string; type?: string; function?: { name?: string; arguments?: string } }
type ChatMessage = {
  role?: string
  content?: string | readonly ChatPart[] | null
  tool_calls?: readonly ChatCall[]
  tool_call_id?: string
  is_error?: unknown
  isError?: unknown
}
type FunctionTool = { type?: string; function?: { name?: string; description?: string; parameters?: unknown } }

const NO_RESULT = "Tool use was interrupted and did not produce a result."
const TOOL_IDLE_MS = 3_000

const textOf = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("") : ""

// joinSplitCalls joins an assistant message onto the assistant message
// before it when that one made tool calls: Anthropic takes consecutive
// assistant messages as one turn, and an agent can send a turn's parallel
// calls split over two of them, answered together after (yetone/magpie#1275).
// Answered at the second message, the first calls would be marked
// interrupted and their real results dropped. msgs is left as it is.
function joinSplitCalls(msgs: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of msgs) {
    const prev = out.at(-1)
    if (m?.role === "assistant" && prev?.role === "assistant" && prev.tool_calls?.length) {
      const content = [textOf(prev.content), textOf(m.content)].filter(Boolean).join("\n\n")
      out[out.length - 1] = { ...prev, content, tool_calls: [...prev.tool_calls, ...(m.tool_calls ?? [])] }
      continue
    }
    out.push(m)
  }
  return out
}

function parseArgs(s: unknown): object {
  if (s && typeof s === "object") return s
  try {
    const v = JSON.parse((s as string) || "{}")
    return v && typeof v === "object" ? v : {}
  } catch {
    return {}
  }
}

export function toolsOf(chat: { tools?: readonly FunctionTool[] }): ChatTool[] {
  return (chat.tools ?? [])
    .filter((t): t is { type: string; function: { name: string; description?: string; parameters?: unknown } } => t?.type === "function" && !!t.function?.name)
    .map((t) => {
      const schema = t.function.parameters ?? { type: "object", properties: {} }
      return { name: t.function.name, description: t.function.description ?? "", schema, schemaText: JSON.stringify(schema) }
    })
}

// catalog lists the caller's tools for the model. It sees MCP tools only
// through Cursor's GetDynamicTools and CallDynamicTool, and Cursor names
// them in a prompt of its own, which this conversation goes without:
// without the list the model says it has no such tool. Each entry is
// written as the CallDynamicTool call itself: listed as <tool name=...>,
// some models (GLM-5.3) called the names bare, as tools of their own, and
// those calls went nowhere (#11).
function catalog(tools: readonly ChatTool[]): string {
  if (!tools.length) return ""
  const visible = (value: unknown) => String(value ?? "").replaceAll("<", "\\u003c")
  let s = `\n\n<dynamic_tool_catalog>\nThe MCP namespace "pi" has the tools below. They are reached only through \`${CALL}\`, never as tools of their own. Each entry is the exact call to make; its arguments must match the schema given. The schemas are complete, so there is no need to call \`GetDynamicTools\` first.\n`
  for (const t of tools) {
    const name = JSON.stringify(String(t.name ?? "")).replaceAll("<", "\\u003c")
    s += `<call>${CALL}({"namespace":"${NAMESPACE}","toolName":${name},"arguments":{...}})\n${visible(t.description)}\narguments schema: ${visible(t.schemaText)}\n</call>\n`
  }
  return s + "</dynamic_tool_catalog>"
}

// An OpenAI model's id is its call's and its item's, a line apart, which no
// caller would take as an id: callerID sends the line as __, and callID
// gives Cursor its own id back.
const callerID = (id: string) => id.replaceAll("\n", "__")
const callID = (id: string) => (id.startsWith("call_") ? id.replace("__fc_", "\nfc_") : id)

function result(id: string, text: string, isError: boolean) {
  let res: unknown = text
  try {
    res = JSON.parse(text)
  } catch {}
  return {
    type: "tool-result",
    toolCallId: callID(id),
    toolName: CALL,
    result: res,
    experimental_content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  }
}

export function conversation(chat: { messages?: readonly unknown[] }, tools: readonly ChatTool[]): Conversation {
  const messages = (chat.messages ?? []) as readonly ChatMessage[]
  const out: Buffer[] = []
  let size = 0
  const add = (m: object) => out.push(Buffer.from(JSON.stringify(m)))
  const system: string[] = []
  let last = "."
  for (const m of messages)
    if (m.role === "system" || m.role === "developer") system.push(textOf(m.content))
  const sys = system.filter(Boolean).join("\n\n") + catalog(tools)
  size += sys.length
  if (sys) add({ role: "system", content: sys })
  let pending: string[] = []
  let results: object[] = []
  const answer = () => {
    for (const id of pending) results.push(result(id, NO_RESULT, true))
    pending = []
    if (results.length) add({ role: "tool", content: results })
    results = []
  }
  for (const m of joinSplitCalls(messages)) {
    if (m.role === "system" || m.role === "developer") continue
    if (m.role === "tool") {
      const id = m.tool_call_id ?? ""
      const i = pending.indexOf(id)
      if (i >= 0) {
        pending.splice(i, 1)
        const text = textOf(m.content)
        size += text.length
        results.push(result(id, text, m.is_error === true || m.isError === true))
      }
      continue
    }
    if (m.role === "assistant") {
      answer()
      const content: object[] = []
      const text = textOf(m.content)
      if (text) content.push({ type: "text", text })
      size += text.length
      for (const c of m.tool_calls ?? []) {
        if (c?.type && c.type !== "function") continue
        const args = parseArgs(c.function?.arguments)
        size += (c.function?.arguments ?? "").length + (c.function?.name ?? "").length
        content.push({ type: "tool-call", toolCallId: callID(c.id), toolName: CALL, args: { namespace: NAMESPACE, toolName: c.function?.name, arguments: args } })
        pending.push(c.id)
      }
      if (content.length) add({ role: "assistant", content })
      continue
    }
    const content: object[] = []
    const parts: readonly ChatPart[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? []
    let first = ""
    for (const p of parts) {
      if (p?.type === "text" && p.text) {
        content.push({ type: "text", text: p.text })
        size += p.text.length
        first ||= p.text
      } else if (p?.type === "image_url") {
        const u = typeof p.image_url === "string" ? p.image_url : p.image_url?.url ?? ""
        const d = /^data:([^;,]+);base64,(.*)$/s.exec(u)
        if (d) content.push({ type: "image", mimeType: d[1], image: { __type: "Uint8Array", hex: Buffer.from(d[2], "base64").toString("hex") } })
        else content.push({ type: "text", text: `[attachment image: ${u}]` })
      } else if (p?.type === "file") {
        content.push({ type: "text", text: `[attachment ${p.file?.filename ?? "file"}]` })
      }
    }
    answer()
    if (first) last = first
    if (content.length) add({ role: "user", content })
  }
  answer()
  for (const t of tools) size += t.name.length + t.description.length + t.schemaText.length
  return { msgs: out, last, estimate: Math.floor(size / 4) }
}

function uuidOf(b: Buffer): string {
  b = Buffer.from(b.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// conversationID is stable for one Pi session plus its first user message,
// so Cursor keeps sending the conversation to the machine that cached the
// prompt. The first message keeps subagents that share a session id apart.
// With no session it is "", and each Run gets a new id.
export function conversationID(chat: { messages?: readonly unknown[] } | undefined, session: string | undefined): string {
  const key = String(session ?? "").trim()
  if (!key) return ""
  const msgs: readonly ChatMessage[] = Array.isArray(chat?.messages) ? chat.messages : []
  const first = msgs.find((m) => m?.role === "user") ?? msgs[0]
  // role and content only: a timestamp on the same first message must not move the id
  const stable = first === undefined ? "" : JSON.stringify({ role: first.role, content: first.content })
  const sum = createHash("sha256")
    .update("cursor conversation\0" + key + "\0" + stable)
    .digest()
  return uuidOf(sum)
}

function toolDef(t: ExecTool): Buffer {
  const d = pb().str(1, t.name)
  if (t.description) d.str(2, t.description)
  d.bytes(3, pbValue(t.schema))
  return d.str(4, NAMESPACE).str(5, t.name).str(6, t.schemaText).done()
}

const env = () => pb().str(1, GOOS).str(2, tempDir()).str(10, "UTC")

export function buildRun(
  msgs: readonly Buffer[],
  lastUser: string,
  tools: readonly ChatTool[],
  model: string,
  conv = "",
  { maxMode = false, params = [] }: { maxMode?: boolean; params?: readonly ModelParam[] } = {},
): { first: Buffer; blobs: BlobStore } {
  const blobs: BlobStore = new Map()
  const put = (b: Buffer) => {
    const id = createHash("sha256").update(b).digest()
    blobs.set(id.toString("hex"), b)
    return id
  }
  const state = pb()
  for (const m of msgs) state.bytes(1, put(m))
  const mid = randomUUID()
  const user = pb().str(1, lastUser).str(2, mid).varint(4, 1).done() // mode: agent
  const turn = pb().bytes(1, pb().bytes(1, put(user)).str(10, mid)).done()
  state.bytes(8, put(turn)).varint(10, 1).str(22, "cli")
  const defs = tools.map(toolDef)
  const rc = pb().bytes(4, env())
  const mcp = pb()
  for (const d of defs) {
    rc.bytes(7, d)
    mcp.bytes(1, d)
  }
  const action = pb().bytes(2, pb().bytes(2, rc)) // resume_action
  // ModelDetails: model_id, display_model_id, display_name, max_mode (7);
  // RequestedModel: model_id, max_mode (2), parameters (3)
  const details = pb().str(1, model).str(3, model).str(4, model)
  const requested = pb().str(1, model)
  if (maxMode) {
    details.varint(7, 1)
    requested.varint(2, 1)
  }
  for (const p of params) requested.bytes(3, pb().str(1, p.id).str(2, p.value))
  const rr = pb()
    .bytes(1, state)
    .bytes(2, action)
    .bytes(3, details)
    .bytes(4, mcp)
    .str(5, conv || randomUUID())
    .bytes(9, requested)
    .varint(19, 1) // inline images
  return { first: pb().bytes(1, rr).done(), blobs }
}

// usageOf is a TurnEndedUpdate as magpie counts usage, as the built-in's
// cursorUsage has it (magpie #498). Its input_tokens is the whole prompt,
// what was read from the cache and written to it included, as Cursor's
// own client has it (it takes both out to get the prompt's uncached
// rest); input is that rest, the cache added back for prompt_tokens. Its
// reasoning_tokens is kept as reasoning.
export function usageOf(uf: readonly Field[]): UsageCounts {
  const [inp, cr, cw] = [pbNum(uf, 1), pbNum(uf, 3), pbNum(uf, 4)]
  return { input: Math.max(inp - cr - cw, 0), output: pbNum(uf, 2), cacheRead: cr, cacheWrite: cw, reasoning: pbNum(uf, 5) }
}

export type DecodeOptions = {
  send: (message: Buffer) => void
  blobs: ReadonlyMap<string, Buffer>
  tools: readonly ExecTool[]
  estimate?: number
  close?: () => void
  /** The stateless step's own usage from the dashboard. false: none was counted. */
  stepUsage?: () => Promise<UsageCounts | null | false>
  /** What the conversation owes from earlier steps, sent on as magpie_deferred. */
  owedUsage?: (final: boolean) => Promise<UsageCounts | null>
  toolIdleMs?: number
}

type Next = { v: IteratorResult<Frame>; e?: undefined; idle?: undefined } | { e: unknown; v?: undefined; idle?: undefined } | { idle: true; v?: undefined; e?: undefined }

export async function* decode(
  stream: Iterable<Frame> | AsyncIterable<Frame>,
  { send, blobs, tools, estimate = 0, close, stepUsage, owedUsage, toolIdleMs = TOOL_IDLE_MS }: DecodeOptions,
): AsyncGenerator<RunEvent, void> {
  let calls = 0
  let answered = 0
  let ended = false
  let listed = 0
  const stepDone = () => {
    if (!listed || calls + answered < listed) return false
    if (calls > 0) return true
    listed = 0
    answered = 0
    return false
  }
  let said = 0
  let wrote = 0
  let usage: UsageCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  let counted = false
  const finish = (more: UsageCounts | null) => {
    if (!counted && !usage.output) usage.output = Math.floor((said + 3) / 4)
    if (!counted && !usage.input && !usage.cacheRead && !usage.cacheWrite) usage.input = estimate
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite
    const deferred = more && more.input + more.output + more.cacheRead + more.cacheWrite > 0
    return {
      stop: calls > 0 ? ("tool_calls" as const) : ("stop" as const),
      usage: {
        prompt_tokens: prompt,
        completion_tokens: usage.output,
        total_tokens: prompt + usage.output,
        prompt_tokens_details: { cached_tokens: usage.cacheRead, cache_write_tokens: usage.cacheWrite },
        ...(usage.reasoning ? { completion_tokens_details: { reasoning_tokens: usage.reasoning } } : {}),
        ...(deferred
          ? {
              magpie_deferred: {
                prompt_tokens: more.input + more.cacheRead + more.cacheWrite,
                completion_tokens: more.output,
                cached_tokens: more.cacheRead,
                cache_write_tokens: more.cacheWrite,
              },
            }
          : {}),
      },
    }
  }
  const settled = async () => {
    if (calls > 0 && !ended && stepUsage) {
      close?.()
      const u = await stepUsage().catch(() => null)
      if (u) usage = u
      counted = u === false || !!u
    } else if (calls > 0) {
      close?.()
    }
    return finish(owedUsage ? await owedUsage(calls === 0).catch(() => null) : null)
  }
  const closeExec = (id: number) => send(pb().bytes(5, pb().bytes(1, pb().varint(1, id))).done())
  async function* asAsync(src: Iterable<Frame> | AsyncIterable<Frame>) {
    yield* src
  }
  const iter = asAsync(stream)[Symbol.asyncIterator]()
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const moreComing = () => calls > 0 && !(listed > 0 && calls + answered >= listed)
  try {
    while (true) {
      const pending = iter.next().then((v): Next => ({ v }), (e): Next => ({ e }))
      let got: Next
      if (moreComing()) {
        got = await Promise.race([
          pending,
          new Promise<Next>((resolve) => {
            idleTimer = setTimeout(() => resolve({ idle: true }), toolIdleMs)
          }),
        ])
        clearTimeout(idleTimer)
      } else got = await pending
      if (got.idle) {
        yield await settled()
        return
      }
      if (got.e) throw got.e
      if (got.v!.done) {
        if (calls > 0) yield await settled()
        else yield { error: { status: 502, message: "the reply broke off: EOF" } }
        return
      }
      const f = got.v!.value
      if (f.end) {
        const e = failure(200, f.data)
        if (e.status < 200 || e.status > 299) yield { error: e }
        else if (wrote === 0 && calls === 0) yield { error: { status: 502, message: "an empty reply" } }
        else yield await settled()
        return
      }
      for (const m of fields(f.data)) {
        switch (m.num) {
          case 1: // interaction_update
            for (const u of fields(m.data)) {
              const uf = fields(u.data)
              switch (u.num) {
                case 1: {
                  const t = pbStr(uf, 1)
                  if (t) {
                    wrote += t.length
                    said += t.length
                    yield { text: t }
                  }
                  break
                }
                case 4: {
                  const t = pbStr(uf, 1)
                  if (t) {
                    said += t.length
                    yield { reasoning: t }
                  }
                  break
                }
                case 14: // turn ended, with what it used
                  usage = usageOf(uf)
                  ended = true
                  counted = true
                  if (calls === 0) {
                    yield wrote === 0 ? { error: { status: 502, message: "an empty reply" } } : await settled()
                    return
                  }
                  yield await settled()
                  return
                case 27: // how many tool calls the step makes
                  listed = pbNum(uf, 1)
                  if (stepDone()) {
                    yield await settled()
                    return
                  }
                  break
              }
            }
            break
          case 2: {
            const call = exec(m.data, tools, send, closeExec)
            if (call) {
              said += (call.args ?? "").length
              yield { tool: { index: calls++, ...call } }
            } else if (!fields(m.data).some((e) => e.num === 10)) answered++
            if (stepDone()) {
              yield await settled()
              return
            }
            break
          }
          case 4: {
            const kv = fields(m.data)
            const id = pbNum(kv, 1)
            for (const k of kv) {
              if (k.num === 2) {
                const want = field(fields(k.data), 1)?.data.toString("hex") ?? ""
                const b = blobs.get(want)
                const res = b ? pb().bytes(1, b) : pb().bytes(2, pb().str(1, "blob not found"))
                send(pb().bytes(3, pb().varint(1, id).bytes(2, res)).done())
              } else if (k.num === 3) {
                send(pb().bytes(3, pb().varint(1, id).bytes(3, EMPTY)).done())
              }
            }
            break
          }
        }
      }
    }
  } catch (caught) {
    const e = caught as { message?: string } | null | undefined
    if (calls > 0 && /EOF/.test(e?.message ?? "")) {
      yield await settled()
      return
    }
    yield { error: { status: 502, message: "the reply broke off: " + (e?.message ?? e) } }
  } finally {
    clearTimeout(idleTimer)
  }
}

const NAMESPACES: readonly string[] = [NAMESPACE]
const bareName = (s: string) => {
  for (const ns of NAMESPACES) if (s.startsWith(ns + "-")) return s.slice(ns.length + 1)
  return s
}

export function exec(msg: Buffer, tools: readonly ExecTool[], send: (message: Buffer) => void, closeExec: (id: number) => void): ToolCall | null
export function exec(msg: Buffer, tools: readonly ExecTool[], send: (message: Buffer) => void, closeExec: (id: number) => void, native: true): NativeCall | null
export function exec(msg: Buffer, tools: readonly ExecTool[], send: (message: Buffer) => void, closeExec: (id: number) => void, native = false): ToolCall | NativeCall | null {
  const es = native ? nativeFields(msg) : fields(msg)
  if (native && es.some((e) => e.num === 1 && (e.wire !== 0 || !Number.isInteger(e.n) || e.n < 0 || e.n > 0xffffffff)))
    throw new NativeSessionError(502, "invalid native exec request ID")
  const id = pbNum(es, 1)
  const execID = pbStr(es, 15)
  let nativeCall: (Omit<NativeCall, "args"> & { args: object }) | undefined, nativeUnavailable = false
  if (native) for (const e of es) if (e.num === 11) {
    if (e.wire !== 2) throw new NativeSessionError(502, "invalid native MCP argument envelope")
    const { fields: a, args } = nativeMcpArgs(e.data)
    const name = pbStr(a, 5) || bareName(pbStr(a, 1))
    const provider = pbStr(a, 4)
    const server = pbStr(a, 9)
    if (provider && !NAMESPACES.includes(provider) || server && !NAMESPACES.includes(server)) nativeUnavailable = true
    if (pbNum(a, 7) || field(a, 6)) nativeUnavailable = true
    if (!tools.some((t) => t.name === name)) nativeUnavailable = true
    if (!pbStr(a, 5) && !NAMESPACES.some((ns) => pbStr(a, 1) === ns + "-" + name)) nativeUnavailable = true
    const call = { requestID: id, execID, nativeID: pbStr(a, 3), name, args }
    if (nativeCall && !isDeepStrictEqual(nativeCall, call)) throw new NativeSessionError(502, "ambiguous repeated native MCP argument envelopes")
    nativeCall ??= call
  }
  const answer = (num: number, res: unknown) => {
    send(pb().bytes(2, pb().varint(1, id).str(15, execID).bytes(num, res)).done())
    closeExec(id)
  }
  const unavailable = () => {
    send(pb().bytes(5, pb().bytes(2, pb().varint(1, id).str(2, "not available"))).done())
    closeExec(id)
    return null
  }
  if (nativeUnavailable) return unavailable()
  for (const e of es) {
    switch (e.num) {
      case 11: {
        // mcp_args: a call of the caller's tools
        if (native) return { ...nativeCall!, args: JSON.stringify(nativeCall!.args) }
        const a = fields(e.data)
        const args: Record<string, unknown> = {}
        for (const kv of a) {
          if (kv.num !== 2) continue
          const ef = fields(kv.data)
          const v = field(ef, 2)
          args[pbStr(ef, 1)] = v ? pbAny(v.data) : null
        }
        const name = pbStr(a, 5) || pbStr(a, 1).replace(/^pi-/, "")
        const cid = callerID(pbStr(a, 3)) || "call_" + randomBytes(12).toString("hex")
        if (!tools.some((t) => t.name === name)) {
          send(pb().bytes(5, pb().bytes(2, pb().varint(1, id).str(2, "not available"))).done())
          closeExec(id)
          return null
        }
        return { id: cid, name, args: JSON.stringify(args) }
      }
      case 36: {
        // mcp_state_exec_args: the tools there are
        const srv = pb().str(1, NAMESPACE).str(2, NAMESPACE).str(7, "connected")
        for (const t of tools) srv.bytes(5, toolDef(t))
        answer(36, pb().bytes(1, pb().bytes(1, srv)))
        return null
      }
      case 10: // request_context_args
        answer(10, pb().bytes(1, pb().bytes(1, pb().bytes(4, env()))))
        return null
    }
  }
  // a shell, a file read or an edit of Cursor's own: never run
  return unavailable()
}
