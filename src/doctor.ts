/**
 * /cursor.doctor. Reads each store through its owner's view and the journal
 * through trace.turns(). It changes no state and prints nothing derived from
 * a token. Every clock it prints is UTC.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { resolveAccessToken, type AuthSource } from "./auth.ts"
import { API, clientVersion } from "./client.ts"
import { configPath, hiddenPatterns } from "./config.ts"
import { ledgerState, type LedgerState } from "./ledger.ts"
import { nativeSessions, type NativeState } from "./native-session.ts"
import { runState, type RunState } from "./run.ts"
import { Account, hostOf, trace, type Decision, type TurnLog } from "./trace.ts"

type Report = {
  now: number
  /** null when nothing is signed in. */
  auth: { source: AuthSource; account: Account } | null
  version: string
  hidden: { patterns: readonly string[]; path: string }
  run: RunState
  native: NativeState
  ledger: LedgerState
  /** null while CURSOR_DEBUG is off. */
  journal: readonly TurnLog[] | null
}

type Notice = { text: string; level: "info" | "warning" }

export function registerCursorDoctor(pi: ExtensionAPI): void {
  pi.registerCommand("cursor.doctor", {
    description: "Show Cursor's credential, transport, agent host, native owners, and usage ledger, without printing the token",
    handler: async (args, ctx) => {
      const { text, level } = render(await gather())
      ctx.ui.notify(args.trim() ? `${text}\nThis command does not take arguments.` : text, level)
    },
  })
}

// Pi's own credential lookup can refresh OAuth over the network, so the doctor
// reads the local credential, as /cursor.usage does.
async function gather(): Promise<Report> {
  const auth = await resolveAccessToken()
  const version = await clientVersion()
  const account = auth ? Account.of(auth.token) : undefined
  const now = Date.now()
  return {
    now,
    auth: auth && account ? { source: auth.source, account } : null,
    version,
    hidden: { patterns: hiddenPatterns(), path: configPath() },
    run: runState(account, now),
    native: nativeSessions.state(account),
    ledger: ledgerState(account, now),
    journal: trace?.turns() ?? null,
  }
}

const clock = (ms: number) => `${new Date(ms).toISOString().slice(11, 19)}Z`
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function render(report: Report): Notice {
  const { auth, run, native, ledger, journal } = report
  const lines = [`Cursor doctor at ${clock(report.now)}`]
  lines.push(
    auth
      ? `Credential: ${auth.source}. Token not shown. Client ${report.version}.`
      : `Cursor is not signed in. Run /login cursor or set CURSOR_ACCESS_TOKEN. Client ${report.version}.`,
  )
  const { patterns, path } = report.hidden
  lines.push(patterns.length ? `Hidden from /model: ${patterns.join(", ")} (${path}).` : `No models hidden (${path}).`)
  lines.push(
    run.transport.via === "h2"
      ? "Transport: h2."
      : `Transport: h1, sticky until ${clock(run.transport.until)}. HTTP/2 failed on this network, so Runs use HTTP/1.1 at ${hostOf(API)} until then.`,
  )
  lines.push(agentLine(report))
  if (run.maxModeForced.length) lines.push(`Max mode forced for: ${run.maxModeForced.join(", ")}.`)

  const active = native.owners.filter((owner) => owner.phase !== "complete").length
  lines.push(
    `Native owners: ${active} active, ${native.owners.length - active} kept for replay (limits ${native.limits.perAccount} per account, ${native.limits.perProcess} per process).`,
  )
  for (const owner of native.owners) {
    const ends = owner.phase === "complete" ? "kept for replay" : `lifetime ends ${clock(owner.lifetimeEnds)}`
    const mode = owner.maxMode ? " in max mode" : ""
    lines.push(`  ${owner.phase}, ${owner.model || "unknown model"}${mode}, ${count(owner.rounds, "tool round")}, ${ends}, ${owner.current ? "this account" : "another account"}`)
  }

  const refused = ledger.unreadableOthers + (ledger.current?.unreadableUntil != null ? 1 : 0)
  const { runs, conversations, collecting } = ledger.owed
  lines.push(
    `Ledger: ${count(runs, "Run")} owed over ${count(conversations, "conversation")}, ${count(collecting, "collection")} running, ${count(refused, "account")} unreadable.`,
  )
  if (ledger.current) {
    const { runsOwed, misses, stepsWait, unreadableUntil } = ledger.current
    const skip = stepsWait ? "" : ", so steps skip the usage wait"
    const read = unreadableUntil === null ? "Usage events readable." : `Cursor refuses its usage events until ${clock(unreadableUntil)}.`
    lines.push(`  This account: ${count(runsOwed, "Run")} owed, ${count(misses, "usage miss", "usage misses")} in a row${skip}. ${read}`)
  }

  if (!journal) lines.push("Decision journal off. Start Pi with CURSOR_DEBUG=1 to record retry and fallback reasons.")
  else if (!journal.length) lines.push("Decision journal on (CURSOR_DEBUG). No turn has run yet.")
  else {
    lines.push("Recent decisions (CURSOR_DEBUG), oldest turn first:")
    for (const log of journal) {
      const whose = log.account && auth?.account.same(log.account) ? "this account" : "another account"
      lines.push(log.account ? `  Turn ${log.turn} at ${clock(log.started)}, ${log.model || "no model"}, ${whose}` : "  Outside any turn")
      for (const entry of log.entries) lines.push(`    ${say(entry)}${entry.count > 1 ? ` ×${entry.count}` : ""}`)
      if (log.dropped) lines.push(`    ${count(log.dropped, "later decision")} not kept`)
    }
  }

  const degraded = !auth || ledger.current?.unreadableUntil != null || run.transport.via === "h1"
  return { text: lines.join("\n"), level: degraded ? "warning" : "info" }
}

function agentLine({ auth, run }: Report): string {
  const n = run.otherAgents
  const others = n ? ` ${count(n, "other account")} ${n === 1 ? "has" : "have"} a cached host.` : ""
  if (!auth) return `Agent host: unknown while signed out.${others}`
  if (!run.agent) return `Agent host: none cached for this account. The next turn asks GetServerConfig.${others}`
  const named = run.agent.source === "server-config" ? "named by GetServerConfig" : "the global default because GetServerConfig named none"
  return `Agent host: ${run.agent.host}, ${named}, asked again after ${clock(run.agent.until)}.${others}`
}

function say(d: Decision): string {
  switch (d.kind) {
    case "endpoint":
      if (d.source === "server-config") return `endpoint: ${d.host}, named by GetServerConfig`
      return d.source === "kept-regional" ? `endpoint: kept ${d.host} (${d.why})` : `endpoint: ${d.host}, the global default (${d.why})`
    case "transport":
      if (d.via === "h2") return `run: h2 to ${d.host}`
      if (d.cause === "sticky") return `run: h1 to ${d.host}, sticky until ${clock(d.until)}`
      return `run: h1 to ${d.host}. HTTP/2 to ${d.h2Host} failed (${d.why})${d.until === null ? "" : `, sticky until ${clock(d.until)}`}.`
    case "native":
      return "why" in d ? `native: ${d.path}, ${d.why}` : `native: ${d.path}`
    case "owner-ended":
      return `owner ended: ${d.phase}, ${d.model || "unknown model"} (${d.why})`
    case "retry":
      if (d.rule === "max-mode") return `max mode required for ${d.model} (${d.status}, ${d.why}). Retried with max mode.`
      if ("retriedOn" in d) return `region error (${d.status}, ${d.why}). Retried on ${d.retriedOn}.`
      return `region error (${d.status}, ${d.why}). Not retried because ${d.notRetried === "cancelled" ? "the turn was cancelled" : "the agent host did not change and the Run used HTTP/2"}.`
    case "failed":
      return `failed (${d.status}, ${d.why})${d.bodyCut ? ", error body cut short" : ""}`
    case "usage":
      return d.outcome === "failed" ? `usage read failed (${d.why})` : `usage read ${d.outcome} (${d.status})`
  }
}
