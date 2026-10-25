/**
 * A Run's stream to Cursor: HTTP/2, or HTTP/1.1 until h1Until.
 *
 * Ported from magpie's Cursor provider (MIT):
 * https://github.com/magpie-community/plugins/tree/main/packages/cursor
 *
 * Process state: h1Until, the process-wide HTTP/1.1 deadline. Nothing else writes it.
 * The agent host cache lives in endpoint.ts. This file does not import it.
 */
import { randomUUID } from "node:crypto"
import http2 from "node:http2"
import { Duplex } from "node:stream"
import { frame, pb } from "./codec.ts"
import { API } from "./client.ts"
import { trace } from "./trace.ts"

/** A Run's open stream: write frames to it, read the reply's bytes from it. */
export type RunStream = Duplex & { close(code?: number): void }

/** A Run whose response headers came back. */
export type Opened = {
  error?: undefined
  h2Failed?: undefined
  blocked?: undefined
  session: { close(): void; destroy(): void }
  req: RunStream
  status: number
  headers: Record<string, string>
  /** Set when the Run went over HTTP/1.1 (RunSSE plus BidiAppend). */
  h1?: boolean
}

/** A Run that never got its response headers. h2Failed: HTTP/2 itself failed. blocked: and it will keep failing here. */
export type OpenFailed = {
  error: { status: number; message: string }
  h2Failed: boolean
  blocked?: boolean
  session?: undefined
  req?: undefined
  h1?: undefined
}

/** Opens an HTTP/2 session to an origin. Tests hand in fakes; those Runs stay on HTTP/2. */
export type Connect = (origin: string) => unknown

export type OpenRequest = {
  base: string
  tok: string
  /** The caller's header overrides. null or undefined removes a header. */
  headers?: Record<string, string | null | undefined>
  signal?: AbortSignal
  connect?: Connect
  headerWaitMs?: number
  /** The caller awaits clientVersion before it reads the abort signal this request carries. */
  version: string
}

/** What this file keeps between turns, in a form the doctor may print. */
export type TransportState = {
  transport: { via: "h2" } | { via: "h1"; until: number }
}

type Thrown = { message?: string; code?: unknown; h2Timeout?: boolean } | null | undefined

function defaultConnect(origin: string) {
  return http2.connect(origin)
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
const NET = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EPIPE"]

/** What open gives back for a request that was cancelled before its Run opened. */
export const cancelledOpen = (): OpenFailed => ({ error: { status: 410, message: "the request was cancelled" }, h2Failed: false })

function h2Blocked(e: Thrown): boolean {
  if (e?.h2Timeout) return true
  const code = String(e?.code ?? "")
  const text = `${code} ${e?.message ?? ""}`
  if (NET.some((c) => text.includes(c))) return false
  if (code === "ERR_HTTP2_STREAM_ERROR") return false
  return code.startsWith("ERR_HTTP2") || /h2 is not supported|alpn|nghttp2|protocol error/i.test(text)
}

function connectCode(status: number): string {
  return ({ 400: "invalid_argument", 401: "unauthenticated", 403: "permission_denied", 429: "resource_exhausted" } as Record<number, string>)[status] ?? "unavailable"
}

function cursorHeaders(tok: string, version: string, extra: OpenRequest["headers"]): Record<string, string> {
  const headers: Record<string, string> = {
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

function openH2(base: string, headers: Record<string, string>, signal: AbortSignal | undefined, connect: Connect, headerWaitMs: number): Promise<Opened | OpenFailed> {
  if (signal?.aborted) return Promise.resolve(cancelledOpen())
  return new Promise((resolve) => {
    const u = new URL(base)
    let session: http2.ClientHttp2Session
    try {
      session = connect(u.origin) as http2.ClientHttp2Session
    } catch (caught) {
      const e = caught as Thrown
      resolve({ error: { status: 502, message: e?.message ?? String(e) }, h2Failed: true, blocked: h2Blocked(e) })
      return
    }
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const fail = (e: Error & { code?: unknown; h2Timeout?: boolean }, h2Failed = true) => {
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
      const headersOut: Record<string, string> = {}
      for (const [k, v] of Object.entries(h ?? {})) headersOut[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "")
      resolve({ session, req, status: Number(h[":status"]), headers: headersOut })
    })
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
  })
}

function openH1(headers: Record<string, string>, signal: AbortSignal | undefined): Promise<Opened | OpenFailed> {
  if (signal?.aborted) return Promise.resolve(cancelledOpen())
  const ac = new AbortController()
  const id = headers["x-request-id"]
  const h = { ...headers, "accept-encoding": "identity", "x-cursor-streaming": "true" }
  let ended = false
  let seq = 0
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
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
  const end = (body: string) => {
    if (ended || req.destroyed) return
    ended = true
    const f = frame(Buffer.from(body))
    f[0] = 2
    req.push(f)
    req.push(null)
    cleanup()
  }
  const failed = async (res: Response) => {
    const text = await res.text().catch(() => "")
    let e
    try { e = JSON.parse(text) } catch {}
    end(JSON.stringify({ error: typeof e?.code === "string" ? e : { code: connectCode(res.status), message: text.trim() || `HTTP ${res.status}` } }))
  }
  const append = async (msg: Buffer, n: number) => {
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
    } catch (caught) {
      const e = caught as Thrown
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
      reader = res.body!.getReader()
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
    } catch (caught) {
      const e = caught as Thrown
      if (!ac.signal.aborted) end(JSON.stringify({ error: { code: "unavailable", message: `RunSSE: ${e?.message ?? e}` } }))
    }
  })()
  return Promise.resolve(signal?.aborted ? cancelledOpen() : { session: { close, destroy: close }, req: Object.assign(req, { close }), status: 200, h1: true, headers: {} })
}

export async function open({ base, tok, headers: extra, signal, connect = defaultConnect, headerWaitMs = H2.wait, version }: OpenRequest): Promise<Opened | OpenFailed> {
  const headers = cursorHeaders(tok, version, extra)
  if (signal?.aborted) return cancelledOpen()
  // Injected connect (tests): HTTP/2 only, keep the caller's header wait.
  if (connect !== defaultConnect) {
    const o = await openH2(base, headers, signal, connect, headerWaitMs)
    if (!o.error) trace?.note("transport", { url: base, h1: false })
    return o
  }
  if (Date.now() >= h1Until) {
    const o = await openH2(base, headers, signal, defaultConnect, headerWaitMs)
    if (signal?.aborted) {
      try { o.req?.close?.(http2.constants.NGHTTP2_CANCEL) } catch {}
      try { o.session?.destroy?.() } catch {}
      return cancelledOpen()
    }
    if (!o.h2Failed) {
      trace?.note("transport", { url: base, h1: false })
      return o
    }
    if (o.blocked) h1Until = Date.now() + H2.retryAfter
    trace?.note("transport", { url: API, h1: true, h2: { url: base, error: o.error }, until: o.blocked ? h1Until : undefined })
  } else trace?.note("transport", { url: API, h1: true, until: h1Until })
  if (signal?.aborted) return cancelledOpen()
  return openH1(headers, signal)
}

export function resetH1(): void { h1Until = 0 }

/** The HTTP/2 or sticky HTTP/1.1 choice at now. Reads h1Until. Does not write it. */
export function transportState(now: number): TransportState {
  return { transport: now < h1Until ? { via: "h1", until: h1Until } : { via: "h2" } }
}
