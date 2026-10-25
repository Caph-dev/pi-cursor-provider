/**
 * Pi extension: provider id `cursor`.
 *
 * Login follows pi-cursor (MIT): https://github.com/Rahularya01/pi-cursor
 * A stateless turn opens an HTTP/2 Run and tears it down after tools.
 * A native Run in this process stays open and takes call_cursor_ results.
 * This does not register a parked bridge, a checkpoint, or a run journal.
 */
import { createHash } from "node:crypto"
import type { Model, Provider } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { login, refresh, resolveAccessToken } from "./auth.ts"
import { AGENT, clientVersion } from "./client.ts"
import { hiddenPatterns, visible } from "./config.ts"
import { registerCursorDoctor } from "./doctor.ts"
import { piModelConfigs, usable } from "./models.ts"
import { registerCursorFast } from "./fast.ts"
import { fetchUsage, formatUsage } from "./usage.ts"

export { fetchUsage, formatUsage, onDemandOf } from "./usage.ts"

// One catalogue per credential: a refresh for one account must never serve
// its models to another.
const catalogs = new Map<string, Model<"cursor-run">[]>()

function credentialKey(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}


export default function (pi: ExtensionAPI) {
  // Keep the complete catalogue per registration. Local visibility rules must
  // also run on synchronous reads, not only when a remote refresh completes.
  let offered: Model<"cursor-run">[] = []
  // Which credential produced `offered`; undefined when it came from Pi's cache
  // alone, whose provenance this provider cannot see.
  let offeredKey: string | undefined
  const fast = registerCursorFast(pi)
  const provider: Provider<"cursor-run"> = {
    id: "cursor",
    name: "Cursor",
    baseUrl: AGENT,
    getModels: () => visible(offered, hiddenPatterns()),
    // Pi applies this after models.json overlays, including user-added models.
    filterModels: (models) => visible(models, hiddenPatterns()),
    auth: {
      apiKey: {
        name: "Cursor access token",
        resolve: async ({ ctx, credential }) => {
          const auth = await resolveAccessToken({
            apiKey: credential?.key,
            env: { CURSOR_ACCESS_TOKEN: await ctx.env("CURSOR_ACCESS_TOKEN") },
          })
          return auth ? { auth: { apiKey: auth.token }, source: auth.source } : undefined
        },
      },
      oauth: {
        name: "Cursor",
        isSubscription: true,
        login: async (interaction) => ({
          ...(await login({
            onAuth: (info) => interaction.notify({ type: "auth_url", ...info }),
            onDeviceCode: (info) => interaction.notify({ type: "device_code", ...info }),
            onSelect: (prompt) => interaction.prompt({ type: "select", ...prompt }),
            onPrompt: (prompt) => interaction.prompt({ type: "text", ...prompt }),
            onProgress: (message) => interaction.notify({ type: "progress", message }),
            signal: interaction.signal,
          })),
          type: "oauth",
        }),
        refresh: async (credential, signal) => ({ ...(await refresh(credential, signal)), type: "oauth" }),
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
    refreshModels: async (ctx) => {
      if (ctx.signal.aborted) return
      // Pi initializes and reloads extensions without network access. Restore
      // the unfiltered catalogue before that phase returns, including when a
      // subsequent network refresh fails or is cancelled.
      if (!offered.length && ctx.stored) {
        const cached = ctx.stored.models.filter((model): model is Model<"cursor-run"> =>
          model.provider === "cursor" && model.api === "cursor-run" && (model.type === undefined || model.type === "chat"),
        )
        if (cached.length) await ctx.publish({ update: () => { offered = cached; offeredKey = undefined; fast.catalogueChanged() } })
      }
      const hinted = ctx.credential?.type === "oauth" ? ctx.credential.access : ctx.credential?.type === "api_key" ? ctx.credential.key : undefined
      const auth = ctx.signal.aborted ? undefined : await resolveAccessToken({ apiKey: hinted })
      if (ctx.signal.aborted) return
      const token = auth?.token ?? hinted
      // Serve the catalogue this credential already discovered, without the
      // network, so an offline reload does not look like a signed-out account.
      const kept = token ? catalogs.get(credentialKey(token)) : undefined
      if (!ctx.allowNetwork || !auth) {
        if (kept?.length) {
          await ctx.publish({ update: () => { offered = kept; offeredKey = token ? credentialKey(token) : undefined; fast.catalogueChanged() } })
        }
        return
      }
      const key = credentialKey(auth.token)
      try {
        const next = piModelConfigs(await usable(auth.token, ctx.force === true, ctx.signal)).map((model: Model<"cursor-run">) => ({
          ...model,
          provider: "cursor",
          baseUrl: AGENT,
        })) as Model<"cursor-run">[]
        if (ctx.signal.aborted) return
        catalogs.set(key, next)
        await ctx.publish({
          persist: { models: next, checkedAt: Date.now() },
          update: () => { offered = next; offeredKey = key; fast.catalogueChanged() },
        })
      } catch (error) {
        // Never keep another credential's catalogue after a failed refresh: fall
        // back to what this one discovered, even if that is nothing.
        const unknownSource = offeredKey === undefined
        const previous = catalogs.get(key) ?? []
        await ctx.publish({ update: () => { offered = previous; offeredKey = key; fast.catalogueChanged() } })
        // Surface a first-load failure instead of reporting an empty provider as
        // a successful refresh.
        if (!previous.length && unknownSource) throw error
      }
    },
    stream: fast.stream,
    streamSimple: fast.stream,
  }
  pi.registerProvider(provider)

  // Startup and /reload restore cached models first. Discover the catalogue
  // for a first install too, once the host has bound credentials and context.
  const refreshCatalogue = (ctx: ExtensionContext, signal: AbortSignal) =>
    ctx.modelRegistry.refresh({
      providers: ["cursor"],
      allowNetwork: process.env.PI_OFFLINE === undefined,
      signal,
    })

  // Pi awaits session_start handlers one at a time, so awaiting the network
  // round trip here holds back every extension registered later in the session:
  // the TUI paints its built-in footer before it binds extensions, and a custom
  // footer stays unpainted until this handler returns (measured: ~1.9 s). Run
  // the refresh in the background there and let it publish when it lands.
  // Headless modes keep awaiting: an RPC host reads the catalogue right after
  // startup and has no other signal that it changed.
  let catalogueGeneration = 0
  let catalogueAbort: AbortController | null = null

  // A new session, a reload, or a shutdown owns the registry and the status row
  // from now on: bump the generation and stop the request the previous session
  // started, so `refreshModels` cannot publish a catalogue for it either.
  function retireCatalogue(): number {
    catalogueGeneration += 1
    catalogueAbort?.abort()
    catalogueAbort = null
    return catalogueGeneration
  }
  pi.on("session_shutdown", () => { retireCatalogue() })

  pi.on("session_start", async (_event, ctx) => {
    const generation = retireCatalogue()
    const timeout = AbortSignal.timeout(15_000)
    if (ctx.mode !== "tui") {
      const result = await refreshCatalogue(ctx, timeout)
      fast.updateStatus(ctx)
      const error = result.errors.get("cursor")
      if (error && ctx.hasUI) ctx.ui.notify(`Cursor model catalogue: ${error.message}`, "warning")
      return
    }
    const request = new AbortController()
    catalogueAbort = request
    const signal = AbortSignal.any([timeout, request.signal])
    void (async () => {
      try {
        const result = await refreshCatalogue(ctx, signal)
        // The status row and the warning belong to the session that asked, and
        // that session is gone as soon as the generation moved on.
        if (generation !== catalogueGeneration) return
        fast.updateStatus(ctx)
        const error = result.errors.get("cursor")
        if (error && ctx.hasUI) ctx.ui.notify(`Cursor model catalogue: ${error.message}`, "warning")
      } catch (error) {
        // Nothing awaits this task, so Pi's error listener cannot see the throw,
        // and a superseded ctx throws as soon as it is touched.
        if (generation !== catalogueGeneration) return
        try {
          if (ctx.hasUI) ctx.ui.notify(`Cursor model catalogue: ${error instanceof Error ? error.message : String(error)}`, "warning")
        } catch {
          // The session ended while the refresh was in flight.
        }
      } finally {
        if (catalogueAbort === request) catalogueAbort = null
      }
    })()
  })

  registerCursorDoctor(pi)

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
      let ids = (catalogs.get(credentialKey(auth.token)) ?? offered).map((m) => m.id)
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
