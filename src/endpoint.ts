/**
 * Ported from magpie's Cursor provider (MIT):
 * https://github.com/magpie-community/plugins/tree/main/packages/cursor
 */
import { AGENT, API, unary } from "./client.ts"
import { recall, store, tokenKey } from "./cache.ts"
import { hostOf, trace, type Account, type Host } from "./trace.ts"

type Endpoint = { url: string; listed: boolean; expires: number }
const endpoints = new Map<string, Endpoint>()
const ENDPOINT_TTL = 10 * 60 * 1000
const ENDPOINT_MISS_TTL = 60_000

export function endpointCacheKeys(): string[] {
  return [...endpoints.keys()]
}

export async function agentURL(tok: string, fresh: boolean, signal?: AbortSignal): Promise<string> {
  const key = tokenKey(tok)
  const had = recall(endpoints, key)
  if (!fresh && had) return had.url
  let url = AGENT
  let listed = false
  let error: unknown
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
    error = e
  }
  if (signal?.aborted) throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" })
  const kept = !listed && fresh && !!had?.url
  trace?.note("endpoint", { url: kept ? had.url : url, listed, kept, error })
  if (kept) return had.url
  store(endpoints, key, { url, listed, expires: 0 }, listed ? ENDPOINT_TTL : ENDPOINT_MISS_TTL)
  return url
}

export function clearAgentCache(): void {
  endpoints.clear()
}

export type AgentHit = {
  host: Host
  source: "server-config" | "global-fallback"
  until: number
}

export function endpointView(account: Account | undefined, now: number): { agent: AgentHit | null; otherAgents: number } {
  let agent: AgentHit | null = null
  let otherAgents = 0
  for (const [key, entry] of endpoints) {
    if (now >= entry.expires) continue
    if (account?.is(key)) agent = { host: hostOf(entry.url), source: entry.listed ? "server-config" : "global-fallback", until: entry.expires }
    else otherAgents++
  }
  return { agent, otherAgents }
}
