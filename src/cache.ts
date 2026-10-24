import { createHash } from "node:crypto"

export const CACHE_CAP = 100

export function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

type Stamped = { expires: number }

export function recall<T extends Stamped>(map: Map<string, T>, key: string, now = Date.now()): T | undefined {
  const hit = map.get(key)
  if (!hit) return undefined
  if (now >= hit.expires) {
    map.delete(key)
    return undefined
  }
  return hit
}

export function store<T extends Stamped>(
  map: Map<string, T>,
  key: string,
  value: T,
  ttl: number,
  now = Date.now(),
): void {
  for (const [stored, entry] of map) {
    if (now >= entry.expires) map.delete(stored)
  }
  map.delete(key)
  map.set(key, { ...value, expires: now + ttl })
  while (map.size > CACHE_CAP) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}
