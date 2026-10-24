import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { clearPlanCache, fetchUsage, formatUsage, onDemandOf } from "../src/usage.ts"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  clearPlanCache()
})

const PERIOD = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage"
const PLAN = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo"
const HARD = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetHardLimit"
const BOT = "https://cursor.com/api/dashboard/get-sand-usage-status"

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

const tok = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 })

function install(reply: (url: string) => Response) {
  const seen: { url: string; method?: string; body?: unknown; redirect?: string }[] = []
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url)
    seen.push({ url: href, method: init?.method, body: init?.body, ...(init?.redirect ? { redirect: init.redirect } : {}) })
    return reply(href)
  }) as typeof fetch
  return seen
}

test("onDemandOf covers a fixed limit, an open limit, and a disabled limit", () => {
  assert.deepEqual(onDemandOf({ spendLimitUsage: { individualUsed: 123, limitType: "user" } }, { hardLimit: 10 }), {
    kind: "fixed",
    usedDollars: 1.23,
    limitDollars: 10,
  })
  assert.deepEqual(onDemandOf({ spendLimitUsage: { individualUsed: 500, limitType: "user" } }, { hardLimit: 2147483647 }), {
    kind: "unlimited",
    usedDollars: 5,
  })
  assert.deepEqual(onDemandOf({ spendLimitUsage: { individualUsed: 0, limitType: "user" } }, { hardLimit: 50, noUsageBasedAllowed: true }), {
    kind: "disabled",
    usedDollars: 0,
  })
  assert.deepEqual(
    onDemandOf(
      { spendLimitUsage: { individualUsed: 19855, limitType: "team", pooledLimit: "45120000", pooledUsed: 6334270 } },
      { hardLimit: 451200 },
    ),
    { kind: "fixed", usedDollars: 63342.7, limitDollars: 451200, mineDollars: 198.55 },
  )
})

test("fetchUsage reports Cursor Models, Other Models, Total, and the plan", async () => {
  const seen = install((url) => {
    if (url === PLAN) return Response.json({ planInfo: { planName: "Pro" } })
    if (url === PERIOD) {
      return Response.json({
        billingCycleEnd: "1792833042000",
        planUsage: { autoPercentUsed: 42, apiPercentUsed: 10, totalPercentUsed: 35 },
      })
    }
    return Response.json({})
  })
  const report = await fetchUsage(tok, ["grok-4.7", "claude-opus-5-5"])
  const at = new Date(1792833042000).toISOString()
  assert.equal(report.plan, "Pro")
  assert.deepEqual(
    report.windows.map(({ models, notModels, ...w }) => w),
    [
      { name: "Cursor Models", used: 42, resetsAt: at },
      { name: "Other Models", used: 10, resetsAt: at },
      { name: "Total", used: 35, resetsAt: at, aside: true },
    ],
  )
  const cursor = report.windows[0]
  const other = report.windows[1]
  assert.equal(cursor?.models?.includes("grok-4.7"), true)
  assert.equal(cursor?.models?.includes("claude-opus-5-5"), false)
  assert.equal(other?.notModels?.includes("grok-4.7"), true)
  assert.equal(other?.notModels?.includes("claude-opus-5-5"), false)
  assert.equal(formatUsage(report), `Plan: Pro\nCursor Models: 42% (resets ${at})\nOther Models: 10% (resets ${at})\nTotal: 35% (resets ${at})`)
  assert.equal(seen.some((r) => r.url === PERIOD && r.method === "POST" && r.body === "{}"), true)
})

test("GetPlanInfo is asked once per token inside the hour", async () => {
  let plans = 0
  install((url) => {
    if (url === PLAN) {
      plans++
      return Response.json({ planInfo: { planName: "Pro+" } })
    }
    return Response.json({ planUsage: { autoPercentUsed: 1, apiPercentUsed: 2, totalPercentUsed: 3 } })
  })
  const first = await fetchUsage(tok, [])
  const second = await fetchUsage(tok, [])
  assert.equal(first.plan, "Pro+")
  assert.equal(second.plan, "Pro+")
  assert.equal(plans, 1)
})

test("a fixed on-demand limit is its own window", async () => {
  install((url) => {
    if (url === PLAN) return Response.json({})
    if (url === HARD) return Response.json({ hardLimit: 10 })
    if (url === PERIOD) {
      return Response.json({
        billingCycleEnd: "1792833042000",
        planUsage: { autoPercentUsed: 100, apiPercentUsed: 100, totalPercentUsed: 100 },
        spendLimitUsage: { individualUsed: 123, limitType: "user" },
      })
    }
    return Response.json({})
  })
  const report = await fetchUsage(jwt({ exp: 1 }), [])
  const onDemand = report.windows.find((w) => w.name === "On-demand")
  assert.equal(onDemand?.display, "$1.23 / $10.00")
  assert.equal(onDemand?.used, 12.3)
  assert.equal(formatUsage(report).includes("On-demand: $1.23 / $10.00"), true)
})

test("a refused period is the HTTP status, with no windows", async () => {
  install(() => new Response("no", { status: 401 }))
  const report = await fetchUsage(jwt({ sub: "auth0|user_test" }), [])
  assert.equal(report.error, "Unauthorized")
  assert.deepEqual(report.windows, [])
  assert.equal(formatUsage(report), "Unauthorized")
})

test("Grok Bot is optional and sits ahead of Total", async () => {
  const access = jwt({ sub: "auth0|user_test" })
  install((url) => {
    if (url === PLAN) return Response.json({ planInfo: { planName: "Pro" } })
    if (url === BOT) return Response.json({ includedLimitZero: false, usagePercent: 42, nextResetTimestampUtc: "2030-01-08T00:00:00.000Z" })
    if (url === PERIOD) return Response.json({ planUsage: { autoPercentUsed: 12, apiPercentUsed: 34, totalPercentUsed: 20 } })
    return Response.json({})
  })
  const report = await fetchUsage(access, [])
  assert.deepEqual(
    report.windows.map((w) => w.name),
    ["Cursor Models", "Other Models", "Grok Bot", "Total"],
  )
  assert.equal(report.windows[2]?.used, 42)
  assert.equal(report.windows[2]?.aside, true)
})
