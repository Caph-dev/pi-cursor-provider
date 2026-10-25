/**
 * Ported from magpie's Cursor provider (MIT):
 * https://github.com/magpie-community/plugins/tree/main/packages/cursor
 */
import { randomUUID } from "node:crypto"
import http2 from "node:http2"
import { EMPTY, failure, frame, frames, pb } from "./codec.ts"
import { clientVersion } from "./client.ts"
import { canRead, ledger, owe, STEP_WAIT, usageKey } from "./ledger.ts"
import { NATIVE_LIMITS, NativeSessionError, nativeSessions } from "./native-session.ts"
import { buildRun, decode, exec, usageOf, type BlobStore, type ChatTool, type Conversation, type Frame, type ModelParam, type Payload, type RunError, type RunEvent } from "./protocol.ts"
import { cancelledOpen, open, type Connect, type RunStream } from "./transport.ts"
import { trace } from "./trace.ts"

export type RunArgs = {
  tok: string
  base: string
  id: string
  maxMode: boolean
  params: readonly ModelParam[]
  tools: readonly ChatTool[]
  conv: Conversation
  /** "" without a session: the Run gets an id of its own. */
  convID: string
  signal?: AbortSignal
  connect?: Connect
  onResponse?: (response: { status: number; headers: Record<string, string> }) => unknown
  onPayload?: (payload: Payload) => unknown
  headers?: Record<string, string | null | undefined>
  headerWaitMs?: number
  toolIdleMs?: number
}

/** A Run's events, or the error it ended on. h1: the Run went over HTTP/1.1. */
export type RunResult =
  | { error: RunError & { bodyCut?: boolean; retentionIneligible?: boolean }; h1?: boolean; conversationId?: undefined; events?: undefined }
  | { error?: undefined; conversationId: string; h1?: boolean; events: AsyncIterable<RunEvent> }

export type Prepared = { owner: NativeOwner } | { owner?: undefined; fallback?: string }

type Thrown = { status?: number; message?: string }

type SegmentEvents = {
  next(): Promise<IteratorResult<RunEvent>>
  return(): Promise<IteratorResult<RunEvent>>
  [Symbol.asyncIterator](): SegmentEvents
}

type NativeTransport = {
  outbound: { bytes: number; messages: number }
  send(message: Buffer): void
  room(size: number): Promise<void>
  close(): void
}

type NativeAccounting = {
  started(): void
  settle(): Promise<unknown>
  delivered(): void
  abandon(): void
}

type NativeOwner = {
  accounting?: NativeAccounting
  chatTools?: readonly ChatTool[]
  pumpTask?: Promise<void>
  readonly error?: RunError & { retentionIneligible?: boolean }
  readonly ac: AbortController
  readonly limits: typeof NATIVE_LIMITS
  readonly segments: number
  readonly finalUsage?: unknown
  attach(signal?: AbortSignal): void
  fail(error: { status: number; message?: string }): void
  bind(transport: NativeTransport, blobs: BlobStore, estimate: number): void
  send(message: Buffer): void
  pump(stream: AsyncIterable<Frame>): Promise<void>
  response(): { events: SegmentEvents }
  resume(prepared: object, signal?: AbortSignal): { events: SegmentEvents }
  cancel(message: string): Promise<void>
  delivered(): void
}

export async function startRun(prepared: Prepared, args: RunArgs): Promise<RunResult> {
  const { id, maxMode, params, signal } = args
  const made = nativeSessions.create(prepared, { id, maxMode, params }, { pb, exec, usageOf, failure, trace })
  const native: NativeOwner | null = made.fallback ? null : made
  trace?.note("native", native ? { path: "created" } : { path: "declined", fallback: made.fallback, detail: made.detail })
  let response = native ? await runNative({ ...args, native }) : await runOnce(args)
  if (response.error?.retentionIneligible && !signal?.aborted) {
    trace?.note("native", { path: "abandoned", error: response.error })
    response = await runOnce(args)
  }
  return response
}

/** Writes the caller's tool results to the native Run that asked for them. Throws when the owner refuses them. */
export function resumeRun(prepared: { owner: NativeOwner }, estimate: number, signal?: AbortSignal): AsyncIterable<RunEvent> {
  const resumed = prepared.owner.resume({ ...prepared, estimate }, signal)
  trace?.note("native", { path: "resumed" })
  return withDelivery(prepared.owner, resumed.events)
}

async function runOnce({ tok, base, id, tools, conv, convID, signal, maxMode, params, connect, onResponse, onPayload, headers, headerWaitMs, toolIdleMs }: RunArgs): Promise<RunResult> {
  const cid = convID || randomUUID()
  const since = Date.now()
  const book = ledger(tok, cid, since, signal, !!convID)
  let modelId = id
  if (onPayload) {
    const replaced = await onPayload({ model: modelId, maxMode: !!maxMode, params, conversationId: cid, tools: tools.map((t) => t.name) })
    if (replaced && typeof replaced === "object" && !Buffer.isBuffer(replaced) && "model" in replaced && typeof replaced.model === "string" && replaced.model) {
      modelId = replaced.model
    }
  }
  const { first, blobs } = buildRun(conv.msgs, conv.last, tools, modelId, cid, { maxMode, params })
  const version = await clientVersion()
  const o = await open({ base, tok, headers, version, signal, connect, headerWaitMs })
  if (o.error) return book.done(), { ...o, h1: !!o.h1 }
  if (onResponse) await onResponse({ status: o.status, headers: o.headers ?? {} })
  const { session, req } = o
  let closed = false
  const send = (msg: Buffer) => {
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
    const chunks: Buffer[] = []
    let bodyCut = false
    try {
      for await (const c of req) chunks.push(c)
    } catch {
      bodyCut = true
    }
    close()
    book.done()
    const error = failure(o.status, Buffer.concat(chunks).toString("utf8").slice(0, 1 << 20))
    return { error: bodyCut ? { ...error, bodyCut } : error, h1: !!o.h1 }
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

function withDelivery(owner: { delivered(): void }, events: SegmentEvents): AsyncIterableIterator<RunEvent> {
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

function nativeTransport(req: RunStream, close: () => void, fail: (e: unknown) => void, limits = NATIVE_LIMITS): NativeTransport {
  const outbound = { bytes: 0, messages: 0 }
  const queue: Buffer[] = []
  let closed = false, flushing = false, rejectWrite: ((error: unknown) => void) | undefined
  type Waiter = { size: number; done(): void; timer?: ReturnType<typeof setTimeout> }
  const waiters = new Set<Waiter>()
  const spare = (n: number) => Math.floor(n / 8)
  const fits = (size: number) => outbound.messages === 0 || (outbound.messages + 1 + spare(limits.outboundMessages) <= limits.outboundMessages
    && outbound.bytes + size + spare(limits.outboundBytes) <= limits.outboundBytes)
  const wake = () => {
    for (const w of waiters) if (closed || fits(w.size)) w.done()
  }
  const flush = async () => {
    if (closed || flushing) return
    flushing = true
    try {
      while (!closed && queue.length) {
        const packet = queue.shift()!
        await new Promise<void>((resolve, reject) => {
          let written = false, drained = false, started = false, settled = false
          const finish = (error?: unknown) => {
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
          const failed = (e: unknown) => finish(e)
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
        const w: Waiter = {
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

async function runNative({ tok, base, id, tools, conv, convID, signal, maxMode, params, native, connect, onResponse, onPayload, headers, headerWaitMs }: RunArgs & { native: NativeOwner }): Promise<RunResult> {
  const cid = convID || randomUUID()
  const since = Date.now()
  const accounting = new AbortController()
  const book = ledger(tok, cid, since, accounting.signal, !!convID, { before: since })
  const debtKey = usageKey(tok, cid)
  let started = false, settled = false
  let deferred: Awaited<ReturnType<typeof book.owed>> = null
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
    if (replaced && typeof replaced === "object" && !Buffer.isBuffer(replaced) && "model" in replaced && typeof replaced.model === "string" && replaced.model) {
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
  const version = await clientVersion()
  const o = await open({ base, tok, headers, version, signal: native.ac.signal, connect, headerWaitMs })
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
  const transport = nativeTransport(req, close, (caught) => {
    const e = caught as Thrown
    native.fail({ status: e.status ?? 502, message: e.message })
  }, native.limits)
  try {
    native.bind(transport, blobs, conv.estimate)
    if (native.error) {
      nativeSessions.forget(native)
      return { error: native.error, h1: !!o.h1 }
    }
    native.send(first)
    native.accounting.started()
    if (o.status < 200 || o.status > 299) {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c)
      native.fail(failure(o.status, Buffer.concat(chunks).toString("utf8").slice(0, 1 << 20)))
      nativeSessions.forget(native)
      return { error: native.error!, h1: !!o.h1 }
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
    let firstEvent: IteratorResult<RunEvent> | null = head
    const events: AsyncIterableIterator<RunEvent> = {
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
  } catch (caught) {
    const e = caught as Thrown
    native.fail({ status: e.status ?? 502, message: e.message })
    await native.pumpTask
    nativeSessions.forget(native)
    return { error: native.error!, h1: !!o.h1 }
  }
}
