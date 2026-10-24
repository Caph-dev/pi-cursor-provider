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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { login, refresh, resolveAccessToken } from "./auth.ts"
import { AGENT, clientVersion } from "./client.ts"
import { configPath, hiddenPatterns, visible } from "./config.ts"
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
  pi.on("session_start", async (_event, ctx) => {
    const result = await ctx.modelRegistry.refresh({
      providers: ["cursor"],
      allowNetwork: process.env.PI_OFFLINE === undefined,
      signal: AbortSignal.timeout(15_000),
    })
    fast.updateStatus(ctx)
    const error = result.errors.get("cursor")
    if (error && ctx.hasUI) ctx.ui.notify(`Cursor model catalogue: ${error.message}`, "warning")
  })

  pi.registerCommand("cursor.doctor", {
    description: "Show which Cursor credential would be used, without printing the token",
    handler: async (args, ctx) => {
      const extra = args.trim() ? " This command does not take arguments." : ""
      const auth = await resolveAccessToken()
      const version = await clientVersion()
      const patterns = hiddenPatterns()
      const hiddenText = patterns.length ? `Hidden from /model: ${patterns.join(", ")} (${configPath()}).` : `No models hidden (${configPath()}).`
      if (!auth) {
        ctx.ui.notify(`Cursor is not signed in (${version}). Run /login cursor or set CURSOR_ACCESS_TOKEN. ${hiddenText}${extra}`, "warning")
        return
      }
      ctx.ui.notify(`Cursor auth source: ${auth.source}. Client ${version}. ${hiddenText} Token not shown.${extra}`, "info")
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
