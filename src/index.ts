/**
 * Pi extension: provider id `cursor`.
 *
 * Login follows pi-cursor (MIT): https://github.com/Rahularya01/pi-cursor
 * A stateless turn opens an HTTP/2 Run and tears it down after tools.
 * A native Run in this process stays open and takes call_cursor_ results.
 * This does not register a parked bridge, a checkpoint, or a run journal.
 */
import { createHash } from "node:crypto"
import type { RefreshModelsContext } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent"
import { login, refresh, resolveAccessToken } from "./auth.ts"
import { AGENT, clientVersion } from "./client.ts"
import { piModelConfigs, usable } from "./models.ts"
import { streamCursor } from "./pi-stream.ts"
import { fetchUsage, formatUsage } from "./usage.ts"

export { fetchUsage, formatUsage, onDemandOf } from "./usage.ts"

const catalogs = new Map<string, ProviderModelConfig[]>()

function credentialKey(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

function tokenFrom(ctx: RefreshModelsContext): string | undefined {
  if (ctx.credential?.type === "oauth") return ctx.credential.access
  if (ctx.credential?.type === "api_key") return ctx.credential.key
  return undefined
}

async function refreshModels(ctx: RefreshModelsContext): Promise<ProviderModelConfig[]> {
  const hinted = tokenFrom(ctx)
  const auth = ctx.signal.aborted ? undefined : await resolveAccessToken({ apiKey: hinted })
  const token = auth?.token ?? hinted
  const kept = () => (token ? (catalogs.get(credentialKey(token)) ?? []) : [])
  if (ctx.signal.aborted || !ctx.allowNetwork || !auth) return kept()
  const key = credentialKey(auth.token)
  try {
    const next = piModelConfigs(await usable(auth.token, ctx.force === true, ctx.signal)) as ProviderModelConfig[]
    if (ctx.signal.aborted) return catalogs.get(key) ?? []
    catalogs.set(key, next)
    return next
  } catch {
    return catalogs.get(key) ?? []
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("cursor", {
    name: "Cursor",
    baseUrl: AGENT,
    apiKey: "$CURSOR_ACCESS_TOKEN",
    api: "cursor-run",
    models: [],
    oauth: {
      name: "Cursor",
      isSubscription: true,
      login,
      refreshToken: (credentials, signal) => refresh(credentials, signal),
      getApiKey: (credentials) => credentials.access,
    },
    refreshModels,
    streamSimple: streamCursor,
  })

  pi.registerCommand("cursor.doctor", {
    description: "Show which Cursor credential would be used, without printing the token",
    handler: async (args, ctx) => {
      const extra = args.trim() ? " This command does not take arguments." : ""
      const auth = await resolveAccessToken()
      const version = await clientVersion()
      if (!auth) {
        ctx.ui.notify(`Cursor is not signed in (${version}). Run /login cursor or set CURSOR_ACCESS_TOKEN.${extra}`, "warning")
        return
      }
      ctx.ui.notify(`Cursor auth source: ${auth.source}. Client ${version}. Token not shown.${extra}`, "info")
    },
  })

  pi.registerCommand("cursor.usage", {
    description: "Show Cursor plan usage for this billing period",
    handler: async (args, ctx) => {
      const extra = args.trim() ? " This command does not take arguments." : ""
      const auth = await resolveAccessToken()
      if (!auth) {
        const version = await clientVersion()
        ctx.ui.notify(`Cursor is not signed in (${version}). Run /login cursor or set CURSOR_ACCESS_TOKEN.${extra}`, "warning")
        return
      }
      let ids = (catalogs.get(credentialKey(auth.token)) ?? []).map((m) => m.id)
      if (!ids.length) {
        try {
          ids = (await usable(auth.token, false, ctx.signal)).map((m: { id: string }) => m.id)
        } catch {
          ids = []
        }
      }
      try {
        const report = await fetchUsage(auth.token, ids, ctx.signal)
        ctx.ui.notify(formatUsage(report) + extra, report.error ? "warning" : "info")
      } catch (e) {
        ctx.ui.notify(`Cursor usage could not be read. ${e instanceof Error ? e.message : String(e)}${extra}`, "warning")
      }
    },
  })
}
