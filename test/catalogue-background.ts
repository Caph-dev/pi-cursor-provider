// Pi paints the TUI before it binds extensions and awaits session_start
// handlers one at a time, so a network refresh awaited in this handler keeps
// the built-in footer on screen until it returns. The TUI path must therefore
// return first and publish afterwards; headless modes must keep awaiting,
// because an RPC host reads the catalogue right after startup.
import assert from "node:assert/strict"
import { test } from "node:test"
import registerExtension from "../src/index.ts"

type RefreshOptions = { signal: AbortSignal }
type RefreshResult = { errors: Map<string, Error> }
type Refresh = (options: RefreshOptions) => Promise<RefreshResult>

function host() {
  const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>()
  const notices: string[] = []
  const pi: any = {
    on: (name: string, handler: (event: any, ctx: any) => unknown) => {
      hooks.set(name, [...(hooks.get(name) ?? []), handler])
    },
    registerProvider: () => {},
    registerCommand: () => {},
    getThinkingLevel: () => "off",
    getSettings: () => ({}),
    appendEntry: () => {},
  }
  registerExtension(pi)
  const emit = async (name: string, ctx: any) => {
    for (const handler of hooks.get(name) ?? []) await handler({ type: name }, ctx)
  }
  return { emit, notices }
}

function ctxFor(mode: string, refresh: Refresh, notices: string[]) {
  return {
    mode,
    hasUI: true,
    model: undefined,
    modelRegistry: { refresh, find: () => undefined },
    sessionManager: {
      getSessionId: () => "catalogue-session",
      getBranch: () => [],
      getEntries: () => [],
      getLeafId: () => "0",
      getCwd: () => "/tmp",
      getSessionName: () => undefined,
    },
    isIdle: () => true,
    ui: {
      setStatus: () => {},
      setFooter: () => {},
      notify: (text: string, level: string) => notices.push(`${level}:${text}`),
    },
  } as any
}

/** A refresh whose result the test controls, so ordering is observable. */
function controlled() {
  let release!: (value: RefreshResult) => void
  let fail!: (error: Error) => void
  let options: RefreshOptions | undefined
  const promise = new Promise<RefreshResult>((resolve, reject) => { release = resolve; fail = reject })
  const refresh: Refresh = (next) => { options = next; return promise }
  return {
    refresh,
    release: (value: RefreshResult) => release(value),
    fail: (error: Error) => fail(error),
    get signal() { return options?.signal },
    get called() { return options !== undefined },
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test("the TUI session_start handler returns while the catalogue refresh is still in flight", async () => {
  const { emit, notices } = host()
  const refresh = controlled()
  const ctx = ctxFor("tui", refresh.refresh, notices)

  let handlerDone = false
  const emitted = emit("session_start", ctx).then(() => { handlerDone = true })
  await settle()
  assert.equal(handlerDone, true, "awaiting the network refresh is what leaves the built-in footer on screen")
  assert.equal(refresh.called, true, "the TUI path still starts the refresh")
  assert.deepEqual(notices, [], "nothing is reported before the refresh lands")

  await emitted
  refresh.release({ errors: new Map([["cursor", new Error("catalogue unavailable")]]) })
  await settle()
  assert.deepEqual(notices, ["warning:Cursor model catalogue: catalogue unavailable"])
})

test("a replacement session aborts and drops the refresh of the session it replaced", async () => {
  const { emit, notices } = host()
  const first = controlled()
  const second = controlled()

  await emit("session_start", ctxFor("tui", first.refresh, notices))
  await emit("session_start", ctxFor("tui", second.refresh, notices))
  assert.equal(first.signal?.aborted, true, "the replaced session's request is cancelled, so it cannot publish")
  assert.equal(second.signal?.aborted, false)

  first.release({ errors: new Map([["cursor", new Error("stale catalogue")]]) })
  await settle()
  assert.deepEqual(notices, [], "the superseded refresh owns no session any more")

  second.release({ errors: new Map([["cursor", new Error("current catalogue")]]) })
  await settle()
  assert.deepEqual(notices, ["warning:Cursor model catalogue: current catalogue"])
})

test("session_shutdown cancels an in-flight refresh and reports nothing afterwards", async () => {
  const { emit, notices } = host()
  const refresh = controlled()

  await emit("session_start", ctxFor("tui", refresh.refresh, notices))
  await emit("session_shutdown", ctxFor("tui", refresh.refresh, notices))
  assert.equal(refresh.signal?.aborted, true, "a closed session must not keep its catalogue request alive")

  refresh.release({ errors: new Map([["cursor", new Error("late catalogue")]]) })
  await settle()
  assert.deepEqual(notices, [])
})

test("a refresh that rejects is reported instead of becoming an unhandled rejection", async () => {
  const { emit, notices } = host()
  const refresh = controlled()

  await emit("session_start", ctxFor("tui", refresh.refresh, notices))
  refresh.fail(new Error("registry exploded"))
  await settle()
  assert.deepEqual(notices, ["warning:Cursor model catalogue: registry exploded"])
})

test("a rejected refresh for a session that already ended stays silent", async () => {
  const { emit, notices } = host()
  const refresh = controlled()

  await emit("session_start", ctxFor("tui", refresh.refresh, notices))
  await emit("session_shutdown", ctxFor("tui", refresh.refresh, notices))
  refresh.fail(new Error("registry exploded"))
  await settle()
  assert.deepEqual(notices, [])
})

test("headless session_start still awaits the catalogue refresh and reports its failure inline", async () => {
  const { emit, notices } = host()
  const refresh = controlled()
  const ctx = ctxFor("rpc", refresh.refresh, notices)

  let settled = false
  const emitted = emit("session_start", ctx).then(() => { settled = true })
  await settle()
  assert.equal(settled, false, "an RPC host reads the catalogue after startup, so the refresh must land first")

  refresh.release({ errors: new Map([["cursor", new Error("catalogue unavailable")]]) })
  await emitted
  assert.deepEqual(notices, ["warning:Cursor model catalogue: catalogue unavailable"])
})
