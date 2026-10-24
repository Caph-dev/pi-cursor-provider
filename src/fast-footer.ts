import * as Pi from "@earendil-works/pi-coding-agent"
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import type { TUI } from "@earendil-works/pi-tui"

const FooterComponent = Pi.FooterComponent

// The adapter below follows the inspected 1.4 renderer. Other versions retain
// the standard status row until their footer contract has been verified.
export const supportsInlineFastFooter = /^1\.4\./.test(Pi.VERSION) && typeof FooterComponent === "function"

/** Keep Pi's standard footer formatting, reserving space in row two for fast. */
export function createFastFooter(
  context: () => ExtensionContext,
  pi: Pick<ExtensionAPI, "getThinkingLevel" | "getSettings">,
  badge: () => string,
  tui: Pick<TUI, "requestRender">,
  theme: Theme,
  data: ReadonlyFooterDataProvider,
  onDispose: () => void = () => {},
) {
  let leaf: string | null | undefined
  let entries: ReturnType<ExtensionContext["sessionManager"]["getEntries"]> | undefined
  const getEntries = () => {
    const manager = context().sessionManager
    if (!entries || leaf !== manager.getLeafId()) {
      leaf = manager.getLeafId()
      entries = manager.getEntries()
    }
    return entries
  }
  // FooterComponent (Pi 1.4) reads only this session surface. Supply it from
  // public extension context APIs; the real model/session are never modified.
  const session = {
    get model() { return context().model },
    get routedModel() { return undefined }, // Installed only for physical Cursor models.
    get state() { return { model: context().model, thinkingLevel: pi.getThinkingLevel() } },
    sessionManager: {
      getCwd: () => context().sessionManager.getCwd(),
      getSessionId: () => context().sessionManager.getSessionId(),
      getLeafId: () => context().sessionManager.getLeafId(),
      getSessionName: () => context().sessionManager.getSessionName(),
      getEntryCount: () => getEntries().length,
      getEntries,
    },
    getContextUsage: () => context().getContextUsage(),
    modelRuntime: {
      isUsingSubscription: (provider: string) => {
        const ctx = context()
        return ctx.model?.provider === provider && ctx.modelRegistry.isUsingOAuth(ctx.model) &&
          ctx.modelRegistry.getProvider(provider)?.auth.oauth?.isSubscription === true
      },
    },
  }
  const footer = new FooterComponent(session as unknown as ConstructorParameters<typeof FooterComponent>[0], {
    getGitBranch: () => data.getGitBranch(),
    getAvailableProviderCount: () => data.getAvailableProviderCount(),
    onBranchChange: (callback) => data.onBranchChange(callback),
    getExtensionStatuses: () => new Map([...data.getExtensionStatuses()].filter(([key]) => key !== "cursor-fast")),
  })
  const unsubscribe = data.onBranchChange(() => tui.requestRender())
  return {
    invalidate: () => footer.invalidate(),
    dispose() {
      unsubscribe()
      footer.dispose()
      entries = undefined
      onDispose()
    },
    render(width: number): string[] {
      footer.setAutoCompactEnabled(pi.getSettings().compaction?.enabled ?? true)
      const lines = footer.render(width)
      const text = badge().replace(/^Cursor /, "")
      const label = theme.fg(text === "fast: on" ? "accent" : "dim", text)
      const suffix = ` • ${label}`
      const reserved = visibleWidth(suffix)
      lines[1] = width <= reserved
        ? truncateToWidth(label, width, "")
        : truncateToWidth((footer.render(width - reserved)[1] ?? "") + suffix, width, "")
      return lines
    },
  }
}
