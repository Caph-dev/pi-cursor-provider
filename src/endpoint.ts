/**
 * Which agent host serves a token.
 *
 * Ported from magpie's Cursor provider (MIT):
 * https://github.com/magpie-community/plugins/tree/main/packages/cursor
 *
 * Process state: endpoints, each token's agent host. Nothing else writes it.
 * h1Until lives in transport.ts. This file does not import it.
 */
import { AGENT, API, unary } from "./client.ts"
import { recall, store, tokenKey } from "./cache.ts"
import { hostOf, trace, type Account, type Host } from "./trace.ts"

// endpoints are the agent API picked for each token (by its hash). As
// cursor-agent does, it is what ServerConfigService/GetServerConfig names —
// a team may be served in one region only, and the global API turns it
// away — asked once a token, and again when fresh is set; the global one
// while it can't be had.

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
  // A refresh that learns nothing must not replace a regional URL with the global one.
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

// Walks endpoints without recall(), which deletes the expired entries this skips.
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
