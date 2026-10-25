# Repository Guidelines

## Project Overview

`@caph42/pi-cursor-provider` is a Pi extension that registers provider id `cursor`. One turn is one Cursor `AgentService/Run`: HTTP/2 by default, HTTP/1.1 `RunSSE` + `BidiAppend` when HTTP/2 cannot open. A Run may stay open in this process for native continuation; otherwise it is stateless and closes after returning tools.

Published as **raw TypeScript** (`main` and `pi.extensions` both point at `src/index.ts`). There is no build step, bundler, or emitted JS. Behavior is ported from magpie's Cursor provider / pi-cursor (MIT); keep upstream provenance headers and issue references.

## Architecture & Data Flow

```text
Pi host
  src/index.ts            registers provider "cursor", catalogue lifecycle, /cursor.usage, doctor
    ├─ auth.ts            credential discovery, PKCE login, refresh_token grant
    ├─ models.ts/config.ts catalogue -> pi model configs -> cursor.json hide rules
    ├─ fast.ts            /cursor.fast, status row, footer adapter, stream wrapper
    ├─ doctor.ts          /cursor.doctor (read-only state probe, never prints tokens)
    └─ usage.ts           /cursor.usage (plan windows, on-demand)

stream/streamSimple == fast.stream
  └─ pi-stream.ts streamCursor / pump
       └─ run.ts runAnswer
            ├─ auth.resolveAccessToken (per request)
            ├─ models.usable -> request/pick (variant, effort, max mode, fast)
            ├─ endpoint.ts agentURL (GetServerConfig, 10 min TTL)
            ├─ native-session.ts prepare (resume only if one live owner matches every call id)
            └─ agent-run.ts startRun/resumeRun
                 ├─ transport.ts open (h2, or sticky h1 fallback)
                 ├─ protocol.ts buildRun / decode / exec
                 ├─ codec.ts protobuf + Connect framing + status normalization
                 └─ ledger.ts deferred dashboard usage (magpie_deferred)
```

Key flows:

- **Transport:** h2 failures at the HTTP/2 layer pin HTTP/1.1 process-wide for 10 minutes (`resetH1()` clears). Connection failures (`ECONNREFUSED`, DNS) do not pin. Regional refusal refreshes the agent URL and retries once after clearing stickiness. `Max Mode Required` retries once and memoizes the model id (`maxOnly`).
- **Native continuation:** call ids are `call_cursor_<hex>_<seg>_<i>`. Resume requires a live owner, matching sealed history, and an idle, unexpired owner. Otherwise a stateless Run receives the results as history. A submitted native result is never replayed; `retentionIneligible` is the only sanctioned fallback and is withheld after submission.
- **Catalogue:** complete catalogue is cached per credential (`sha256(token)`), published with `{ persist }`, filtered synchronously by `cursor.json` on every read. `session_start` refresh is backgrounded in TUI mode (must not delay footer paint) and awaited headless. Superseded sessions are guarded by a generation counter; touching a retired `ctx` throws.
- **Usage:** `prompt_tokens` is this step's own Run only. Late events for earlier steps surface as `usage.magpie_deferred` and must never be folded into context size. `magpie_native.accounting = pending | estimated | replayed` marks estimates.
- **Auth precedence:** `CURSOR_ACCESS_TOKEN` → passed api key → Pi stored OAuth → cursor-agent `auth.json` → macOS keychain → Cursor IDE sqlite. The access token is read, never written; renewal uses the stored `refresh_token`.

Dependency direction: leaves (`config`, `cache`, `sleep`, `client`, `trace`) → `codec`/`native-session` → `transport`/`protocol`/`ledger`/`endpoint`/`models`/`usage` → `agent-run` → `run` → `pi-stream`/`fast` → `index`/`doctor`. Avoid new cycles; `codec` must stay on `node:http`/`node:zlib` only.

## Key Directories

| Path | Purpose |
| --- | --- |
| `src/` | Entire implementation, flat module namespace, no subdirectories. Only shipped code. |
| `test/` | Flat Node test files (`test/*.ts`), no subdirectories or shared helpers. Not published. |
| `.github/workflows/ci.yml` | Typecheck + tests on Node 22/24; manual live e2e job. |
| `.audit/issues.tsv` | Human/agent decision log (TSV). Not referenced by code, tests, or CI. |
| `README.md`, `CHANGELOG.md` | User-facing behavior and release notes; both shipped. No `scripts/` or `docs/` directory. |

## Development Commands

```bash
npm install
npm run check          # tsc --noEmit (src + test)
npm test               # node --experimental-strip-types --test test/*.ts
node --experimental-strip-types --test test/config.ts   # one file
CURSOR_E2E=1 npm run test:e2e                           # live Cursor account
npm run prepublishOnly                                  # check && test
```

Install into Pi: `pi install npm:@caph42/pi-cursor-provider`, or `pi install ./path/to/pi-cursor-provider` from a checkout. After updating an npm install, `/reload` once. Do not run e2e routinely; it spends real account tokens.

## Code Conventions & Common Patterns

- **Style:** 2-space indent, double quotes, no semicolons, trailing commas. No ESLint/Prettier/Biome config; `tsc --noEmit` is the only static gate. Match surrounding files.
- **Module syntax:** pure ESM, NodeNext. Relative imports MUST include `.ts` (`import { visible } from "./config.ts"`). Use `import type` for types. Code must stay **erasable-syntax only** (no `enum`, `namespace`, parameter properties, decorators) because Node strips types at runtime.
- **Return error unions, do not throw across the provider boundary:** `RunResult` / `RunAnswerResult` are `{ error, ... } | { conversationId, events }`. Convert to Pi `{ type: "error" }` events at the stream edge.
- **Normalize Cursor failures centrally:** `failure(status, text)` → `statusOf(...)` in `codec.ts`. Never hand-write status mapping elsewhere. HTTP errors must not echo response bodies.
- **Abort discipline:** check `signal?.aborted` after every awaited step and return a cancelled result; do not throw. `cancelledOpen()` is the canonical 410. Attach abort listeners only when needed and remove them (`sleep` is tested for zero residual listeners).
- **Tracing:** every decision is `trace?.note("<kind>", {...})`. The optional chain is mandatory (`test/trace-gate.ts` scans for `trace.note(`). New kinds must be added to both `Decision` and the parser table. Journal is off unless `CURSOR_DEBUG` is truthy at module load.
- **Secrets:** never print tokens, authorization headers, token hashes, or URL paths. Use `hostOf(url)` and `Account` (`"[account]"`). Diagnostics must remain read-only.
- **Cache idiom:** key every store by `tokenKey(token)` (SHA-256), value stamped with `expires`; use `recall`/`store` from `cache.ts`. `CACHE_CAP = 100`, insertion-order eviction. Never key by the raw token.
- **State exposure:** each module-level store has a read-only `*State()` / `*Keys()` accessor for `/cursor.doctor` and tests. Adding a global store requires a `clear*()` hook, or tests leak across cases.
- **Catalogue publishing:** mutate `offered` inside the `ctx.publish({ update })` closure; always call `fast.catalogueChanged()` there. Persist complete (unfiltered) models; filter on read.
- **Timers:** always `unref()` heartbeats, deadlines, and polling timers. Heartbeats are protocol messages (empty field-7 every 5 s; native also re-sends unanswered execs every 3 s), not optional keepalive.
- **Fast mode:** session-scoped, persisted via `pi.appendEntry("cursor-fast", { model, enabled })`, replayed from the session branch. Apply only when `options.sessionId === sessionId`. A fast variant must exist at the same context/effort. Native continuations are rebuilt, not resumed, when fast changes.
- **Footer ownership:** publish `ctx.ui.setStatus("cursor-fast", text)` unconditionally, filter that key out of Cursor's own footer, and yield the custom-footer slot if another extension takes it. Never fight for ownership.
- **`@ts-nocheck` allowlist:** exactly `codec.ts`, `ledger.ts`, `models.ts`, `native-session.ts`. `npm run check` is blind there, so changes need extra reasoning/tests. The ratchet is exact set equality—adding or removing a pragma fails tests until both the file and `test/nocheck-ratchet.ts` change.
- **Tool mediation:** Pi is the only tool executor. Cursor-owned tools get a `"not available"` reply (`protocol.ts` `exec`); never add a passthrough. Tool catalog text must stay escaped.
- **Preserve protocol comments:** comments cite upstream issues/PRs and explain wire decisions; do not delete them as noise.

## Important Files

| File | Role |
| --- | --- |
| `src/index.ts` | Extension entry. Provider object (`getModels`, `filterModels`, auth, `refreshModels`, `stream`), catalogue generation/retire, `/cursor.usage`. |
| `src/run.ts` | `runAnswer`, region/max-mode retries, `runState`, `maxOnly` memo. |
| `src/agent-run.ts` | One stateless or native Run: ledger, heartbeat, open/send/decode, native accounting hooks. |
| `src/protocol.ts` | Chat → Cursor conversation, `buildRun`, frame decode, `exec` bridge, `conversationID`. |
| `src/native-session.ts` | Native owner pool, strict protobuf validation, result matching, limits (8/account, 32/process), checkpoints. |
| `src/transport.ts` | h2 `AgentService/Run` vs h1 `RunSSE` + `BidiAppend`, stickiness, `resetH1`. |
| `src/codec.ts` | Hand-written protobuf, Connect framing, error/status normalization. |
| `src/ledger.ts` | Deferred usage debt, waits, unreadable accounts; `STEP_WAIT` timings. |
| `src/models.ts` | Catalogue fetch, variant/effort/max-mode resolution, `supportsFast`, `piModelConfigs`. |
| `src/pi-stream.ts` | Cursor events → Pi `AssistantMessageEventStream`; usage/cost mapping. |
| `src/fast.ts` | `/cursor.fast` command, state, footer install, stream wrapper. |
| `src/auth.ts` | Credential sources, PKCE login, refresh grant. |
| `test/nocheck-ratchet.ts`, `test/trace-gate.ts` | Source-scanning policy gates. |
| `test/e2e-live.ts` | Live-account assertions; skipped unless `CURSOR_E2E=1`. |

## Runtime/Tooling Preferences

- **Node.js >= 22** (CI: 22 and 24). Node 22 is required for native type stripping, `node:sqlite`, and `AbortSignal.any`.
- **npm** only (`package-lock.json`, CI uses `npm ci`). No pnpm/yarn/Bun artifacts.
- **No runtime dependencies.** Pi peers (`@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui`) are supplied by the host; devDeps pin them at `1.4.0`. The footer adapter hard-gates on Pi `1.4.x` and yields otherwise.
- Network: global `fetch` for Connect JSON/dashboard calls, `node:http2` for Runs. Tests must not assume sockets.
- Environment knobs: `CURSOR_ACCESS_TOKEN`, `CURSOR_DEBUG=1`, `CURSOR_E2E=1`, `PI_OFFLINE` (skip network catalogue refresh), `PI_CODING_AGENT_DIR` (locates `cursor.json`, else `~/.pi/agent/cursor.json`).
- Release is manual `npm publish`; `prepublishOnly` enforces check + tests. Update `CHANGELOG.md` (`## x.y.z` with `-` bullets) and use Conventional Commit subjects (`fix(scope):`, `feat(scope):`, `test(scope):`, `docs(scope):`, `ci:`).

## Testing & QA

- **Framework:** Node's built-in runner with type stripping. Flat `test("<lowercase behavior sentence>", async () => ...)`; no `describe`, no shared helpers, no `.test.ts` suffix. Each file declares its own fixtures.
- **Assertions:** `node:assert/strict`. Assert exact user-facing strings with anchored regexes (notices, footer rows, doctor lines) and use `assert.doesNotMatch` for token/hash/path leaks.
- **Hermetic by default:** stub `globalThis.fetch`, `http2.connect`, or `net.Socket.prototype.connect`; restore in `finally`/`afterEach`. Use `mkdtempSync` + `PI_CODING_AGENT_DIR` for filesystem tests. Only `e2e-live.ts` is live. `cli-reload.ts` spawns the real Pi CLI with sockets forbidden.
- **Global state resets are mandatory within a file:** `clearLedger()`, `clearPlanCache()`, `clearAgentCache()`, `clearMaxOnly()`, `resetH1()`, `nativeSessions.clear()`, `traceForTests(false)`, and restore env vars.
- **Control time, do not sleep:** shrink `STEP_WAIT` (`Object.assign(STEP_WAIT, { first: 0, every: 5, until: 40 })`), mock `Date.now`, and flush with `setImmediate` / bounded polling.
- **Policy gates:** `nocheck-ratchet.ts` enforces the exact `@ts-nocheck` set; `trace-gate.ts` enforces optional-chained trace calls. Both are behavior-independent and must be updated deliberately.
- **Coverage expectations:** new behavior needs an offline test for the invariant or edge that could plausibly break (fallback reason, retry suppression, cache/credential isolation, abort cleanup, redaction). Do not test wiring, forwarding, or tautologies. Prefer table-driven cases for error taxonomies (`test/native-errors.ts`, `test/transport-fallback.ts`).
- **Done means:** `npm run check && npm test` passes, plus a targeted smoke path for runtime changes (`/cursor.doctor`, a fake Run, or the CLI reload harness). CI runs exactly those two gates on Node 22 and 24; live e2e is manual.
