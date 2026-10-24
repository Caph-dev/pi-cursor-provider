import assert from "node:assert/strict"
import { test } from "node:test"
import { getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent"
import { CombinedAutocompleteProvider, Editor, stripTerminalSequences } from "@earendil-works/pi-tui"
import type { AutocompleteProvider } from "@earendil-works/pi-tui"
import type { RegisteredCommand } from "@earendil-works/pi-coding-agent"
import { registerCursorFast } from "../src/fast.ts"
import { cursorFastAutocomplete } from "../src/fast-autocomplete.ts"

function fixture() {
  initTheme("dark", false)
  let registered!: RegisteredCommand
  let provider!: AutocompleteProvider
  let installs = 0
  const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>()
  registerCursorFast({
    on: (name: string, handler: (event: any, ctx: any) => unknown) => hooks.set(name, [...(hooks.get(name) ?? []), handler]),
    registerCommand: (_name: string, config: RegisteredCommand) => { registered = config },
    getThinkingLevel: () => "high",
  } as never)
  provider = new CombinedAutocompleteProvider([{ ...registered, name: "cursor.fast" }], process.cwd())
  const ctx = {
    mode: "tui",
    sessionManager: { getSessionId: () => "autocomplete-session", getBranch: () => [] },
    ui: {
      setStatus: () => {},
      addAutocompleteProvider: (factory: (current: AutocompleteProvider) => AutocompleteProvider) => { provider = factory(provider); installs++ },
    },
  }
  return {
    start: async () => { for (const handler of hooks.get("session_start") ?? []) await handler({}, ctx) },
    provider: () => provider,
    installs: () => installs,
    editor: () => {
      const editor = new Editor({ requestRender: () => {}, terminal: { rows: 32, columns: 100 } } as never, { borderColor: (text) => text, selectList: getSelectListTheme() })
      editor.setAutocompleteProvider(provider)
      return editor
    },
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

test("Tab after /cursor.fast plus a space offers only on/off through the registered TUI hook", async () => {
  const h = fixture()
  await h.start()
  const editor = h.editor()
  editor.setText("/cursor.fast ")
  let submitted = false
  editor.onSubmit = () => { submitted = true }
  editor.handleInput("\t")
  await flush()
  assert.equal(editor.isShowingAutocomplete(), true)
  const rendered = editor.render(100).map((line) => stripTerminalSequences(line)).join("\n")
  for (const value of ["on", "off"]) assert.ok(rendered.includes(value), value)
  assert.ok(!rendered.includes("status"))
  const suggestions = await h.provider().getSuggestions(["/cursor.fast "], 0, 13, { signal: new AbortController().signal, force: true })
  assert.deepEqual(suggestions?.items.map((item) => item.value), ["on", "off"])
  editor.handleInput("\t")
  assert.equal(editor.getText().trimEnd(), "/cursor.fast on")
  assert.equal(submitted, false)
})

test("Tab completes a unique argument without submitting; prefixes retain their original replacement span", async () => {
  const h = fixture()
  await h.start()
  for (const text of ["/cursor.fast of", "/cursor.fast   OF"]) {
    const editor = h.editor()
    let submitted = false
    editor.onSubmit = () => { submitted = true }
    editor.setText(text)
    editor.handleInput("\t")
    await flush()
    assert.equal(editor.getText().trimEnd(), "/cursor.fast off")
    assert.equal(submitted, false)
  }
  const options = { signal: new AbortController().signal, force: true }
  const text = "/cursor.fast o"
  const result = await h.provider().getSuggestions([text], 0, text.length, options)
  assert.deepEqual(result?.items.map((item) => item.value), ["on", "off"])
  for (const invalid of ["/cursor.fast nonsense", "/cursor.fast st"]) {
    assert.equal(await h.provider().getSuggestions([invalid], 0, invalid.length, options), null)
  }
})

test("repeated session_start does not install duplicate completion wrappers", async () => {
  const h = fixture()
  await h.start()
  await h.start()
  assert.equal(h.installs(), 1)
})

test("other commands, file paths, signals, trigger characters, and completion application are delegated intact", async () => {
  const calls: any[] = []
  const current: AutocompleteProvider = {
    triggerCharacters: ["@"],
    shouldTriggerFileCompletion(...args) { assert.equal(this, current); calls.push(args); return false },
    async getSuggestions(...args) { assert.equal(this, current); calls.push(args); return null },
    applyCompletion(lines, cursorLine, cursorCol) { assert.equal(this, current); return { lines, cursorLine, cursorCol } },
  }
  const wrapped = cursorFastAutocomplete(current)
  const options = { signal: new AbortController().signal, force: true }
  assert.equal(wrapped.triggerCharacters, current.triggerCharacters)
  for (const text of ["/other ", "./src/fast", "/cursor.faster ", "/cursor.fast"]) {
    assert.equal(wrapped.shouldTriggerFileCompletion?.([text], 0, text.length), false)
    await wrapped.getSuggestions([text], 0, text.length, options)
    assert.equal(calls.at(-1)[3], options)
  }
  const text = "/cursor.fast "
  assert.equal(wrapped.shouldTriggerFileCompletion?.([text], 0, text.length), true)
  await wrapped.getSuggestions([text], 0, text.length, options)
  assert.equal(calls.at(-1)[3].force, false)
  assert.equal(calls.at(-1)[3].signal, options.signal)
  await wrapped.getSuggestions(["hello", text], 1, text.length, options)
  assert.equal(calls.at(-1)[3], options)
  assert.deepEqual(wrapped.applyCompletion([text], 0, text.length, { value: "on", label: "on" }, ""), { lines: [text], cursorLine: 0, cursorCol: text.length })
  const withoutGate = cursorFastAutocomplete({ getSuggestions: current.getSuggestions, applyCompletion: current.applyCompletion })
  assert.equal(withoutGate.shouldTriggerFileCompletion?.(["path"], 0, 4), true)
})
