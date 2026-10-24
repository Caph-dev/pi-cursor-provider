/**
 * Cursor billing-period usage, as magpie's account card reads it.
 *
 * Ported from magpie's Cursor provider (MIT):
 * https://github.com/magpie-community/plugins/tree/main/packages/cursor
 * Plan lookup uses the shared Connect client. Period, hard limit, and Grok
 * Bot stay on their own fetches so a refused dashboard call is a report,
 * not a thrown request.
 */
import { STATUS_CODES } from "node:http"
import { API, unary } from "./client.ts"

export const WEBSITE = "https://cursor.com"

const PLAN_TTL = 3600_000
const plans = new Map<string, { plan: string; at: number }>()

export type UsageWindow = {
  name: string
  used: number
  resetsAt?: string
  display?: string
  aside?: boolean
  models?: string[]
  notModels?: string[]
  span?: number
}

export type UsageReport = { plan?: string; windows: UsageWindow[]; error?: string }

export type OnDemandKind = "fixed" | "unlimited" | "disabled" | "unavailable"

export type OnDemand = {
  kind: OnDemandKind
  usedDollars: number
  limitDollars?: number
  mineDollars?: number
}

type Spend = {
  individualUsed?: number
  individualLimit?: number
  limitType?: string
  pooledLimit?: string | number
  pooledUsed?: number
}

type Period = {
  billingCycleEnd?: string
  planUsage?: { autoPercentUsed?: number; apiPercentUsed?: number; totalPercentUsed?: number }
  autoBucketModels?: string[]
  spendLimitUsage?: Spend
}

type HardLimit = { hardLimit?: number; noUsageBasedAllowed?: boolean }

const statusText = (s: number) =>
  ({ 413: "Request Entity Too Large", 414: "Request URI Too Long", 416: "Requested Range Not Satisfiable", 418: "I'm a teapot", 509: "" })[s] ??
  STATUS_CODES[s] ??
  ""

const POOL_VARIANT = /-(fast|none|low|medium|high|xhigh|extra-high|max|thinking)$/

function poolBase(model: string) {
  model = String(model).trim().toLowerCase().replace(/@[^@]*$/, "")
  if (model.startsWith("cursor-")) model = model.slice("cursor-".length)
  for (;;) {
    const b = model.replace(POOL_VARIANT, "")
    if (b === model) return model
    model = b
  }
}

function firstParty(model: string) {
  model = model.replace(/@[^@]*$/, "")
  if (model.startsWith("cursor-")) model = model.slice("cursor-".length)
  if (model === "default" || model === "composer" || model.startsWith("composer-")) return true
  return ["grok-4.5", "grok-4.6", "grok-4.7"].some((b) => model === b || model.startsWith(b + "-"))
}

/** What Cursor still serves after included usage is spent. */
export function onDemandOf(data: { spendLimitUsage?: Spend } | undefined, hard: HardLimit | undefined): OnDemand {
  const s = data?.spendLimitUsage
  const usedDollars = Number(s?.individualUsed ?? 0) / 100
  const own =
    s?.individualLimit === undefined
      ? undefined
      : Number(s.individualLimit) > 0
        ? { kind: "fixed" as const, usedDollars, limitDollars: Number(s.individualLimit) / 100 }
        : { kind: "disabled" as const, usedDollars }
  if (s?.limitType === "team") {
    if (own) return own
    if (hard && (hard.noUsageBasedAllowed || !(Number(hard.hardLimit) > 0))) return { kind: "disabled", usedDollars }
    const pool = Number(s.pooledLimit ?? 0)
    if (pool > 0) return { kind: "fixed", usedDollars: Number(s.pooledUsed ?? 0) / 100, limitDollars: pool / 100, mineDollars: usedDollars }
    return hard ? { kind: "unlimited", usedDollars } : { kind: "unavailable", usedDollars }
  }
  if (!hard) return own ?? { kind: "unavailable", usedDollars }
  if (hard.noUsageBasedAllowed) return { kind: "disabled", usedDollars }
  const limit = Number(hard.hardLimit ?? 0)
  if (limit >= 2147483647) return { kind: "unlimited", usedDollars }
  return limit > 0 ? { kind: "fixed", usedDollars, limitDollars: limit } : { kind: "disabled", usedDollars }
}

async function hardLimit(tok: string): Promise<HardLimit | undefined> {
  try {
    const res = await fetch(API + "/aiserver.v1.DashboardService/GetHardLimit", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    })
    return res.ok ? ((await res.json()) ?? undefined) : undefined
  } catch {
    return undefined
  }
}

const dollars = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

async function periodUsage(tok: string, ids: string[]): Promise<UsageReport> {
  const [res, hard] = await Promise.all([
    fetch(API + "/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    }),
    hardLimit(tok),
  ])
  if (!res.ok) return { error: statusText(res.status), windows: [] }
  const data = (await res.json()) as Period
  const u = data?.planUsage
  if (!u) return { windows: [] }
  const ms = /^[+-]?\d+$/.test(data.billingCycleEnd ?? "") ? Number(data.billingCycleEnd) : 0
  const resets = ms > 0 ? { resetsAt: new Date(ms).toISOString() } : {}
  const bucket = new Set((data.autoBucketModels ?? []).map(poolBase))
  const inPool = (model: string) => {
    model = poolBase(model)
    if (model === "auto") model = "default"
    return bucket.has(model) || firstParty(model)
  }
  const asked = ids.flatMap((id) => [id, id.replace(/@[^@]*$/, "")])
  const pool = [...new Set(["auto", ...asked, ...(data.autoBucketModels ?? [])])].filter(inPool)
  const num = (v: unknown) => (typeof v === "number" ? v : 0)
  const od = onDemandOf(data, hard)
  const pooled = od.kind === "fixed" || od.kind === "unlimited" ? { aside: true } : {}
  const onDemand: UsageWindow[] =
    od.kind === "fixed" && od.limitDollars
      ? [
          {
            name: "On-demand",
            used: Math.max(0, Math.min(100, (100 * od.usedDollars) / od.limitDollars)),
            display: `${dollars(od.usedDollars)} / ${dollars(od.limitDollars)}` + (od.mineDollars === undefined ? "" : ` (you: ${dollars(od.mineDollars)})`),
            ...resets,
          },
        ]
      : od.kind === "unlimited"
        ? [{ name: "On-demand", used: 0, display: dollars(od.usedDollars), ...resets, aside: true }]
        : []
  return {
    windows: [
      { name: "Cursor Models", used: num(u.autoPercentUsed), ...resets, models: pool, ...pooled },
      { name: "Other Models", used: num(u.apiPercentUsed), ...resets, notModels: pool, ...pooled },
      ...onDemand,
      { name: "Total", used: num(u.totalPercentUsed), ...resets, aside: true },
    ],
  }
}

async function planOf(tok: string): Promise<string> {
  const had = plans.get(tok)
  if (had && Date.now() - had.at < PLAN_TTL) return had.plan
  try {
    const body = await unary(API, "aiserver.v1.DashboardService/GetPlanInfo", tok)
    const plan = String(body?.planInfo?.planName ?? "").trim()
    if (plan) plans.set(tok, { plan, at: Date.now() })
    return plan || had?.plan || ""
  } catch {
    return had?.plan ?? ""
  }
}

async function botUsage(tok: string): Promise<UsageWindow[]> {
  try {
    const subject = JSON.parse(Buffer.from(tok.split(".")[1] ?? "", "base64url").toString()).sub
    if (typeof subject !== "string") return []
    const user = subject.split("|").filter(Boolean).at(-1)
    if (!user || !/^[a-zA-Z0-9._-]+$/.test(user)) return []
    const res = await fetch(WEBSITE + "/api/dashboard/get-sand-usage-status", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: WEBSITE,
        Cookie: "WorkosCursorSessionToken=" + encodeURIComponent(user + "::" + tok),
      },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return []
    const data = (await res.json()) as {
      includedLimitZero?: boolean
      hasNonZeroIncludedLimit?: boolean
      sandTrialExpiresAt?: string
      usagePercent?: number
      nextResetTimestampUtc?: string
    }
    const paid = typeof data?.includedLimitZero === "boolean" ? !data.includedLimitZero : data?.hasNonZeroIncludedLimit === true
    const trial = !paid && typeof data?.sandTrialExpiresAt === "string" && Date.parse(data.sandTrialExpiresAt) > Date.now()
    if ((!paid && !trial) || typeof data?.usagePercent !== "number" || !Number.isFinite(data.usagePercent)) return []
    const reset = paid && typeof data.nextResetTimestampUtc === "string" ? Date.parse(data.nextResetTimestampUtc) : NaN
    return [
      {
        name: trial ? "Grok Bot (trial)" : "Grok Bot",
        used: Math.max(0, Math.min(100, data.usagePercent)),
        aside: true,
        ...(Number.isFinite(reset) ? { resetsAt: new Date(reset).toISOString(), span: 604800 } : {}),
      },
    ]
  } catch {
    return []
  }
}

/** Plan name plus the billing-period windows. GetPlanInfo is cached for about an hour per token. */
export async function fetchUsage(tok: string, modelIds: string[]): Promise<UsageReport> {
  const [u, plan, bot] = await Promise.all([periodUsage(tok, modelIds), planOf(tok), botUsage(tok)])
  const last = (w: UsageWindow) => w.name === "Total" || (w.name === "On-demand" && w.aside)
  const windows = [...u.windows.filter((w) => !last(w)), ...bot, ...u.windows.filter(last)]
  return { ...u, windows, ...(plan ? { plan } : {}) }
}

function percent(n: number) {
  if (!Number.isFinite(n)) return "0%"
  return `${Math.round(n * 100) / 100}%`
}

/** Text for `/cursor.usage`. */
export function formatUsage(report: UsageReport): string {
  if (report.error && report.windows.length === 0 && !report.plan) return report.error
  const lines: string[] = []
  if (report.plan) lines.push(`Plan: ${report.plan}`)
  for (const w of report.windows) {
    const body = w.display ?? percent(w.used)
    const reset = w.resetsAt ? ` (resets ${w.resetsAt})` : ""
    lines.push(`${w.name}: ${body}${reset}`)
  }
  if (report.error) lines.push(report.error)
  if (!lines.length) return "No Cursor usage was reported."
  return lines.join("\n")
}

export function clearPlanCache() {
  plans.clear()
}
