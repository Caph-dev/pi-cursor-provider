import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const src = fileURLToPath(new URL("../src/", import.meta.url))

const UNCHECKED = ["codec.ts", "ledger.ts", "models.ts", "native-session.ts"]

test("@ts-nocheck files stay on the allowlist", () => {
  const found = readdirSync(src)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => readFileSync(join(src, name), "utf8").includes("@ts-nocheck"))
    .sort()
  assert.deepEqual(found, [...UNCHECKED].sort())
})
