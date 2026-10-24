/**
 * One Cursor AgentService/Run: open an HTTP/2 stream, read it, then tear it down.
 *
 * Ported from magpie's Cursor provider (MIT):
 * https://github.com/magpie-community/plugins/tree/main/packages/cursor
 * which itself was ported from magpie's Go client (internal/provider/cursor*.go).
 *
 * Not ported: parked HTTP/2 sessions, checkpoint resume, run journals, and the
 * OpenCode chat-completions adapter.
 * The deferred dashboard usage ledger is ported: a tool step without TurnEnded
 * reads GetFilteredUsageEvents, owes late events to the conversation, and
 * reports earlier steps as magpie_deferred so prompt_tokens stay this step's.
 * The stateless path still ends the Run when tools are returned. Pi executes
 * them and the next request carries the results as history.
 * The native path keeps that HTTP/2 (or H1/SSE) Run open. A later turn whose
 * tool results use matching call_cursor_<hex>_<seg>_<i> ids writes those
 * results back to it.
 */
// @ts-nocheck
import { createHash, randomBytes, randomUUID } from "node:crypto"
import http2 from "node:http2"
import { Duplex } from "node:stream"
import { isDeepStrictEqual } from "node:util"
import { EMPTY, failure, field, fields, frame, frames, pb, pbAny, pbNum, pbStr, pbValue, regional } from "./codec.ts"
import { AGENT, API, CALL, GOOS, NAMESPACE, clientVersion, tempDir, unary } from "./client.ts"
import { canRead, ledger, owe, STEP_WAIT, usageKey } from "./ledger.ts"
import { recall, store, tokenKey } from "./cache.ts"
import { request as resolveModel, usable } from "./models.ts"
import { NATIVE_LIMITS, NativeSessionError, nativeFields, nativeMcpArgs, nativeSessions } from "./native-session.ts"
import { hostOf, type Account, type Host } from "./trace.ts"

const NO_RESULT = "Tool use was interrupted and did not produce a result."

function defaultConnect(origin) {
  return http2.connect(origin)
}

const textOf = (c) =>
  typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("") : ""

// joinSplitCalls joins an assistant message onto the assistant message
// before it when that one made tool calls: Anthropic takes consecutive
// assistant messages as one turn, and an agent can send a turn's parallel
// calls split over two of them, answered together after (yetone/magpie#1275).
// Answered at the second message, the first calls would be marked
// interrupted and their real results dropped. msgs is left as it is.
function joinSplitCalls(msgs) {
  const out = []
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

function parseArgs(s) {
  if (s && typeof s === "object") return s
  try {
    const v = JSON.parse(s || "{}")
    return v && typeof v === "object" ? v : {}
  } catch {
    return {}
  }
}

// tools are the caller's tools the model may call.
function toolsOf(chat) {
  return (chat.tools ?? [])
    .filter((t) => t?.type === "function" && t.function?.name)
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
function catalog(tools) {
  if (!tools.length) return ""
  const visible = (value) => String(value ?? "").replaceAll("<", "\\u003c")
  let s = `\n\n<dynamic_tool_catalog>\nThe MCP namespace "pi" has the tools below. They are reached only through \`${CALL}\`, never as tools of their own. Each entry is the exact call to make; its arguments must match the schema given. The schemas are complete, so there is no need to call \`GetDynamicTools\` first.\n`
  for (const t of tools) {
    const name = JSON.stringify(String(t.name ?? "")).replaceAll("<", "\\u003c")
    s += `<call>${CALL}({"namespace":"${NAMESPACE}","toolName":${name},"arguments":{...}})\n${visible(t.description)}\narguments schema: ${visible(t.schemaText)}\n</call>\n`
  }
  return s + "</dynamic_tool_catalog>"
}

// callID is a call's id as Cursor gave it, before the line in it was sent
// to the caller as __.
const callID = (id) => (id.startsWith("call_") ? id.replace("__fc_", "\nfc_") : id)

function result(id, text, isError) {
  let res = text
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

// messages is the conversation as AI SDK messages, in JSON: the system
// prompt with the caller's tools listed, then each turn. A tool result
// answers a call of the reply before it; a call left unanswered is
// answered for, as the API wants every call to have its result. With it,
// the user's last words.
export function conversation(chat, tools) {
  const out = []
  let size = 0
  const add = (m) => out.push(Buffer.from(JSON.stringify(m)))
  const system = []
  let last = "."
  for (const m of chat.messages ?? [])
    if (m.role === "system" || m.role === "developer") system.push(textOf(m.content))
  const sys = system.filter(Boolean).join("\n\n") + catalog(tools)
  size += sys.length
  if (sys) add({ role: "system", content: sys })
  let pending = []
  let results = []
  const answer = () => {
    for (const id of pending) results.push(result(id, NO_RESULT, true))
    pending = []
    if (results.length) add({ role: "tool", content: results })
    results = []
  }
  for (const m of joinSplitCalls(chat.messages ?? [])) {
    if (m.role === "system" || m.role === "developer") continue
    if (m.role === "tool") {
      const id = m.tool_call_id ?? ""
      const i = pending.indexOf(id)
      if (i >= 0) {
        pending.splice(i, 1)
        const text = textOf(m.content)
        size += text.length
        // told Cursor isError (magpie #; Pi sets isError on toolResult)
        results.push(result(id, text, m.is_error === true || m.isError === true))
      }
      continue
    }
    if (m.role === "assistant") {
      answer()
      const content = []
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
    // the user's
    const content = []
    const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? []
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

// ---- the request ---------------------------------------------------------------------

// toolDef is an McpToolDefinition.
function toolDef(t) {
  const d = pb().str(1, t.name)
  if (t.description) d.str(2, t.description)
  d.bytes(3, pbValue(t.schema))
  return d.str(4, NAMESPACE).str(5, t.name).str(6, t.schemaText).done()
}

const env = () => pb().str(1, GOOS).str(2, tempDir()).str(10, "UTC")

function sessionOf(input) {
  return String(input?.sessionID ?? "").trim().slice(0, 128)
}

// uuidOf is a version 4 UUID made of a hash's first 16 bytes.
function uuidOf(b) {
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
export function conversationID(chat, session) {
  const key = String(session ?? "").trim()
  if (!key) return ""
  const msgs = Array.isArray(chat?.messages) ? chat.messages : []
  const first = msgs.find((m) => m?.role === "user") ?? msgs[0]
  // role and content only: a timestamp on the same first message must not move the id
  const stable = first === undefined ? "" : JSON.stringify({ role: first.role, content: first.content })
  const sum = createHash("sha256")
    .update("cursor conversation\0" + key + "\0" + stable)
    .digest()
  return uuidOf(sum)
}

// usageOf is a TurnEndedUpdate as magpie counts usage, as the built-in's
// cursorUsage has it (magpie #498). Its input_tokens is the whole prompt,
// what was read from the cache and written to it included, as Cursor's
// own client has it (it takes both out to get the prompt's uncached
// rest); input is that rest, the cache added back for prompt_tokens. Its
// reasoning_tokens is kept as reasoning.
export function usageOf(uf) {
  const [inp, cr, cw] = [pbNum(uf, 1), pbNum(uf, 3), pbNum(uf, 4)]
  return { input: Math.max(inp - cr - cw, 0), output: pbNum(uf, 2), cacheRead: cr, cacheWrite: cw, reasoning: pbNum(uf, 5) }
}

function buildRun(msgs, lastUser, tools, model, conv = "", { maxMode = false, params = [] } = {}) {
  const blobs = new Map()
  const put = (b) => {
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

// ---- the agent API ---------------------------------------------------------------------

// endpoints are the agent API picked for each token (by its hash). As
// cursor-agent does, it is what ServerConfigService/GetServerConfig names —
// a team may be served in one region only, and the global API turns it
// away — asked once a token, and again when fresh is set; the global one
// while it can't be had.

const endpoints = new Map()
const ENDPOINT_TTL = 10 * 60 * 1000
const ENDPOINT_MISS_TTL = 60_000
export function endpointCacheKeys() {
  return [...endpoints.keys()]
}
export async function agentURL(tok, fresh, signal?: AbortSignal) {
  const key = tokenKey(tok)
  const had = recall(endpoints, key)
  if (!fresh && had) return had.url
  let url = AGENT
  let listed = false
  try {
    const cfg = await unary(API, "aiserver.v1.ServerConfigService/GetServerConfig", tok, {}, 10_000, signal)
    for (const raw of [cfg?.agentUrlConfig?.agentUrl, cfg?.agentUrlConfig?.agentnUrl]) {
      try {
        const u = new URL(raw)
        if ((u.protocol === "https:" || u.protocol === "http:") && u.host) {
          url = raw.replace(/\/+$/, "")
          listed = true
          break
        }
      } catch {}
    }
  } catch (e) {
    if (signal?.aborted) throw e
  }
  if (signal?.aborted) throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" })
  // A refresh that learns nothing must not replace a regional URL with the global one.
  if (!listed && fresh && had?.url) return had.url
  store(endpoints, key, { url, listed, expires: 0 }, listed ? ENDPOINT_TTL : ENDPOINT_MISS_TTL)
  return url
}

export function clearAgentCache() {
  endpoints.clear()
}

// open starts a Run at base: the session, the stream, and the response's
// status, or an error the request never got past. A Run HTTP/2 can't open
// goes over HTTP/1.1 (openH1). When the failure says HTTP/2 itself can't be
// had here (h2Blocked), the Runs after it go straight to HTTP/1.1 for
// H2.retryAfter, or until a region error sends one back (runAnswer); a
// connection that failed (refused, no network) or a stream the server
// refused leaves the next Run to try HTTP/2 again.
//
// Tests may inject `connect`; that path stays HTTP/2-only. Both paths wait
// headerWaitMs for response headers. The default is H2.wait.
let h1Until = 0
const H2 = {
  wait: 15_000,
  retryAfter: 10 * 60_000,
}
const H1 = { appendWait: 60_000 }
// After at least one tool call, a stream that never closes must not pin the turn.
const TOOL_IDLE_MS = 3_000
const NET = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EPIPE"]
const cancelledOpen = () => ({ error: { status: 410, message: "the request was cancelled" }, h2Failed: false })

function h2Blocked(e) {
  if (e?.h2Timeout) return true
  const code = String(e?.code ?? "")
  const text = `${code} ${e?.message ?? ""}`
  if (NET.some((c) => text.includes(c))) return false
  if (code === "ERR_HTTP2_STREAM_ERROR") return false
  return code.startsWith("ERR_HTTP2") || /h2 is not supported|alpn|nghttp2|protocol error/i.test(text)
}

function connectCode(status) {
  return { 400: "invalid_argument", 401: "unauthenticated", 403: "permission_denied", 429: "resource_exhausted" }[status] ?? "unavailable"
}

function openH2(base, headers, signal, connect = defaultConnect, headerWaitMs = H2.wait) {
  if (signal?.aborted) return Promise.resolve(cancelledOpen())
  return new Promise((resolve) => {
    const u = new URL(base)
    let session
    try {
      session = connect(u.origin)
    } catch (e) {
      resolve({ error: { status: 502, message: e?.message ?? String(e) }, h2Failed: true, blocked: h2Blocked(e) })
      return
    }
    let done = false
    let timer
    const fail = (e, h2Failed = true) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      try { session.destroy() } catch {}
      resolve({ error: { status: h2Failed ? 502 : 410, message: e?.message ?? String(e) }, h2Failed, blocked: h2Failed && h2Blocked(e) })
    }
    const abort = () => fail(new Error("the request was cancelled"), false)
    const wait = Number(headerWaitMs)
    timer = setTimeout(
      () => fail(Object.assign(new Error(`no answer over HTTP/2 in ${(Number.isFinite(wait) && wait > 0 ? wait : H2.wait) / 1000}s`), { h2Timeout: true })),
      Number.isFinite(wait) && wait > 0 ? wait : H2.wait,
    )
    const closed = () => fail(Object.assign(new Error("the connection closed"), { code: "ERR_HTTP2_STREAM_ERROR" }))
    session.on("error", fail)
    const req = session.request({
      ":method": "POST",
      ":path": u.pathname.replace(/\/+$/, "") + "/agent.v1.AgentService/Run",
      ...headers,
    })
    req.on("error", fail)
    req.once("close", () => {
      if (!done) fail(Object.assign(new Error(`the HTTP/2 stream closed before its response (code ${req.rstCode ?? "?"})`), { code: "ERR_HTTP2_STREAM_ERROR" }))
    })
    req.once("response", (h) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      const headersOut = {}
      for (const [k, v] of Object.entries(h ?? {})) headersOut[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "")
      resolve({ session, req, status: Number(h[":status"]), headers: headersOut })
    })
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
  })
}

function openH1(headers, signal) {
  if (signal?.aborted) return Promise.resolve(cancelledOpen())
  const ac = new AbortController()
  const id = headers["x-request-id"]
  const h = { ...headers, "accept-encoding": "identity", "x-cursor-streaming": "true" }
  let ended = false
  let seq = 0
  let reader
  const req = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      const msg = Buffer.from(chunk).subarray(5)
      const n = seq++
      append(msg, n).then(() => cb(), (e) => cb(e))
    },
  })
  const cleanup = () => {
    signal?.removeEventListener("abort", close)
    ac.abort()
    reader?.cancel().catch(() => {})
  }
  const end = (body) => {
    if (ended || req.destroyed) return
    ended = true
    const f = frame(Buffer.from(body))
    f[0] = 2
    req.push(f)
    req.push(null)
    cleanup()
  }
  const failed = async (res) => {
    const text = await res.text().catch(() => "")
    let e
    try { e = JSON.parse(text) } catch {}
    end(JSON.stringify({ error: typeof e?.code === "string" ? e : { code: connectCode(res.status), message: text.trim() || `HTTP ${res.status}` } }))
  }
  const append = async (msg, n) => {
    if (ended || ac.signal.aborted) return
    const body = pb().str(1, msg.toString("hex")).bytes(2, pb().str(1, id).done()).varint(3, n).done()
    const ms = H1.appendWait + Math.ceil(body.length / 65536) * 1000
    const deadline = AbortSignal.timeout(ms)
    try {
      const res = await fetch(API + "/aiserver.v1.BidiService/BidiAppend", {
        method: "POST",
        headers: { ...h, "content-type": "application/proto", "connect-protocol-version": "1" },
        body,
        signal: AbortSignal.any([ac.signal, deadline]),
      })
      if (ended || ac.signal.aborted) { await res.body?.cancel().catch(() => {}); return }
      if (!res.ok) return failed(res)
      await res.arrayBuffer()
    } catch (e) {
      if (ac.signal.aborted) return
      if (deadline.aborted) return end(JSON.stringify({ error: { code: "deadline_exceeded", message: `BidiAppend got no answer in ${Math.round(ms / 1000)}s` } }))
      end(JSON.stringify({ error: { code: "unavailable", message: `BidiAppend: ${e?.message ?? e}` } }))
    }
  }
  const close = () => {
    ended = true
    cleanup()
    req.destroy()
  }
  signal?.addEventListener("abort", close, { once: true })
  if (signal?.aborted) {
    close()
    return Promise.resolve(cancelledOpen())
  }
  ;(async () => {
    try {
      const res = await fetch(API + "/agent.v1.AgentService/RunSSE", {
        method: "POST",
        headers: { ...h, "content-type": "application/connect+proto", "connect-protocol-version": "1" },
        body: frame(pb().str(1, id).done()),
        signal: ac.signal,
      })
      if (ended || ac.signal.aborted) { await res.body?.cancel().catch(() => {}); return }
      if (!res.ok) return failed(res)
      reader = res.body.getReader()
      try {
        while (!ended && !req.destroyed) {
          const { value, done } = await reader.read()
          if (done) break
          if (!ended && !req.destroyed) req.push(Buffer.from(value))
        }
      } finally {
        reader.releaseLock()
        reader = undefined
      }
      if (!ended && !req.destroyed) {
        ended = true
        req.push(null)
        cleanup()
      }
    } catch (e) {
      if (!ac.signal.aborted) end(JSON.stringify({ error: { code: "unavailable", message: `RunSSE: ${e?.message ?? e}` } }))
    }
  })()
  return Promise.resolve(signal?.aborted ? cancelledOpen() : { session: { close, destroy: close }, req: Object.assign(req, { close }), status: 200, h1: true, headers: {} })
}

async function open(base, headers, signal, connect = defaultConnect, headerWaitMs = H2.wait) {
  if (signal?.aborted) return cancelledOpen()
  // Injected connect (tests): HTTP/2 only, keep the caller's header wait.
  if (connect !== defaultConnect) {
    return openH2(base, headers, signal, connect, headerWaitMs)
  }
  if (Date.now() >= h1Until) {
    const o = await openH2(base, headers, signal, defaultConnect, headerWaitMs)
    if (signal?.aborted) {
      try { o.req?.close?.(http2.constants.NGHTTP2_CANCEL) } catch {}
      try { o.session?.destroy?.() } catch {}
      return cancelledOpen()
    }
    if (!o.h2Failed) return o
    if (o.blocked) h1Until = Date.now() + H2.retryAfter
  }
  if (signal?.aborted) return cancelledOpen()
  return openH1(headers, signal)
}

export function resetH1() { h1Until = 0 }

/** What run.ts keeps between turns, in a form the doctor may print. */
export type RunState = {
  transport: { via: "h2" } | { via: "h1"; until: number }
  /** This account's agent host. null before a turn asked, after the entry expired, or without an account. */
  agent: { host: Host; source: "server-config" | "global-fallback"; until: number } | null
  /** Live agent hosts cached for other accounts. */
  otherAgents: number
  /** Models Cursor said need max mode. Later turns ask for it. */
  maxModeForced: readonly string[]
}

// Walks endpoints without recall(), which deletes the expired entries this skips.
export function runState(account: Account | undefined, now = Date.now()): RunState {
  let agent = null
  let otherAgents = 0
  for (const [key, entry] of endpoints) {
    if (now >= entry.expires) continue
    if (account?.is(key)) agent = { host: hostOf(entry.url), source: entry.listed ? "server-config" : "global-fallback", until: entry.expires }
    else otherAgents++
  }
  return {
    transport: now < h1Until ? { via: "h1", until: h1Until } : { via: "h2" },
    agent,
    otherAgents,
    maxModeForced: [...maxOnly].sort(),
  }
}

// decode follows the server's messages into the answer's pieces until the
// turn ends, or the model has made its tool calls. stepUsage / owedUsage are
// the deferred dashboard ledger (magpie): a tool step without TurnEnded reads
// usage events; earlier debt leaves as magpie_deferred.
export async function* decode(stream, { send, blobs, tools, estimate = 0, close, stepUsage, owedUsage, toolIdleMs = TOOL_IDLE_MS }) {
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
  let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  let counted = false
  const finish = (more) => {
    if (!counted && !usage.output) usage.output = Math.floor((said + 3) / 4)
    if (!counted && !usage.input && !usage.cacheRead && !usage.cacheWrite) usage.input = estimate
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite
    const deferred = more && more.input + more.output + more.cacheRead + more.cacheWrite > 0
    return {
      stop: calls > 0 ? "tool_calls" : "stop",
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
    // Stateless path: tools are full, so cancel this Run. Their results ride the next request.
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
  const closeExec = (id) => send(pb().bytes(5, pb().bytes(1, pb().varint(1, id))).done())
  async function* asAsync(src) {
    yield* src
  }
  const iter = asAsync(stream)[Symbol.asyncIterator]()
  let idleTimer
  const moreComing = () => calls > 0 && !(listed > 0 && calls + answered >= listed)
  try {
    while (true) {
      const pending = iter.next().then((v) => ({ v }), (e) => ({ e }))
      let got
      if (moreComing()) {
        got = await Promise.race([
          pending,
          new Promise((resolve) => {
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
      if (got.v.done) {
        if (calls > 0) yield await settled()
        else yield { error: { status: 502, message: "the reply broke off: EOF" } }
        return
      }
      const f = got.v.value
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
  } catch (e) {
    if (calls > 0 && /EOF/.test(e?.message ?? "")) {
      yield await settled()
      return
    }
    yield { error: { status: 502, message: "the reply broke off: " + (e?.message ?? e) } }
  } finally {
    clearTimeout(idleTimer)
  }
}

// exec answers what the server asks the client to run: a call of the
// caller's tools is returned, the list of them is given, and anything else
// is refused.
const NAMESPACES = [NAMESPACE]
const bareName = (s) => {
  for (const ns of NAMESPACES) if (s.startsWith(ns + "-")) return s.slice(ns.length + 1)
  return s
}

function exec(msg, tools, send, closeExec, refused, native = false) {
  const es = native ? nativeFields(msg) : fields(msg)
  if (native && es.some((e) => e.num === 1 && (e.wire !== 0 || !Number.isInteger(e.n) || e.n < 0 || e.n > 0xffffffff)))
    throw new NativeSessionError(502, "invalid native exec request ID")
  const id = pbNum(es, 1)
  const execID = pbStr(es, 15)
  let nativeCall, nativeUnavailable = false
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
  const answer = (num, res) => {
    send(pb().bytes(2, pb().varint(1, id).str(15, execID).bytes(num, res)).done())
    closeExec(id)
  }
  const unavailable = () => {
    const kind = es.find((e) => ![1, 15, 19, 55].includes(e.num))?.num ?? 0
    refused?.set(kind, (refused.get(kind) ?? 0) + 1)
    send(pb().bytes(5, pb().bytes(2, pb().varint(1, id).str(2, "not available"))).done())
    closeExec(id)
    return null
  }
  if (nativeUnavailable) return unavailable()
  for (const e of es) {
    switch (e.num) {
      case 11: {
        // mcp_args: a call of the caller's tools
        if (native) return { ...nativeCall, args: JSON.stringify(nativeCall.args) }
        const a = fields(e.data)
        const args = {}
        for (const kv of a) {
          if (kv.num !== 2) continue
          const ef = fields(kv.data)
          const v = field(ef, 2)
          args[pbStr(ef, 1)] = v ? pbAny(v.data) : null
        }
        const name = pbStr(a, 5) || pbStr(a, 1).replace(/^pi-/, "")
        // an OpenAI model's id is its call's and its item's, a line apart,
        // which no caller would take as an id: the line goes as __
        const cid = pbStr(a, 3).replaceAll("\n", "__") || "call_" + randomBytes(12).toString("hex")
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

const maxOnly = new Set()
const maxRequired = (msg) => /max[ _]mode[ _]required|requires max mode/i.test(String(msg ?? ""))

function cursorHeaders(tok, version, extra) {
  const headers = {
    "content-type": "application/connect+proto",
    "connect-protocol-version": "1",
    authorization: `Bearer ${tok}`,
    "x-cursor-client-version": version,
    "x-cursor-client-type": "cli",
    "x-ghost-mode": "true",
    "x-request-id": randomUUID(),
    "x-cursor-agent-allowed-tools": "mcp_tool_call,get_mcp_tools_tool_call",
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    const same = Object.keys(headers).filter((k) => k.toLowerCase() === key.toLowerCase())
    if (value === null || value === undefined) {
      for (const k of same) delete headers[k]
      continue
    }
    if (same.length === 0) headers[key] = String(value)
    else for (const k of same) headers[k] = String(value)
  }
  return headers
}

async function runOnce({ tok, base, id, tools, conv, convID, signal, maxMode, params, connect, onResponse, onPayload, headers, headerWaitMs, toolIdleMs }) {
  const cid = convID || randomUUID()
  const since = Date.now()
  const book = ledger(tok, cid, since, signal, !!convID)
  let modelId = id
  if (onPayload) {
    const replaced = await onPayload({ model: modelId, maxMode: !!maxMode, params, conversationId: cid, tools: tools.map((t) => t.name) })
    if (replaced && typeof replaced === "object" && !Buffer.isBuffer(replaced) && typeof replaced.model === "string" && replaced.model) {
      modelId = replaced.model
    }
  }
  const { first, blobs } = buildRun(conv.msgs, conv.last, tools, modelId, cid, { maxMode, params })
  const o = await open(base, cursorHeaders(tok, await clientVersion(), headers), signal, connect, headerWaitMs)
  if (o.error) return book.done(), { ...o, h1: !!o.h1 }
  if (onResponse) await onResponse({ status: o.status, headers: o.headers ?? {} })
  const { session, req } = o
  let closed = false
  const send = (msg) => {
    if (!closed && !req.destroyed && req.writable) req.write(frame(msg))
  }
  const heartbeat = setInterval(() => send(pb().bytes(7, EMPTY).done()), 5000)
  heartbeat.unref?.()
  const close = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    try {
      req.close(http2.constants.NGHTTP2_CANCEL)
    } catch {}
    try {
      session.close()
    } catch {}
    setTimeout(() => {
      try {
        session.destroy()
      } catch {}
    }, 1000).unref?.()
  }
  signal?.addEventListener("abort", close, { once: true })
  if (signal?.aborted) {
    close()
    book.done()
    return cancelledOpen()
  }
  send(first)
  if (o.status < 200 || o.status > 299) {
    const chunks = []
    try {
      for await (const c of req) chunks.push(c)
    } catch {}
    close()
    book.done()
    return { error: failure(o.status, Buffer.concat(chunks).toString("utf8").slice(0, 1 << 20)), h1: !!o.h1 }
  }
  const it = decode(frames(req), {
    send,
    blobs,
    tools,
    estimate: conv.estimate,
    close,
    stepUsage: book.own,
    owedUsage: book.owed,
    toolIdleMs,
  })
  const wrapped = (async function* () {
    try {
      yield* it
    } finally {
      close()
      book.done()
    }
  })()
  const head = await wrapped.next()
  if (head.done) return book.done(), { error: { status: 502, message: "an empty reply" }, h1: !!o.h1 }
  if (head.value?.error) {
    await wrapped.return?.()
    return { error: head.value.error, h1: !!o.h1 }
  }
  return {
    conversationId: cid,
    h1: !!o.h1,
    events: (async function* () {
      yield head.value
      yield* wrapped
    })(),
  }
}

// withDelivery marks the sealed segment clean once the caller has its stop
// event. The next turn can then resume. Until then prepare reports the owner busy.
function withDelivery(owner, events) {
  const it = events[Symbol.asyncIterator]()
  return {
    async next() {
      const r = await it.next()
      if (r.value?.stop) owner.delivered()
      return r
    },
    return: () => it.return?.(),
    [Symbol.asyncIterator]() { return this },
  }
}

// nativeTransport queues writes on one open Run. Heartbeats and exec answers
// never wait. A KV reply waits until the queue has room.
function nativeTransport(req, close, fail, limits = NATIVE_LIMITS) {
  const outbound = { bytes: 0, messages: 0 }
  const queue = []
  let closed = false, flushing = false, rejectWrite
  const waiters = new Set()
  const spare = (n) => Math.floor(n / 8)
  const fits = (size) => outbound.messages === 0 || (outbound.messages + 1 + spare(limits.outboundMessages) <= limits.outboundMessages
    && outbound.bytes + size + spare(limits.outboundBytes) <= limits.outboundBytes)
  const wake = () => {
    for (const w of waiters) if (closed || fits(w.size)) w.done()
  }
  const flush = async () => {
    if (closed || flushing) return
    flushing = true
    try {
      while (!closed && queue.length) {
        const packet = queue.shift()
        await new Promise((resolve, reject) => {
          let written = false, drained = false, started = false, settled = false
          const finish = (error) => {
            if (settled) return
            settled = true
            rejectWrite = undefined
            req.removeListener("drain", drain)
            req.removeListener("error", failed)
            req.removeListener("close", lost)
            error ? reject(error) : resolve()
          }
          const check = () => { if (started && written && drained) finish() }
          const drain = () => { drained = true; check() }
          const failed = (e) => finish(e)
          const lost = () => finish(new NativeSessionError(502, "native transport closed during a write; its outcome is uncertain"))
          rejectWrite = finish
          req.once("drain", drain)
          req.once("error", failed)
          req.once("close", lost)
          try {
            drained = req.write(packet, (e) => {
              if (e) return finish(e)
              written = true
              check()
            }) || drained
            started = true
            if (drained) req.removeListener("drain", drain)
            check()
          } catch (e) { finish(e) }
        })
        if (!closed) { outbound.bytes -= packet.length; outbound.messages--; wake() }
      }
    } catch (e) {
      if (!closed) fail(e)
    } finally { flushing = false }
  }
  return {
    outbound,
    send(message) {
      if (closed || req.destroyed || !req.writable) throw new NativeSessionError(502, "native transport is no longer writable")
      const size = message.length + 5
      if (outbound.bytes + size > limits.outboundBytes) throw new NativeSessionError(503, "native outbound bytes limit reached")
      if (outbound.messages + 1 > limits.outboundMessages) throw new NativeSessionError(503, "native outbound messages limit reached")
      outbound.bytes += size
      outbound.messages++
      queue.push(frame(message))
      void flush()
    },
    room(size) {
      if (closed || fits(size)) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const w = {
          size,
          done() {
            waiters.delete(w)
            clearTimeout(w.timer)
            resolve()
          },
        }
        w.timer = setTimeout(() => {
          waiters.delete(w)
          const which = outbound.bytes + size + spare(limits.outboundBytes) > limits.outboundBytes ? "bytes" : "messages"
          reject(new NativeSessionError(503, `native outbound ${which} limit reached: the queue did not drain for ${Math.round(limits.writeWait / 1000)}s`))
        }, limits.writeWait)
        w.timer.unref?.()
        waiters.add(w)
      })
    },
    close() {
      if (closed) return
      closed = true
      queue.length = 0
      outbound.bytes = 0
      outbound.messages = 0
      wake()
      rejectWrite?.(new NativeSessionError(410, "native transport was cancelled"))
      close()
    },
  }
}

// runNative keeps the Run open across tool batches. Accounting uses the
// deferred dashboard ledger: settle collects earlier debt as magpie_deferred;
// an abandoned pending Run is owed once to the same conversation.
async function runNative({ tok, base, id, tools, conv, convID, signal, maxMode, params, native, connect, onResponse, onPayload, headers, headerWaitMs }) {
  const cid = convID || randomUUID()
  const since = Date.now()
  const accounting = new AbortController()
  const book = ledger(tok, cid, since, accounting.signal, !!convID, { before: since })
  const debtKey = usageKey(tok, cid)
  let started = false, settled = false, deferred = null
  native.accounting = {
    started() { started = true },
    async settle() {
      const more = await book.owed(true)
      if (settled) {
        if (more) owe(debtKey, { carry: more })
        return null
      }
      deferred = more
      return more
    },
    delivered() {
      if (settled) return
      settled = true
      deferred = null
      book.done()
      accounting.abort()
    },
    abandon() {
      if (settled) return
      settled = true
      book.done()
      accounting.abort()
      if (deferred) owe(debtKey, { carry: deferred })
      deferred = null
      if (started && native.segments > 0 && !native.finalUsage && convID && canRead(tok)) {
        owe(debtKey, { since, n: 1, ready: Date.now() + STEP_WAIT.owedAt })
      }
    },
  }
  let modelId = id
  if (onPayload) {
    const replaced = await onPayload({ model: modelId, maxMode: !!maxMode, params, conversationId: cid, tools: tools.map((t) => t.name) })
    if (replaced && typeof replaced === "object" && !Buffer.isBuffer(replaced) && typeof replaced.model === "string" && replaced.model) {
      modelId = replaced.model
    }
  }
  const { first, blobs } = buildRun(conv.msgs, conv.last, tools, modelId, cid, { maxMode, params })
  native.chatTools = tools
  native.attach(signal)
  if (native.error) {
    nativeSessions.forget(native)
    return { error: native.error }
  }
  const o = await open(base, cursorHeaders(tok, await clientVersion(), headers), native.ac.signal, connect, headerWaitMs)
  if (o.error) {
    native.fail(o.error)
    nativeSessions.forget(native)
    return { ...o, h1: !!o.h1 }
  }
  if (onResponse) await onResponse({ status: o.status, headers: o.headers ?? {} })
  const { session, req } = o
  const close = () => {
    try { req.close(http2.constants.NGHTTP2_CANCEL) } catch {}
    try { session.close() } catch {}
    try { session.destroy() } catch {}
  }
  const transport = nativeTransport(req, close, (e) => native.fail({ status: e.status ?? 502, message: e.message }), native.limits)
  try {
    native.bind(transport, blobs, conv.estimate)
    if (native.error) {
      nativeSessions.forget(native)
      return { error: native.error, h1: !!o.h1 }
    }
    native.send(first)
    native.accounting.started()
    if (o.status < 200 || o.status > 299) {
      const chunks = []
      for await (const c of req) chunks.push(c)
      native.fail(failure(o.status, Buffer.concat(chunks).toString("utf8").slice(0, 1 << 20)))
      nativeSessions.forget(native)
      return { error: native.error, h1: !!o.h1 }
    }
    native.pumpTask = (async () => {
      await native.pump(frames(req))
    })()
    const response = native.response()
    const it = response.events
    const head = await it.next()
    if (head.done || head.value.error) {
      const error = head.value?.error ?? { status: 502, message: "an empty reply" }
      await native.cancel(error.message)
      nativeSessions.forget(native)
      return { error, h1: !!o.h1 }
    }
    let firstEvent = head
    const events = {
      next() {
        if (firstEvent) {
          const r = firstEvent
          firstEvent = null
          if (r.value?.stop) native.delivered()
          return Promise.resolve(r)
        }
        return it.next().then((r) => {
          if (r.value?.stop) native.delivered()
          return r
        })
      },
      return: () => it.return(),
      [Symbol.asyncIterator]() { return this },
    }
    return { conversationId: cid, events, h1: !!o.h1 }
  } catch (e) {
    native.fail({ status: e.status ?? 502, message: e.message })
    await native.pumpTask
    nativeSessions.forget(native)
    return { error: native.error, h1: !!o.h1 }
  }
}

export function clearMaxOnly() {
  maxOnly.clear()
}

export { nativeSessions } from "./native-session.ts"
export { STEP_WAIT, ledger, owed, misses, unreadable, clearLedger, usageKey } from "./ledger.ts"

/** One user-visible turn. A regional miss retries once, and only when the agent URL changed. */
export async function runAnswer({
  tok,
  model,
  effort = "",
  fast,
  messages,
  tools = [],
  session = "",
  signal,
  connect,
  resolveAgentURL = agentURL,
  rawModels,
  onResponse,
  onPayload,
  headers,
  headerWaitMs = H2.wait,
  toolIdleMs = TOOL_IDLE_MS,
}: {
  tok: string
  model?: string
  effort?: string
  fast?: boolean
  messages?: unknown[]
  tools?: { name: string; description?: string; schema?: unknown }[]
  session?: string
  signal?: AbortSignal
  connect?: (origin: string) => unknown
  resolveAgentURL?: (tok: string, fresh: boolean, signal?: AbortSignal) => Promise<string> | string
  rawModels?: unknown
  onResponse?: (response: { status: number; headers: Record<string, string> }) => unknown
  onPayload?: (payload: unknown) => unknown
  headers?: Record<string, string | null | undefined>
  headerWaitMs?: number
  toolIdleMs?: number
}): Promise<{
  error?: { status?: number; message?: string }
  conversationId?: string
  events?: AsyncIterable<{
    text?: string
    reasoning?: string
    tool?: { id: string; name: string; args: string }
    stop?: string
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
      completion_tokens_details?: { reasoning_tokens?: number }
    }
    error?: { status?: number; message?: string }
  }>
}> {
  const chat = {
    model,
    messages,
    reasoning_effort: effort,
    ...(fast === true ? { service_tier: "fast" } : fast === false ? { service_tier: "default" } : {}),
    tools: tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.schema ?? { type: "object", properties: {} },
      },
    })),
  }
  const listed = toolsOf(chat)
  const convID = conversationID(chat, sessionOf({ sessionID: session }))
  const prepared = nativeSessions.prepare(tok, chat, convID, listed)
  if (prepared.owner) {
    try {
      const conv = conversation(chat, listed)
      const resumed = prepared.owner.resume({ ...prepared, estimate: conv.estimate }, signal)
      return { conversationId: convID, events: withDelivery(prepared.owner, resumed.events) }
    } catch (e) {
      return { error: { status: e?.status ?? 502, message: e?.message ?? String(e) } }
    }
  }
  let raw = rawModels
  if (raw === undefined) {
    try {
      raw = await usable(tok, false, signal)
    } catch {
      raw = []
    }
  }
  const resolved = resolveModel(raw, String(model ?? ""), effort, fast)
  let id = resolved.id
  let params = resolved.params
  let maxMode = resolved.maxMode || maxOnly.has(id)
  const conv = conversation(chat, listed)
  let base = await resolveAgentURL(tok, false, signal)
  const once = async () => {
    const native = prepared.fallback ? null : nativeSessions.create(prepared, { id, maxMode, params }, { pb, exec, usageOf, failure })
    const args = { tok, base, id, tools: listed, conv, convID, signal, maxMode, params, connect, onResponse, onPayload, headers, headerWaitMs, toolIdleMs }
    let response = native ? await runNative({ ...args, native }) : await runOnce(args)
    if (response.error?.retentionIneligible && !signal?.aborted) response = await runOnce(args)
    return response
  }
  let ran = await once()
  if (signal?.aborted) return ran
  if (ran.error && regional(ran.error.message)) {
    resetH1()
    const fresh = await resolveAgentURL(tok, true, signal)
    const viaH1 = !!ran.h1
    if ((fresh !== base || viaH1) && !signal?.aborted) {
      base = fresh
      ran = await once()
    }
  }
  if (signal?.aborted) return ran
  if (ran.error && !maxMode && maxRequired(ran.error.message)) {
    maxMode = true
    maxOnly.add(id)
    ran = await once()
  }
  return ran
}
