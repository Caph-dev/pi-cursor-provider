/**
 * Ported from magpie's Cursor provider (MIT):
 * https://github.com/magpie-community/plugins/tree/main/packages/cursor
 * which itself was ported from magpie's Go client (internal/provider/cursor*.go).
 */
import { regional } from "./codec.ts"
import { request as resolveModel, usable } from "./models.ts"
import { nativeSessions } from "./native-session.ts"
import { conversation, conversationID, toolsOf } from "./protocol.ts"
import { agentURL, endpointView } from "./endpoint.ts"
import { resetH1, transportState } from "./transport.ts"
import { resumeRun, startRun, type Prepared, type RunArgs } from "./agent-run.ts"
import { trace, type Account, type Host } from "./trace.ts"

export { conversation, conversationID, decode, usageOf } from "./protocol.ts"
export { agentURL, clearAgentCache, endpointCacheKeys } from "./endpoint.ts"
export { resetH1 } from "./transport.ts"
export { nativeSessions } from "./native-session.ts"
export { STEP_WAIT, ledger, owed, misses, unreadable, clearLedger, usageKey } from "./ledger.ts"

const maxOnly = new Set<string>()
const maxRequired = (msg: unknown) => /max[ _]mode[ _]required|requires max mode/i.test(String(msg ?? ""))

export function clearMaxOnly(): void {
  maxOnly.clear()
}

export type RunState = {
  transport: { via: "h2" } | { via: "h1"; until: number }
  /** This account's agent host. null before a turn asked, after the entry expired, or without an account. */
  agent: { host: Host; source: "server-config" | "global-fallback"; until: number } | null
  otherAgents: number
  maxModeForced: readonly string[]
}

export function runState(account: Account | undefined, now = Date.now()): RunState {
  const { agent, otherAgents } = endpointView(account, now)
  return { ...transportState(now), agent, otherAgents, maxModeForced: [...maxOnly].sort() }
}

export type RunAnswerOptions = {
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
}

export type RunAnswerResult = {
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
}

export async function runAnswer(opts: RunAnswerOptions): Promise<RunAnswerResult> {
  const t = trace
  if (!t) return answer(opts)
  return t.within({ token: opts.tok, model: opts.model }, async () => {
    const ran = await answer(opts)
    if (ran.error && !opts.signal?.aborted) t.note("failed", { error: ran.error })
    return ran.events ? { ...ran, events: t.carry(ran.events) } : ran
  })
}

async function answer({
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
  headerWaitMs,
  toolIdleMs,
}: RunAnswerOptions): Promise<RunAnswerResult> {
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
  const convID = conversationID(chat, String(session ?? "").trim().slice(0, 128))
  const prepared: Prepared = nativeSessions.prepare(tok, chat, convID, listed)
  if (prepared.owner) {
    try {
      const conv = conversation(chat, listed)
      return { conversationId: convID, events: resumeRun(prepared, conv.estimate, signal) }
    } catch (caught) {
      const e = caught as { status?: number; message?: string } | null | undefined
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
  const id = resolved.id
  const params = resolved.params
  let maxMode = resolved.maxMode || maxOnly.has(id)
  const conv = conversation(chat, listed)
  let base = await resolveAgentURL(tok, false, signal)
  const once = () => {
    const args: RunArgs = { tok, base, id, tools: listed, conv, convID, signal, maxMode, params, connect, onResponse, onPayload, headers, headerWaitMs, toolIdleMs }
    return startRun(prepared, args)
  }
  let ran = await once()
  if (signal?.aborted) return ran
  if (ran.error && regional(ran.error.message)) {
    resetH1()
    const fresh = await resolveAgentURL(tok, true, signal)
    const viaH1 = !!ran.h1
    const again = (fresh !== base || viaH1) && !signal?.aborted
    trace?.note("retry", { rule: "region", error: ran.error, to: again ? fresh : undefined, cancelled: !!signal?.aborted })
    if (again) {
      base = fresh
      ran = await once()
    }
  }
  if (signal?.aborted) return ran
  if (ran.error && !maxMode && maxRequired(ran.error.message)) {
    trace?.note("retry", { rule: "max-mode", error: ran.error, model: id })
    maxMode = true
    maxOnly.add(id)
    ran = await once()
  }
  return ran
}
