/**
 * Which Cursor models Pi's picker offers.
 *
 * Cursor lists every model (and every context size and effort of it) a
 * subscription may use; that is long enough that the useful ones get lost in
 * `/model`. `cursor.json` in Pi's config directory (`PI_CODING_AGENT_DIR`,
 * else `~/.pi/agent`) names what to hide:
 *
 *   { "hiddenModels": ["claude-*", "gpt-5", "cursor/gpt-5-mini"] }
 *
 * A pattern globs the id `/model` shows (the part after `cursor/`): `*` is any
 * run of characters, everything else is literal, and the match ignores case.
 * Hiding removes models from the live directory too: sessions already using a
 * hidden model keep it, but resuming one may require selecting another model.
 * A missing, unreadable or malformed file hides nothing.
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const CONFIG_FILE = "cursor.json"

/** `cursor.json` beside the rest of Pi's config. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = (env.PI_CODING_AGENT_DIR ?? "").trim()
  return join(dir || join(homedir(), ".pi", "agent"), CONFIG_FILE)
}

/** `hiddenModels` as patterns: strings only, trimmed, empty ones dropped. */
function patternsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((v) => (typeof v === "string" && v.trim() ? [v.trim()] : []))
}

/** The patterns in `cursor.json`. A file that is absent or not JSON hides nothing. */
export function hiddenPatterns(path: string = configPath()): string[] {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return []
  }
  try {
    const json: unknown = JSON.parse(text)
    return patternsOf((json as { hiddenModels?: unknown } | null)?.hiddenModels)
  } catch {
    return []
  }
}

/** A pattern as a regex: `*` any run, the rest literal (a `?` is a question mark, not a wildcard),
 * the whole id, ignoring case. */
function globRe(pattern: string): RegExp {
  const body = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${body}$`, "i")
}

/** A model id as /model spells it: no `cursor/` prefix. */
const bare = (id: string) => (id.startsWith("cursor/") ? id.slice("cursor/".length) : id)

/** Whether any pattern hides this model id. Both the id and the pattern may carry `cursor/`, and a
 * pattern without the `@size` suffix hides every context size of that model. */
export function hidden(patterns: string[], id: string): boolean {
  const name = bare(id)
  const at = name.indexOf("@")
  const family = at < 0 ? name : name.slice(0, at)
  return patterns.some((p) => {
    const re = globRe(bare(p))
    return re.test(name) || re.test(family)
  })
}

/** The models a pattern list keeps, in order. No patterns keeps all of them. */
export function visible<T extends { id: string }>(models: readonly T[], patterns: string[]): T[] {
  if (!patterns.length) return [...models]
  return models.filter((m) => !hidden(patterns, m.id))
}
