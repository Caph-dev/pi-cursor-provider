/**
 * Deferred dashboard usage ledger for AgentService/Run steps.
 *
 * Ported from magpie's Cursor provider (MIT):
 * https://github.com/magpie-community/plugins/tree/main/packages/cursor
 *
 * A tool step has no TurnEndedUpdate. Usage is read from the dashboard's
 * GetFilteredUsageEvents by conversation_id. Far from Cursor the event is
 * late: the step says 0 and the conversation owes it; later steps collect
 * it as magpie_deferred so prompt_tokens stay the step's own context size.
 */
// @ts-nocheck
import { createHash } from "node:crypto"
import { API, headersFor } from "./client.ts"

// STEP_WAIT is how long a step's event is looked for: first after that long,
// then every so often until the end (each ask given `ask` to answer).
// Far from Cursor none shows in that time (yetone/magpie#1053), and waiting
// longer would hold every tool step longer. So a tool step's Run is owed by
// its conversation: next steps collect it in the background from `owedAt`.
// After `skipAfter` misses in a row, steps stop waiting (but every
// `retryEvery`th). A debt not collected in `owedFor` is let go.
export const STEP_WAIT = {
  first: 1500,
  every: 500,
  until: 6000,
  ask: 5000,
  skipAfter: 3,
  retryEvery: 10,
  owedAt: 5000,
  owedFor: 600_000,
}

// claimed are the usage events already counted, by account, conversation
// and time, so that two steps of one conversation never count the same one.
const claimed = new Map()

// owed are what each account's conversation still owes, by credential
// fingerprint and conversation_id: n Runs whose events are to be counted,
// the earliest started at since, looked for from ready on; and carry, a
// count collected that no step gave out.
export const owed = new Map()

// flights are each account's conversation collections still going, which
// a step that ends the turn waits for.
export const flights = new Map()

// unreadable are the accounts (by token) whose usage events Cursor won't
// give (a 4xx), for owedFor: their steps are guessed, as before, and owe
// nothing. misses are how many steps in a row of an account's left
// something owed.
export const unreadable = new Map()
export const misses = new Map()

const tokKey = (tok) => createHash("sha256").update(tok).digest("hex")
export const usageKey = (tok, conv) => tokKey(tok) + "\0" + conv

export function canRead(tok) {
  const at = unreadable.get(tokKey(tok))
  if (at === undefined) return true
  if (Date.now() - at < STEP_WAIT.owedFor) return false
  unreadable.delete(tokKey(tok))
  return true
}

const ZERO = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
function addUsage(a, b) {
  if (!b) return a
  if (!a) return { ...b }
  for (const k of Object.keys(a)) a[k] += b[k] ?? 0
  return a
}

// owe adds to the account/conversation's debt. A native Run bounds older
// event timestamps before its start: its authoritative final must never be
// collected as an earlier Run. Keep that bound when a later stateless Run
// adds unbounded debt. Ordinary stateless debt retains its original shape.
const DEBT_GROUP_LIMIT = 64
export function owe(key, { since = Date.now(), n = 0, ready = Date.now(), carry = null, before } = {}) {
  for (const [k, d] of owed) {
    if (d.groups) {
      d.groups = d.groups.filter((g) => Date.now() - g.since <= STEP_WAIT.owedFor)
      d.n = d.groups.reduce((sum, g) => sum + g.n, 0)
      if (Date.now() - d.since > STEP_WAIT.owedFor) d.carry = null
      if (!d.n && !d.carry) owed.delete(k)
      else if (d.groups.length) d.since = Math.min(...d.groups.map((g) => g.since))
    } else if (Date.now() - d.since > STEP_WAIT.owedFor) owed.delete(k)
  }
  if (n <= 0 && !carry) return
  const d = owed.get(key)
  if (!d) return void owed.set(key, { since, n, ready, carry: carry && { ...carry }, ...(before !== undefined ? { before } : {}) })
  if (n > 0 && (d.groups || d.before !== undefined || before !== undefined)) {
    const groups = d.groups ?? (d.n > 0 ? [{ since: d.since, n: d.n, ready: d.ready, before: d.before }] : [])
    const same = groups.find((g) => g.before === before)
    if (same) {
      same.since = Math.min(same.since, since)
      same.n += n
      same.ready = Math.min(same.ready, ready)
    } else groups.push({ since, n, ready, before })
    // As with expired dashboard debt, overflow stays unknown, never estimated
    // or merged across bounds into an authoritative native Run's event.
    groups.sort((a, b) => a.since - b.since)
    d.groups = groups.slice(-DEBT_GROUP_LIMIT)
    delete d.before
    d.n = d.groups.reduce((sum, g) => sum + g.n, 0)
    d.since = Math.min(...d.groups.map((g) => g.since))
  } else {
    d.since = Math.min(d.since, since)
    d.n += n
  }
  d.ready = Math.min(d.ready, ready)
  d.carry = addUsage(d.carry, carry)
}

// usageEvents are the dashboard's events of conversation conv from since
// on, the `want` oldest not counted yet, summed.
export async function usageEvents(tok, conv, since, want, { poll = false, first = STEP_WAIT.first, signal, before = () => Infinity, groups, abortFetch = false } = {}) {
  const key = usageKey(tok, conv)
  const end = Date.now() + STEP_WAIT.until
  const wait = (ms) => new Promise((r) => {
    const t = setTimeout(r, ms)
    signal?.addEventListener("abort", () => (clearTimeout(t), r()), { once: true })
  })
  for (const [k, at] of claimed) if (Date.now() - at > 2 * STEP_WAIT.owedFor) claimed.delete(k)
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  let usage = null
  let got = 0
  const events = []
  const counts = groups?.map(() => 0)
  if (poll) await wait(first)
  while (!signal?.aborted) {
    try {
      const res = await fetch(API + "/aiserver.v1.DashboardService/GetFilteredUsageEvents", {
        method: "POST",
        headers: await headersFor(tok),
        body: JSON.stringify({ teamId: 0, startDate: String(since - 60_000), endDate: String(Date.now() + 60_000), page: 1, pageSize: 50 }),
        signal: abortFetch && signal ? AbortSignal.any([signal, AbortSignal.timeout(STEP_WAIT.ask)]) : AbortSignal.timeout(STEP_WAIT.ask),
      })
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        unreadable.set(tokKey(tok), Date.now())
        return { usage, events, got, counts, refused: true }
      }
      const evs = res.ok ? ((await res.json())?.usageEventsDisplay ?? []) : []
      const found = evs
        .filter((e) => e?.conversationId === conv && e.tokenUsage && num(e.timestamp) >= since - 1000 && !claimed.has(key + "\0" + e.timestamp))
        .sort((a, b) => num(a.timestamp) - num(b.timestamp))
      for (const ev of found) {
        if (got >= want) break
        const at = num(ev.timestamp)
        if (at >= before()) continue
        const group = groups?.findIndex((g, i) => counts[i] < g.n && at >= g.since - 1000 && at < (g.before ?? Infinity))
        if (groups && group === -1) continue
        if (groups) counts[group]++
        claimed.set(key + "\0" + ev.timestamp, Date.now())
        const t = ev.tokenUsage
        const u = { input: num(t.inputTokens), output: num(t.outputTokens), cacheRead: num(t.cacheReadTokens), cacheWrite: num(t.cacheWriteTokens), reasoning: 0 }
        usage = addUsage(usage ?? ZERO(), u)
        events.push({ at: num(ev.timestamp), usage: u })
        got++
      }
      if (got >= want) break
    } catch {}
    if (!poll || Date.now() + STEP_WAIT.every > end) break
    await wait(STEP_WAIT.every)
  }
  return { usage, events, got, counts, refused: false }
}

/** The usage of one Run as the dashboard counts it; null when none shows in time. */
export async function stepUsage(tok, conv, since, signal) {
  return (await usageEvents(tok, conv, since, 1, { poll: true, signal })).usage
}

function collect(tok, conv, { poll = false, first, signal, over = () => false, abortFetch = false } = {}) {
  const key = usageKey(tok, conv)
  const d = owed.get(key)
  if (!d) return Promise.resolve({ usage: null, carry: null, events: [], short: false })
  owed.delete(key)
  const p = (async () => {
    const groups = (d.groups ?? [d]).filter((g) => (g.before === undefined && !d.groups) || Date.now() - g.since <= STEP_WAIT.owedFor)
    const want = groups.reduce((sum, g) => sum + g.n, 0)
    let r = { usage: null, events: [], got: 0 }
    if (want > 0 && canRead(tok)) r = await usageEvents(tok, conv, Math.min(...groups.map((g) => g.since)), want, {
      poll, first, signal, abortFetch, before: () => d.before ?? Infinity, ...(d.groups ? { groups } : {}),
    }).catch(() => r)
    let short = false
    for (const [i, g] of groups.entries()) {
      const remaining = g.n - (d.groups ? r.counts?.[i] ?? 0 : r.got)
      if (remaining > 0 && canRead(tok)) {
        short = true
        owe(key, { since: g.since, n: remaining, ready: g.ready, before: g.before })
      }
    }
    const carry = d.carry && { ...d.carry }
    const usage = addUsage(d.carry, r.usage)
    if (!over()) return { usage, carry, events: r.events ?? [], short }
    owe(key, { carry: usage })
    return { usage: null, carry: null, events: [], short }
  })()
  p.debt = d
  const set = flights.get(key) ?? new Set()
  flights.set(key, set.add(p))
  p.finally(() => {
    set.delete(p)
    if (!set.size && flights.get(key) === set) flights.delete(key)
  })
  return p
}

/**
 * How a Run of conversation conv, started at since, has its usage counted.
 * kept when conversation_id names the session so a later Run can collect debt.
 */
export function ledger(tok, conv, since, signal, kept, { before } = {}) {
  const key = tokKey(tok)
  const debtKey = usageKey(tok, conv)
  if (kept && before !== undefined) {
    const debts = [owed.get(debtKey), ...[...(flights.get(debtKey) ?? [])].map((p) => p.debt)]
    for (const d of debts) for (const g of d?.groups ?? (d ? [d] : [])) g.before = Math.min(g.before ?? Infinity, before)
  }
  let mine = null
  let theirs = null
  let over = false
  const gather = (opts) =>
    collect(tok, conv, { ...opts, over: () => over, abortFetch: before !== undefined }).then((r) => {
      theirs = addUsage(theirs, r.carry)
      for (const e of r.events ?? []) {
        if (e.at >= since - 1000) mine = addUsage(mine, e.usage)
        else theirs = addUsage(theirs, e.usage)
      }
      return r
    })
  let collecting = null
  const debt = kept ? owed.get(debtKey) : undefined
  const timer = debt ? setTimeout(() => (collecting = gather()), Math.max(0, debt.ready - Date.now())) : null
  timer?.unref?.()
  const takeMine = () => {
    const u = mine
    mine = null
    return u
  }
  const take = () => {
    const u = addUsage(theirs, mine)
    mine = theirs = null
    return u
  }
  return {
    async own() {
      if (!canRead(tok)) return null
      const m = misses.get(key) ?? 0
      const waits = m < STEP_WAIT.skipAfter || m % STEP_WAIT.retryEvery === 0
      if (!kept) {
        const r = waits ? await usageEvents(tok, conv, since, 1, { poll: true, signal }).catch(() => ({})) : {}
        if (r.usage) misses.delete(key)
        else if (!r.refused) misses.set(key, m + 1)
        return r.usage ?? null
      }
      owe(debtKey, { since, n: 1, ready: Date.now() + STEP_WAIT.owedAt })
      if (waits) {
        const r = await gather({ poll: true, signal })
        if (!canRead(tok)) return null
        if (r.short) misses.set(key, m + 1)
        else misses.delete(key)
      } else misses.set(key, m + 1)
      return takeMine() ?? false
    },
    async owed(final) {
      if (!kept) return null
      if (final) {
        await collecting
        await Promise.all([...(flights.get(debtKey) ?? [])])
        if (owed.has(debtKey)) await gather({ poll: owed.get(debtKey).n > 0, first: 0, signal })
      }
      return take()
    },
    done() {
      over = true
      clearTimeout(timer)
      const u = take()
      if (u) owe(debtKey, { carry: u })
    },
  }
}

/** Clear process-local ledger state (tests). */
export function clearLedger() {
  claimed.clear()
  owed.clear()
  flights.clear()
  unreadable.clear()
  misses.clear()
}
