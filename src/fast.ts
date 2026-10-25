import type { Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { streamCursor } from "./pi-stream.ts"
import { createFastFooter, supportsInlineFastFooter } from "./fast-footer.ts"
import { cursorFastAutocomplete } from "./fast-autocomplete.ts"

const ENTRY = "cursor-fast"
const STATUS = "cursor-fast"

type FastModel = Model<any> & { cursorFastLevels?: string[] }

export function registerCursorFast(pi: ExtensionAPI) {
  const enabled = new Set<string>()
  let sessionId: string | undefined
  let currentContext: ExtensionContext | undefined
  let badge = ""
  let footerInstalled = false
  let footerYielded = false
  let removingFooter = false
  let footerUI: ExtensionContext["ui"] | undefined
  let requestRender: (() => void) | undefined
  let autocompleteInstalled = false

  function clearFooter() {
    if (!footerInstalled) return
    removingFooter = true
    try { footerUI?.setFooter(undefined) } finally { removingFooter = false }
    footerInstalled = false
    footerUI = undefined
    requestRender = undefined
  }

  function display(ctx: ExtensionContext, text: string | undefined) {
    // Publish the status unconditionally: footers that render extension statuses
    // (pi-ccline, or Pi's own footer before 1.4) show it even when another
    // extension owns the footer slot. Our own footer filters this key out
    // (fast-footer.ts), so the inline badge is never duplicated.
    ctx.ui.setStatus(STATUS, text)
    if (ctx.mode !== "tui" || !supportsInlineFastFooter) return
    if (!text) { clearFooter(); return }
    badge = text
    if (!footerInstalled && !footerYielded) {
      footerUI = ctx.ui
      footerInstalled = true
      ctx.ui.setFooter((tui, theme, data) => {
        requestRender = () => tui.requestRender()
        return createFastFooter(() => currentContext!, pi, () => badge, tui, theme, data, () => {
          footerInstalled = false
          requestRender = undefined
          // Another extension may replace the shared footer. Yield ownership
          // rather than repeatedly replacing it or clearing its footer later.
          if (!removingFooter) footerYielded = true
        })
      })
    }
    requestRender?.()
  }

  const modelOf = (ctx: ExtensionContext): FastModel | undefined => {
    if (ctx.model?.provider !== "cursor") return undefined
    return (ctx.modelRegistry.find("cursor", ctx.model.id) ?? ctx.model) as FastModel
  }
  const supported = (model: FastModel, level: string) => Array.isArray(model.cursorFastLevels) && model.cursorFastLevels.includes(level)

  function updateStatus(ctx: ExtensionContext) {
    currentContext = ctx
    const model = modelOf(ctx)
    if (!model) {
      display(ctx, undefined)
      return
    }
    const on = enabled.has(model.id)
    const available = supported(model, pi.getThinkingLevel())
    display(ctx, available ? `Cursor fast: ${on ? "on" : "off"}` : `Cursor fast: ${on ? "on (unavailable)" : "unavailable"}`)
  }

  function restore(ctx: ExtensionContext) {
    enabled.clear()
    sessionId = ctx.sessionManager.getSessionId()
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY) continue
      const data = entry.data as { model?: unknown; enabled?: unknown } | undefined
      if (typeof data?.model !== "string" || typeof data.enabled !== "boolean") continue
      if (data.enabled) enabled.add(data.model)
      else enabled.delete(data.model)
    }
    updateStatus(ctx)
  }

  pi.on("session_start", (_event, ctx) => {
    restore(ctx)
    if (ctx.mode === "tui" && !autocompleteInstalled && typeof ctx.ui.addAutocompleteProvider === "function") {
      ctx.ui.addAutocompleteProvider(cursorFastAutocomplete)
      autocompleteInstalled = true
    }
  })
  pi.on("session_tree", (_event, ctx) => restore(ctx))
  pi.on("session_shutdown", (_event, ctx) => {
    clearFooter()
    ctx.ui.setStatus(STATUS, undefined)
    currentContext = undefined
    sessionId = undefined
    autocompleteInstalled = false
    enabled.clear()
  })
  pi.on("model_select", (_event, ctx) => updateStatus(ctx))
  pi.on("thinking_level_select", (_event, ctx) => updateStatus(ctx))
  pi.on("before_agent_start", (_event, ctx) => updateStatus(ctx))

  pi.registerCommand("cursor.fast", {
    description: "Set Cursor fast mode for the current model: on, off, or status",
    getArgumentCompletions: (prefix) => ["on", "off"].filter((value) => value.startsWith(prefix.trimStart().toLowerCase())).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status"
      if (!["on", "off", "status"].includes(action)) {
        ctx.ui.notify("Usage: /cursor.fast on|off|status", "warning")
        return
      }
      const model = modelOf(ctx)
      if (!model) {
        ctx.ui.notify("Select a Cursor model with /model before using /cursor.fast.", "warning")
        return
      }
      if (action !== "status" && !ctx.isIdle()) {
        ctx.ui.notify("Wait for the current response to finish before changing Cursor fast mode.", "warning")
        return
      }
      const level = pi.getThinkingLevel()
      if (action === "on" && !supported(model, level)) {
        ctx.ui.notify(`Cursor fast is unavailable for ${model.id} at thinking ${level}. Refresh /model if the catalogue is outdated.`, "warning")
        updateStatus(ctx)
        return
      }
      if (action !== "status") {
        const on = action === "on"
        pi.appendEntry(ENTRY, { model: model.id, enabled: on })
        if (on) enabled.add(model.id)
        else enabled.delete(model.id)
      }
      updateStatus(ctx)
      const on = enabled.has(model.id)
      const unavailable = supported(model, level) ? "" : " (unavailable at this thinking level)"
      ctx.ui.notify(`Cursor fast: ${on ? "on" : "off"}${unavailable} — ${model.id}; thinking ${level}.`, "info")
    },
  })

  return {
    updateStatus,
    catalogueChanged() { if (currentContext) updateStatus(currentContext) },
    stream(model: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions) {
      // A provider may also serve nested/background requests. Only apply the
      // preference to requests explicitly belonging to this Pi session.
      const fast = sessionId !== undefined && options?.sessionId === sessionId && enabled.has(model.id)
      return streamCursor(model, context, { ...options, fast })
    },
  }
}
