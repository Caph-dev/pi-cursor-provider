import assert from "node:assert/strict"
import test from "node:test"
import { refresh } from "../src/auth.ts"

const REFRESH_URL = "https://api2.cursor.sh/oauth/token"

/** A session JWT with `exp` in seconds. The signature is never checked. */
function session(exp: number): string {
  const claims = { sub: "google-oauth2|user_1", exp }
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`
}

function stubFetch(answer: () => Response) {
  const original = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return Promise.resolve(answer())
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

test("a stored login renews with the IDE's refresh_token grant", async () => {
  // One exp, so the assertion cannot straddle a second boundary.
  const exp = Math.floor(Date.now() / 1000) + 3600
  const next = session(exp)
  const stub = stubFetch(() => Response.json({ access_token: next, refresh_token: "rotated-session" }))
  try {
    const credential = await refresh({ access: "expired-session", refresh: "stored-session", expires: 0 })
    assert.equal(stub.calls.length, 1)
    const [call] = stub.calls
    assert.equal(call?.url, REFRESH_URL)
    assert.equal(call?.init?.method, "POST")
    assert.deepEqual(JSON.parse(String(call?.init?.body)), {
      grant_type: "refresh_token",
      client_id: "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB",
      refresh_token: "stored-session",
    })
    assert.equal(credential.access, next)
    assert.equal(credential.refresh, "rotated-session")
    assert.equal(credential.expires, exp * 1000 - 5 * 60 * 1000)
  } finally {
    stub.restore()
  }
})

test("a renewal that rotates nothing keeps the stored refresh token", async () => {
  const stub = stubFetch(() => Response.json({ access_token: session(Math.floor(Date.now() / 1000) + 3600) }))
  try {
    const credential = await refresh({ access: "old", refresh: "stored-session", expires: 0 })
    assert.equal(credential.refresh, "stored-session")
  } finally {
    stub.restore()
  }
})

test("the request carries no bearer credential and no client headers", async () => {
  const stub = stubFetch(() => Response.json({ access_token: session(Math.floor(Date.now() / 1000) + 3600) }))
  try {
    await refresh({ access: "old-access", refresh: "stored-session", expires: 0 })
    const headers = (stub.calls[0]?.init?.headers ?? {}) as Record<string, string>
    assert.deepEqual(headers, { "Content-Type": "application/json" })
    assert.equal(String(stub.calls[0]?.init?.body).includes("old-access"), false)
  } finally {
    stub.restore()
  }
})

test("a session Cursor will not renew asks for a new login", async () => {
  // Cursor ends a session with 200, no token, and shouldLogout.
  const stub = stubFetch(() => Response.json({ access_token: "", shouldLogout: true }))
  try {
    await assert.rejects(refresh({ access: "old", refresh: "dead-session", expires: 0 }), /\/login cursor/)
  } finally {
    stub.restore()
  }
})

test("a renewal without an access token is an error", async () => {
  const stub = stubFetch(() => Response.json({ refresh_token: "rotated-session" }))
  try {
    await assert.rejects(refresh({ access: "old", refresh: "stored-session", expires: 0 }), /no access token/)
  } finally {
    stub.restore()
  }
})

test("a renewal that is not JSON is an error", async () => {
  const stub = stubFetch(() => new Response("<html>", { status: 200 }))
  try {
    await assert.rejects(refresh({ access: "old", refresh: "stored-session", expires: 0 }), /no access token/)
  } finally {
    stub.restore()
  }
})

for (const status of [400, 401, 429, 500]) {
  test(`HTTP ${status} reports the status and never the body`, async () => {
    const stub = stubFetch(() => new Response("error=invalid_grant session=stored-session", { status }))
    try {
      await assert.rejects(refresh({ access: "old", refresh: "stored-session", expires: 0 }), (error: Error) => {
        assert.match(error.message, new RegExp(`HTTP ${status}`))
        assert.equal(error.message.includes("stored-session"), false)
        assert.equal(error.message.includes("invalid_grant"), false)
        return true
      })
    } finally {
      stub.restore()
    }
  })
}

test("a credential with no refresh token sends nothing", async () => {
  const stub = stubFetch(() => Response.json({ access_token: session(Math.floor(Date.now() / 1000) + 3600) }))
  try {
    await assert.rejects(refresh({ access: "old", refresh: "", expires: 0 }), /\/login cursor/)
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test("the host's refresh signal reaches the request", async () => {
  const stub = stubFetch(() => Response.json({ access_token: session(Math.floor(Date.now() / 1000) + 3600) }))
  const host = AbortSignal.timeout(10_000)
  try {
    await refresh({ access: "old", refresh: "stored-session", expires: 0 }, host)
    assert.equal(stub.calls[0]?.init?.signal, host)
  } finally {
    stub.restore()
  }
})
