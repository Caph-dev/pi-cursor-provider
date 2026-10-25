import assert from "node:assert/strict"
import { test } from "node:test"
import { initTheme } from "@earendil-works/pi-coding-agent"
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui"
import { registerCursorFast } from "../src/fast.ts"

function fixture() {
  initTheme("dark", false)
  let model: any = { provider: "cursor", id: "grok-test@500k", reasoning: true, contextWindow: 500_000, cursorFastLevels: ["high"] }
  let autoCompact = false
  let subscription = true
  let footer: any
  let renders = 0
  let disposed = 0
  let resets = 0
  const statuses = new Map([["other-plugin", "Other status"], ["cursor-fast", "Stale fast status"]])
  const entries: any[] = [{ type: "usage", usage: { input: 1200, output: 300, cacheRead: 400, cacheWrite: 100, cost: { total: 0.25 } } }]
  const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>()
  let command!: (args: string, ctx: any) => Promise<void>
  const ctx: any = {
    mode: "tui",
    get model() { return model },
    getContextUsage: () => ({ percent: 12.5, contextWindow: model.contextWindow }),
    modelRegistry: {
      find: () => model,
      isUsingOAuth: () => subscription,
      getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
    },
    sessionManager: {
      getSessionId: () => "footer-session",
      getBranch: () => entries,
      getEntries: () => [...entries],
      getLeafId: () => String(entries.length),
      getCwd: () => "/tmp/项目",
      getSessionName: () => "Footer test",
    },
    isIdle: () => true,
    ui: {
      notify: () => {},
      addAutocompleteProvider: () => {},
      setStatus: (key: string, text: string | undefined) => text === undefined ? statuses.delete(key) : statuses.set(key, text),
      setFooter: (factory: any) => {
        footer?.dispose?.()
        if (!factory) { footer = undefined; resets++; return }
        footer = factory({ requestRender: () => { renders++ } }, { fg: (_token: string, text: string) => text }, {
          getGitBranch: () => "main",
          getAvailableProviderCount: () => 2,
          getExtensionStatuses: () => statuses,
          onBranchChange: () => () => { disposed++ },
        })
      },
    },
  }
  const pi = {
    getThinkingLevel: () => "high",
    getSettings: () => ({ compaction: { enabled: autoCompact } }),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    registerCommand: (_name: string, config: any) => { command = config.handler },
    on: (name: string, handler: (event: any, ctx: any) => unknown) => hooks.set(name, [...(hooks.get(name) ?? []), handler]),
  }
  const controller = registerCursorFast(pi as never)
  return {
    ctx, controller, statuses,
    emit: async (name: string) => { for (const hook of hooks.get(name) ?? []) await hook({}, ctx) },
    command: (args: string) => command(args, ctx),
    lines: (width = 160): string[] => footer.render(width).map(stripTerminalSequences),
    rendered: () => renders,
    cleanupCount: () => disposed,
    resetCount: () => resets,
    active: () => footer,
    setProvider: (provider: string) => { model = { ...model, provider } },
    revoke: () => { model = { ...model, cursorFastLevels: [] }; controller.catalogueChanged() },
    appendUsage: () => entries.push({ type: "usage", usage: entries[0].usage }),
    setAutoCompact: (enabled: boolean) => { autoCompact = enabled },
    setSubscription: (enabled: boolean) => { subscription = enabled },
    replaceFooter: () => {
      footer.dispose()
      footer = { render: () => ["Another footer"] }
    },
  }
}

test("TUI fast is on row two alongside unchanged usage/model; other statuses stay on row three", async () => {
  const h = fixture()
  await h.emit("session_start")
  const lines = h.lines()
  assert.match(lines[0], /项目.*main.*Footer test/)
  for (const text of ["↑1.2k", "↓300", "R400", "W100", "$0.250 (sub)", "12.5%/500k", "grok-test@500k", "high", "fast: off"]) {
    assert.ok(lines[1].includes(text), text)
  }
  assert.ok(!lines[1].includes("(auto)"))
  assert.equal(lines[2], "Other status")
  assert.equal(h.statuses.get("cursor-fast"), "Cursor fast: off", "the status row stays published for footers that render statuses")
  const id = h.ctx.model.id
  await h.command("on")
  assert.ok(h.lines()[1].includes("fast: on"))
  assert.equal(h.ctx.model.id, id)
  assert.ok(h.rendered() > 1)
  h.revoke()
  assert.ok(h.lines()[1].includes("fast: on (unavailable)"))
  assert.equal(h.lines()[2], "Other status")
  h.setAutoCompact(true)
  h.setSubscription(false)
  assert.ok(h.lines()[1].includes("(auto)"))
  assert.ok(!h.lines()[1].includes("(sub)"))
  await h.emit("session_shutdown")
  assert.equal(h.statuses.get("cursor-fast"), undefined, "shutdown clears the status even while Cursor stays selected")
})

test("second-row usage refreshes when the session appends a new entry", async () => {
  const h = fixture()
  await h.emit("session_start")
  assert.ok(h.lines()[1].includes("↑1.2k"))
  h.appendUsage()
  const stats = h.lines()[1]
  for (const text of ["↑2.4k", "↓600", "R800", "W200", "$0.500 (sub)", "fast: off"]) assert.ok(stats.includes(text), text)
  await h.emit("session_shutdown")
})

test("fast footer never overflows narrow terminal widths and preserves other rows", async () => {
  const h = fixture()
  await h.emit("session_start")
  await h.command("on")
  for (const width of [0, 1, 8, 15, 30, 60, 80, 160]) {
    for (const line of h.lines(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`)
  }
  await h.emit("session_shutdown")
})

test("model switches and reload dispose the custom footer and restore it for Cursor", async () => {
  const h = fixture()
  await h.emit("session_start")
  h.setProvider("other")
  await h.emit("model_select")
  assert.equal(h.active(), undefined)
  assert.equal(h.cleanupCount(), 1)
  h.setProvider("cursor")
  await h.emit("model_select")
  assert.match(h.lines()[1], /fast: off/)
  await h.emit("session_shutdown")
  assert.equal(h.active(), undefined)
  assert.equal(h.cleanupCount(), 2)
  await h.emit("session_start")
  assert.match(h.lines()[1], /fast: off/)
  await h.emit("session_shutdown")
})

test("a later footer extension keeps ownership when Cursor is deselected or shuts down", async () => {
  const h = fixture()
  await h.emit("session_start")
  h.replaceFooter()
  await h.emit("before_agent_start")
  assert.deepEqual(h.lines(), ["Another footer"])
  assert.equal(h.statuses.get("cursor-fast"), "Cursor fast: off", "a foreign footer still gets the status")
  h.setProvider("other")
  await h.emit("model_select")
  assert.equal(h.statuses.get("cursor-fast"), undefined, "a non-Cursor model clears it")
  await h.emit("session_shutdown")
  assert.equal(h.resetCount(), 0)
  assert.deepEqual(h.lines(), ["Another footer"])
})
