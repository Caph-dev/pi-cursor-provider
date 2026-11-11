/**
 * Fast preferences remembered by the session's working directory.
 *
 * A session branch is still the source of truth once it has its own
 * `cursor-fast` entries. A new session in a directory that was used before
 * starts from the models last left on here, instead of the global default of
 * off. The file sits beside `cursor.json` and is never merged into it:
 * that file is hand-edited, and a bad write must not change what it hides.
 *
 *   { "directories": { "/abs/project": ["grok-test@256k"] } }
 *
 * Keys are real paths. A missing, unreadable, or malformed file remembers
 * nothing, and a failed write leaves the command's session entry in place.
 */
import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, normalize, resolve } from "node:path"

export const FAST_MEMORY_FILE = "cursor-fast.json"

/** `cursor-fast.json` beside the rest of Pi's config. */
export function fastMemoryPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = (env.PI_CODING_AGENT_DIR ?? "").trim()
  return join(dir || join(homedir(), ".pi", "agent"), FAST_MEMORY_FILE)
}

/** One spelling for a directory: the real path when it exists, otherwise the absolute path without `.` or `..`. */
export function canonicalCwd(cwd: string): string | undefined {
  const trimmed = cwd.trim()
  if (!trimmed) return undefined
  const absolute = normalize(resolve(trimmed))
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

function modelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.flatMap((id) => (typeof id === "string" && id.trim() ? [id.trim()] : [])))]
}

/** Models last left on in each directory. Anything that is not that map is ignored. */
export function readFastMemory(path: string = fastMemoryPath()): Map<string, string[]> {
  let json: unknown
  try {
    json = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return new Map()
  }
  const directories = (json as { directories?: unknown } | null)?.directories
  if (!directories || typeof directories !== "object" || Array.isArray(directories)) return new Map()
  const memory = new Map<string, string[]>()
  for (const [cwd, models] of Object.entries(directories)) {
    const key = canonicalCwd(cwd)
    const ids = modelIds(models)
    if (key && ids.length) memory.set(key, ids)
  }
  return memory
}

/** Replace one directory's remembered models. An empty list forgets the directory.
 * A failed write returns false and leaves the previous file alone. */
export function writeFastDirectory(cwd: string, models: Iterable<string>, path: string = fastMemoryPath()): boolean {
  const key = canonicalCwd(cwd)
  if (!key) return false
  const memory = readFastMemory(path)
  const ids = modelIds([...models])
  if (ids.length) memory.set(key, ids)
  else memory.delete(key)
  const directories = Object.fromEntries([...memory].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  const next = path + ".tmp"
  try {
    writeFileSync(next, JSON.stringify({ directories }) + "\n")
    renameSync(next, path)
    return true
  } catch {
    return false
  }
}
