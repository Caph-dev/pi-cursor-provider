// Run the shipped CLI and its extension loader, not an SDK registration stub.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"

const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js")

test("CLI discovers models with no cache and restores them on an offline reload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cursor-cli-reload-"))
  const preload = join(dir, "network.mjs")
  const reloadExtension = join(dir, "reload.ts")
  const requests = join(dir, "requests.jsonl")
  const lifecycle = join(dir, "lifecycle.jsonl")
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: [] }))
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ cursor: {
    type: "oauth", access: "cli-fixture-access-xxxxxxxxxxxxxxxxxxxx", refresh: "fixture-refresh", expires: Date.now() + 3_600_000,
  } }))
  writeFileSync(join(dir, "cursor.json"), JSON.stringify({ hiddenModels: ["gpt-*"] }))
  writeFileSync(preload, `
import { appendFileSync } from "node:fs";
import { Socket } from "node:net";
Socket.prototype.connect = function () { throw new Error("Real network is disabled in the CLI regression test"); };
export function install() {
globalThis.fetch = async (url) => {
  const name = String(url).split("/").pop();
  appendFileSync(${JSON.stringify(requests)}, JSON.stringify(name) + "\\n");
  if (name === "AvailableModels") return Response.json({ models: [
    { name: "gpt-5", supportsAgent: true, contextTokenLimit: 300000,
      parameterDefinitions: [{ id: "fast", parameterType: { booleanParameter: { values: [{ value: "false" }, { value: "true" }] } } }],
      variants: [
        { legacySlug: "gpt-5", isDefaultNonMaxConfig: true, parameterValues: [{ id: "fast", value: "false" }] },
        { legacySlug: "gpt-5-fast", parameterValues: [{ id: "fast", value: "true" }] }
      ] },
    { name: "claude-test", supportsAgent: true, contextTokenLimit: 200000 }
  ] });
  if (name === "GetUsableModels") return Response.json({ models: [{ modelId: "gpt-5" }, { modelId: "gpt-5-fast" }, { modelId: "claude-test" }] });
  throw new Error("Unexpected network request in CLI regression test");
};
}
install();
`)
  writeFileSync(reloadExtension, `
import { appendFileSync } from "node:fs";
import register from ${JSON.stringify(resolve("src/index.ts"))};
import { install } from ${JSON.stringify(preload)};
const record = (data) => appendFileSync(${JSON.stringify(lifecycle)}, JSON.stringify(data) + "\\n");
export default async function (pi) {
  install();
  pi.on("session_start", install);
  record({ phase: "factory" });
  const api = new Proxy(pi, { get(target, key) {
    if (key !== "registerProvider") return Reflect.get(target, key);
    return (provider) => {
      const refresh = provider.refreshModels;
      provider.refreshModels = async (ctx) => {
        record({ phase: "refresh", network: ctx.allowNetwork, aborted: ctx.signal.aborted, cached: ctx.stored?.models?.length, credential: ctx.credential?.type, accessLength: ctx.credential?.access?.length });
        return refresh(ctx);
      };
      return target.registerProvider(provider);
    };
  } });
  await register(api);
  pi.on("session_start", (event) => record({ phase: "session_start", reason: event.reason }));
  pi.registerCommand("test.reload", {
    description: "Exercise reload with the network disabled",
    handler: async (_args, ctx) => {
      process.env.PI_OFFLINE = "1";
      await ctx.reload();
    },
  });
}
`)
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: dir }
  delete env.PI_OFFLINE
  delete env.CURSOR_ACCESS_TOKEN
  const child = spawn(process.execPath, [
    "--import", preload, cli, "--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp",
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "-e", reloadExtension,
  ], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] })
  let buffer = ""
  let stderr = ""
  const events: unknown[] = []
  let serial = 0
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (data) => { stderr += data })
  child.stdout.on("data", (data) => {
    buffer += data
    let end: number
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      let record: any
      try { record = JSON.parse(line) } catch { events.push({ raw: line }); continue }
      if (record.type !== "response") { events.push(record); continue }
      const waiter = pending.get(record.id)
      if (!waiter) continue
      pending.delete(record.id)
      if (record.success) waiter.resolve(record.data)
      else waiter.reject(new Error(record.error ?? "RPC command failed"))
    }
  })
  child.on("error", (error) => { for (const waiter of pending.values()) waiter.reject(error) })
  child.on("exit", () => {
    for (const waiter of pending.values()) waiter.reject(new Error(`CLI exited before response: ${stderr}`))
  })
  const exited = new Promise<void>((resolveExit) => child.once("close", () => resolveExit()))
  async function command(type: string, extra: Record<string, unknown> = {}): Promise<any> {
    const id = String(++serial)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise((resolveCommand, reject) => {
        timer = setTimeout(() => { pending.delete(id); reject(new Error(`CLI ${type} timed out: ${stderr}`)) }, 10_000)
        pending.set(id, { resolve: resolveCommand, reject })
        child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n")
      })
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    const commands = await command("get_commands")
    const before = await command("get_available_models")
    const diagnostic = JSON.stringify({ stderr, events, commands,
      lifecycle: existsSync(lifecycle) ? readFileSync(lifecycle, "utf8") : "not loaded",
      requests: existsSync(requests) ? readFileSync(requests, "utf8") : "none",
    })
    assert.deepEqual(before.models.filter((m: any) => m.provider === "cursor").map((m: any) => m.id), ["claude-test"], diagnostic)
    const cached = JSON.parse(readFileSync(join(dir, "models-store.json"), "utf8"))
    assert.deepEqual(cached.cursor.models.map((m: any) => m.id), ["gpt-5", "claude-test"])
    const requestCount = readFileSync(requests, "utf8").trim().split("\n").length
    writeFileSync(join(dir, "cursor.json"), JSON.stringify({ hiddenModels: [] }))
    await command("prompt", { message: "/test.reload" })
    const after = await command("get_available_models")
    assert.deepEqual(after.models.filter((m: any) => m.provider === "cursor").map((m: any) => m.id), ["gpt-5", "claude-test"])
    assert.equal(readFileSync(requests, "utf8").trim().split("\n").length, requestCount)

    // Exercise the actual command dispatcher, footer API, and a new extension
    // instance on reload. Speed changes must not alter model or thinking state.
    assert.ok(commands.commands.some((item: any) => item.name === "cursor.fast"))
    await command("set_model", { provider: "cursor", modelId: "gpt-5" })
    const original = await command("get_state")
    const fastStatus = () => events.filter((event: any) => event.method === "setStatus" && event.statusKey === "cursor-fast").map((event: any) => event.statusText).at(-1)
    await command("prompt", { message: "/cursor.fast on" })
    assert.equal(fastStatus(), "Cursor fast: on")
    await command("prompt", { message: "/cursor.fast status" })
    const enabledState = await command("get_state")
    assert.equal(enabledState.model.id, original.model.id)
    assert.equal(enabledState.thinkingLevel, original.thinkingLevel)
    await command("prompt", { message: "/test.reload" })
    assert.equal(fastStatus(), "Cursor fast: on")
    await command("set_model", { provider: "cursor", modelId: "claude-test" })
    await command("prompt", { message: "/cursor.fast on" })
    assert.equal(fastStatus(), "Cursor fast: unavailable")
    await command("set_model", { provider: "cursor", modelId: "gpt-5" })
    assert.equal(fastStatus(), "Cursor fast: on")
    await command("prompt", { message: "/cursor.fast off" })
    assert.equal(fastStatus(), "Cursor fast: off")
    const disabledState = await command("get_state")
    assert.equal(disabledState.model.id, original.model.id)
    assert.equal(disabledState.thinkingLevel, original.thinkingLevel)
    assert.equal(readFileSync(requests, "utf8").trim().split("\n").length, requestCount)
  } finally {
    child.kill()
    await exited
    rmSync(dir, { recursive: true, force: true })
  }
})
