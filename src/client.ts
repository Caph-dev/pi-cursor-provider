/**
 * Cursor client version and Connect JSON calls.
 *
 * Ported from magpie's Cursor provider (MIT):
 * https://github.com/magpie-community/plugins/tree/main/packages/cursor
 */
// @ts-nocheck
import { basename, dirname, join } from "node:path"
import { homedir, platform, tmpdir } from "node:os"
import { readdir, realpath, stat } from "node:fs/promises"
import { failure } from "./codec.ts"

export const API = "https://api2.cursor.sh"
export const AGENT = "https://agentn.global.api5.cursor.sh"
export const VERSION_FALLBACK = "2026.09.23-86fc751"
export const CALL = "CallDynamicTool"
export const NAMESPACE = "pi"
export const DEFAULT_CONTEXT = 200_000
export const MODELS_KEEP = 10 * 60 * 1000
export const GOOS = { win32: "windows" }[platform()] ?? platform()
export const tempDir = tmpdir

const exists = (p) => stat(p).then((s) => !s.isDirectory(), () => false)

async function cursorExecutable() {
  const dirs = (process.env.PATH ?? "").split(GOOS === "windows" ? ";" : ":").filter(Boolean)
  for (const name of ["cursor-agent", "agent"]) {
    for (const d of dirs) {
      const p = join(d, GOOS === "windows" ? name + ".exe" : name)
      if (!(await exists(p))) continue
      if (name === "cursor-agent") return p
      if ((await realpath(p).catch(() => "")).includes("cursor-agent")) return p
    }
  }
  const home = homedir()
  for (const p of [join(home, ".local", "bin", "cursor-agent"), "/usr/local/bin/cursor-agent", "/opt/homebrew/bin/cursor-agent"])
    if (await exists(p)) return p
  return ""
}

const VERSION_RE = /^\d{4}\.\d{2}\.\d{2}-[0-9a-f]+$/
const VERSION_TTL = 10 * 60 * 1000
let versionCache = { value: "", expires: 0 }

/** "cli-<installed cursor-agent version>", or the fallback the API still accepts. */
export async function clientVersion() {
  if (versionCache.value && Date.now() < versionCache.expires) return versionCache.value
  let v = ""
  const exe = await cursorExecutable()
  if (exe) {
    const d = basename(dirname(await realpath(exe).catch(() => exe)))
    if (VERSION_RE.test(d)) v = d
  }
  if (!v) {
    const dirs = [join(homedir(), ".local", "share", "cursor-agent", "versions")]
    if (GOOS === "windows") dirs.push(join(process.env.LOCALAPPDATA ?? "", "cursor-agent", "versions"))
    for (const dir of dirs)
      for (const n of await readdir(dir).catch(() => [])) if (VERSION_RE.test(n) && n > v) v = n
  }
  versionCache = { value: "cli-" + (v || VERSION_FALLBACK), expires: Date.now() + VERSION_TTL }
  return versionCache.value
}

export async function headersFor(tok) {
  return {
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1",
    ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
    "x-cursor-client-version": await clientVersion(),
    "x-cursor-client-type": "cli",
    "x-ghost-mode": "true",
  }
}

/** Connect unary call in JSON. `signal` aborts the request. `timeout` still does. */
export async function unary(base, path, tok, body = {}, timeout = 15_000, signal?: AbortSignal) {
  const deadline = AbortSignal.timeout(timeout)
  const res = await fetch(base + "/" + path, {
    method: "POST",
    headers: await headersFor(tok),
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
  })
  const text = await res.text()
  if (!res.ok) {
    const f = failure(res.status, text)
    const e = new Error(f.message)
    e.status = f.status
    throw e
  }
  return JSON.parse(text || "{}")
}
