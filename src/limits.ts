/**
 * Output-token limits from models.dev, kept on disk.
 *
 * Cursor's picker says how much context a model takes but not how many tokens it
 * may answer with, so a Pi model config would have to guess. models.dev
 * (https://models.dev/api.json) publishes both limits for the same model ids
 * across many providers; this module indexes them by model id and answers with
 * the limit most providers report.
 *
 * The document is about 6 MB (600 KB gzipped), so it is not read during a
 * session: `cursor-limits.json` beside `cursor.json` holds the index, and it is
 * written when this package is installed or updated (the file records the
 * version that wrote it, so a version change refreshes it once) and when
 * `/cursor-provider-update` runs. A session start only reads the file.
 * Nothing here is required: a file that is absent or unreadable leaves an empty
 * index and the catalogue keeps its own fallback.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const LIMITS_FILE = "cursor-limits.json"

const SOURCE = "https://models.dev/api.json"
const TIMEOUT = 15_000
const RETRY = 10 * 60 * 1000

/** Names Cursor's picker uses for its router rather than for a model. */
export const ALIAS_IDS = new Set(["auto", "default"])

/** A model id as both sides spell it: last path segment, lowercase, `.`, `_`, and spaces as `-`. */
export function limitKey(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .split("/")
    .pop()!
    .replace(/@.*$/, "")
    .replace(/[._\s]+/g, "-")
}

type Model = { id?: string; limit?: { output?: number } }

/** Index a models.dev document: model id to the output limit most providers report, ties to the larger. */
export function limitIndexOf(json: unknown): Map<string, number> {
  const votes = new Map<string, Map<number, number>>()
  for (const provider of Object.values((json ?? {}) as Record<string, { models?: Record<string, Model> } | null>)) {
    // one vote per provider: a provider that lists the same model under several
    // ids (aliases) does not outvote the others
    const own = new Map<string, number>()
    for (const [id, model] of Object.entries(provider?.models ?? {})) {
      const output = Number(model?.limit?.output)
      if (!Number.isFinite(output) || output <= 0) continue
      const key = limitKey(model?.id ?? id)
      if (!key) continue
      own.set(key, Math.max(own.get(key) ?? 0, output))
    }
    for (const [key, output] of own) {
      const bucket = votes.get(key) ?? new Map<number, number>()
      bucket.set(output, (bucket.get(output) ?? 0) + 1)
      votes.set(key, bucket)
    }
  }
  const index = new Map<string, number>()
  for (const [key, bucket] of votes) {
    let tokens = 0
    let count = -1
    for (const [value, seen] of bucket) {
      if (seen > count || (seen === count && value > tokens)) [tokens, count] = [value, seen]
    }
    index.set(key, tokens)
  }
  return index
}

/** `cursor-limits.json` beside the rest of Pi's config. */
export function limitsPath(env: NodeJS.ProcessEnv = process.env, file = LIMITS_FILE): string {
  const dir = (env.PI_CODING_AGENT_DIR ?? "").trim()
  return join(dir || join(homedir(), ".pi", "agent"), file)
}

let version: string | undefined

/** The version of this package, which decides whether a stored index is current. */
export function packageVersion(): string {
  if (version !== undefined) return version
  try {
    const json = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as { version?: unknown }
    version = typeof json.version === "string" ? json.version : ""
  } catch {
    version = ""
  }
  return version
}

export type StoredLimits = { index: Map<string, number>; version?: string }

/** The stored index. A file that is absent, unreadable, or not ours reads as empty. */
export function readLimits(path: string = limitsPath()): StoredLimits {
  let json: unknown
  try {
    json = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return { index: new Map() }
  }
  const { version: wrote, limits } = (json ?? {}) as { version?: unknown; limits?: Record<string, unknown> }
  const index = new Map<string, number>()
  for (const [key, value] of Object.entries(limits ?? {})) {
    const tokens = Number(value)
    if (key && Number.isFinite(tokens) && tokens > 0) index.set(key, tokens)
  }
  return { index, ...(typeof wrote === "string" ? { version: wrote } : {}) }
}

/** Write the index, stamped with the version that wrote it. A failed write is not an error worth raising. */
export function writeLimits(index: Map<string, number>, path: string = limitsPath(), wrote: string = packageVersion()): boolean {
  try {
    writeFileSync(path, JSON.stringify({ version: wrote, limits: Object.fromEntries(index) }) + "\n")
    return true
  } catch {
    return false
  }
}

let retryAfter = 0
let inflight: Promise<Map<string, number> | undefined> | undefined

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" })
}

/** Read the document and index it. Undefined when the read fails; it never throws for that. */
async function download(): Promise<Map<string, number> | undefined> {
  try {
    const res = await fetch(SOURCE, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT) })
    if (!res.ok) throw new Error(`models.dev answered ${res.status}`)
    const index = limitIndexOf(await res.json())
    if (!index.size) throw new Error("models.dev listed no limits")
    retryAfter = 0
    return index
  } catch {
    retryAfter = Date.now() + RETRY
    return undefined
  }
}

/** One download at a time: two callers asking at once share the document. */
function shared(): Promise<Map<string, number> | undefined> {
  if (!inflight) inflight = download().finally(() => { inflight = undefined })
  return inflight
}

/** Settle with the shared download, or reject as soon as this caller is cancelled. */
function untilAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(abortError())
    signal.addEventListener("abort", stop, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", stop)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", stop)
        reject(error)
      },
    )
  })
}

/**
 * Refetch the document and store it. `force` is a person asking, which ignores
 * the backoff a failure sets. Returns the new index, or undefined on failure.
 */
export async function refreshLimits(signal?: AbortSignal, options: { force?: boolean; path?: string } = {}): Promise<Map<string, number> | undefined> {
  if (!options.force && Date.now() < retryAfter) return undefined
  const index = await untilAbort(shared(), signal)
  if (index && writeLimits(index, options.path ?? limitsPath())) return index
  return index
}

/**
 * The index to build a catalogue with: the stored one while it matches this
 * package's version, else a fresh read that is stored for the next session.
 */
export async function limitsForCatalogue(signal?: AbortSignal, path: string = limitsPath()): Promise<Map<string, number>> {
  const stored = readLimits(path)
  if (stored.index.size && stored.version === packageVersion()) return stored.index
  const fresh = await refreshLimits(signal, { path })
  return fresh ?? stored.index
}

export function clearLimitsRetry(): void {
  retryAfter = 0
  inflight = undefined
}
