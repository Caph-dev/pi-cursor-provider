/**
 * What a diagnostic may print, and the decision journal that CURSOR_DEBUG turns on.
 * A Decision holds only hosts, reasons scrubbed by reasonOf, statuses, model ids,
 * and clock times. An Account compares fingerprints and prints as "[account]".
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { inspect, isDeepStrictEqual } from "node:util"
import { tokenKey } from "./cache.ts"

/** The host and port of a URL. An endpoint is printed only in this form. */
export type Host = string & { readonly __brand: "Host" }

/** Error or refusal text after reasonOf scrubbed and clipped it. */
export type Reason = string & { readonly __brand: "Reason" }

export function hostOf(url: string): Host {
  try {
    return new URL(url).host as Host
  } catch {
    return "(unparseable URL)" as Host
  }
}

const REASON_MAX = 200

function reasonOf(cause: unknown): Reason {
  const error = cause as { message?: unknown; code?: unknown } | null | undefined
  let text = typeof cause === "string" ? cause : String(error?.message ?? cause ?? "")
  const code = typeof error?.code === "string" ? error.code : ""
  if (code && !text.includes(code)) text += ` (${code})`
  text = text
    .replace(/\bBearer\s+\S+/gi, "Bearer [token]")
    .replace(/\bhttps?:\/\/[^\s"'<>()]*[^\s"'<>().,;:!?]/gi, (url) => hostOf(url))
    .replace(/eyJ[\w-]*\.[\w-]*\.[\w-]*/g, "[token]")
    .replace(/[0-9a-f]{32,}/gi, "[hex]")
    .replace(/[\w-]{40,}/g, "[token]")
    .replace(/\s+/g, " ")
    .trim()
  return (text.length > REASON_MAX ? text.slice(0, REASON_MAX - 1) + "…" : text) as Reason
}

/** One access token as this process knows it. It compares and never prints. */
export class Account {
  #fingerprint: string
  private constructor(fingerprint: string) {
    this.#fingerprint = fingerprint
  }
  static of(token: string): Account {
    return new Account(tokenKey(token))
  }
  /** Whether a store key, or an owner's account, is this account's fingerprint. */
  is(fingerprint: string): boolean {
    return fingerprint === this.#fingerprint
  }
  same(other: Account): boolean {
    return other.#fingerprint === this.#fingerprint
  }
  toString(): string {
    return "[account]"
  }
  toJSON(): string {
    return "[account]"
  }
  [inspect.custom](): string {
    return "[account]"
  }
}

export type Decision =
  | { kind: "endpoint"; source: "server-config"; host: Host }
  | { kind: "endpoint"; source: "global-fallback" | "kept-regional"; host: Host; why: Reason }
  | { kind: "transport"; via: "h2"; host: Host }
  | { kind: "transport"; via: "h1"; host: Host; cause: "sticky"; until: number }
  | { kind: "transport"; via: "h1"; host: Host; cause: "h2-failed"; h2Host: Host; why: Reason; until: number | null }
  | { kind: "native"; path: "resumed" | "created" }
  | { kind: "native"; path: "declined" | "abandoned"; why: Reason }
  | { kind: "owner-ended"; phase: "failed" | "cancelled" | "expired"; model: string; why: Reason }
  | ({ kind: "retry"; rule: "region"; status: number; why: Reason } & ({ retriedOn: Host } | { notRetried: "same-host-over-h2" | "cancelled" }))
  | { kind: "retry"; rule: "max-mode"; status: number; why: Reason; model: string }
  | { kind: "failed"; status: number; why: Reason; bodyCut: boolean }
  | { kind: "usage"; outcome: "refused" | "unavailable"; status: number }
  | { kind: "usage"; outcome: "failed"; why: Reason }

/** A journaled decision. An identical neighbour in the same turn folds into count. */
export type Entry = Decision & { at: number; count: number }

/** One runAnswer call. Turn 0 holds decisions noted outside any turn, with no account. */
export type TurnLog = {
  readonly turn: number
  readonly started: number
  readonly model: string
  readonly account: Account | null
  readonly entries: readonly Entry[]
  /** Decisions refused after the turn kept ENTRIES of them. */
  readonly dropped: number
}

export type Trace = {
  note<K extends Decision["kind"]>(kind: K, raw: RawFact<K>): void
  within<T>(turn: { token: string; model?: string }, run: () => Promise<T>): Promise<T>
  /** Keeps a stream that the turn returns inside its log. Call it inside within(). */
  carry<E>(events: AsyncIterable<E>): AsyncIterable<E>
  /** The last TURNS logs, oldest first, then turn 0 when it holds entries. */
  turns(): readonly TurnLog[]
}

const TURNS = 16
const ENTRIES = 32
const NO_AGENT = "GetServerConfig named no agent host"

type Failure = { status?: number; message?: string } | undefined
type Fields<D> = D extends unknown ? Omit<D, "kind"> : never
type Of<K extends Decision["kind"]> = Fields<Extract<Decision, { kind: K }>>
type RawFact<K extends Decision["kind"]> = Parameters<(typeof parse)[K]>[0]

const statusIn = (error: Failure) => (typeof error?.status === "number" ? error.status : 502)

// The checker does not read the files that note decisions. Each parser picks
// named fields and never spreads its input, so a stray token or header cannot
// reach a log.
const parse = {
  endpoint: (raw: { url: string; listed: boolean; kept: boolean; error?: unknown }): Of<"endpoint"> =>
    raw.listed
      ? { source: "server-config", host: hostOf(raw.url) }
      : { source: raw.kept ? "kept-regional" : "global-fallback", host: hostOf(raw.url), why: reasonOf(raw.error ?? NO_AGENT) },
  transport: (raw: { url: string; h1: boolean; h2?: { url: string; error: unknown }; until?: number }): Of<"transport"> => {
    if (!raw.h1) return { via: "h2", host: hostOf(raw.url) }
    if (!raw.h2) return { via: "h1", host: hostOf(raw.url), cause: "sticky", until: raw.until ?? 0 }
    return { via: "h1", host: hostOf(raw.url), cause: "h2-failed", h2Host: hostOf(raw.h2.url), why: reasonOf(raw.h2.error), until: raw.until ?? null }
  },
  native: (raw: { path: "resumed" | "created" | "declined" | "abandoned"; fallback?: string; detail?: string; error?: unknown }): Of<"native"> => {
    if (raw.path === "resumed" || raw.path === "created") return { path: raw.path }
    if (raw.path === "abandoned") return { path: raw.path, why: reasonOf(raw.error) }
    return { path: raw.path, why: reasonOf(raw.detail ? `${raw.fallback} (${raw.detail})` : raw.fallback) }
  },
  "owner-ended": (raw: { state: "failed" | "cancelled" | "expired"; model?: string; error: unknown }): Of<"owner-ended"> => ({
    phase: raw.state,
    model: String(raw.model ?? ""),
    why: reasonOf(raw.error),
  }),
  retry: (raw: { rule: "region"; error: Failure; to?: string; cancelled: boolean } | { rule: "max-mode"; error: Failure; model: string }): Of<"retry"> => {
    const status = statusIn(raw.error)
    const why = reasonOf(raw.error)
    if (raw.rule === "max-mode") return { rule: "max-mode", status, why, model: String(raw.model ?? "") }
    if (raw.to) return { rule: "region", status, why, retriedOn: hostOf(raw.to) }
    return { rule: "region", status, why, notRetried: raw.cancelled ? "cancelled" : "same-host-over-h2" }
  },
  failed: (raw: { error: Failure & { bodyCut?: boolean } }): Of<"failed"> => ({
    status: statusIn(raw.error),
    why: reasonOf(raw.error),
    bodyCut: raw.error?.bodyCut === true,
  }),
  usage: (raw: { status?: number; refused?: boolean; error?: unknown }): Of<"usage"> =>
    raw.status === undefined ? { outcome: "failed", why: reasonOf(raw.error) } : { outcome: raw.refused ? "refused" : "unavailable", status: raw.status },
} satisfies { [K in Decision["kind"]]: (raw: never) => Of<K> }

type Log = { turn: number; started: number; model: string; account: Account | null; entries: Entry[]; dropped: number }

function sameDecision(entry: Entry, decision: Decision): boolean {
  const { at: _at, count: _count, ...rest } = entry
  return isDeepStrictEqual(rest, decision)
}

function enabled(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase()
  return v !== "" && !["0", "false", "off", "no"].includes(v)
}

function createTrace(): Trace {
  const scope = new AsyncLocalStorage<Log>()
  const logs: Log[] = []
  const outside: Log = { turn: 0, started: Date.now(), model: "", account: null, entries: [], dropped: 0 }
  let next = 1
  return {
    note(kind, raw) {
      if (!Object.hasOwn(parse, kind)) return
      const decision = { kind, ...(parse[kind] as (raw: unknown) => object)(raw) } as Decision
      const log = scope.getStore() ?? outside
      const last = log.entries.at(-1)
      const now = Date.now()
      if (last && sameDecision(last, decision)) {
        last.count += 1
        last.at = now
      } else if (log.entries.length >= ENTRIES) log.dropped += 1
      else log.entries.push({ ...decision, at: now, count: 1 })
    },
    within(turn, run) {
      const log: Log = { turn: next++, started: Date.now(), model: turn.model ?? "", account: Account.of(turn.token), entries: [], dropped: 0 }
      logs.push(log)
      while (logs.length > TURNS) logs.shift()
      return scope.run(log, run)
    },
    // The consumer reads events after runAnswer has returned, and
    // AsyncLocalStorage does not follow a generator into a later next().
    carry<E>(events: AsyncIterable<E>): AsyncIterable<E> {
      const log = scope.getStore()
      if (!log) return events
      const it = events[Symbol.asyncIterator]()
      const carried: AsyncIterableIterator<E> = {
        next: () => scope.run(log, () => it.next()),
        return: (value?: unknown) => scope.run(log, () => it.return?.(value) ?? Promise.resolve({ done: true as const, value: undefined })),
        [Symbol.asyncIterator]: () => carried,
      }
      return carried
    },
    turns() {
      return outside.entries.length ? [...logs, outside] : [...logs]
    },
  }
}

// Declared after everything createTrace reads at module load.
export let trace: Trace | undefined = enabled(process.env.CURSOR_DEBUG) ? createTrace() : undefined

/** Tests: a fresh, empty journal, or none. */
export function traceForTests(on: boolean): void {
  trace = on ? createTrace() : undefined
}
