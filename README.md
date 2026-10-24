# pi-cursor-provider

Pi extension. Provider id: `cursor`. A turn is one `AgentService/Run` (HTTP/2, with HTTP/1.1 RunSSE + BidiAppend when HTTP/2 cannot open).

When this process still holds that Run, and the next turn's tool results use ids of the form `call_cursor_<hex>_<seg>_<i>`, those results are written to the open Run. If that owner is gone, the turn opens a new Run and sends the results as history. A stateless Run still closes after it returns tools. The same Pi session and the first user message keep a stable `conversation_id`.

Pi 扩展，provider id 为 `cursor`。每一回合是一条 `AgentService/Run`（默认 HTTP/2；HTTP/2 打不开时走 HTTP/1.1 的 RunSSE + BidiAppend）。同一进程仍持有这条 Run，且下一回合的工具结果 id 为 `call_cursor_<hex>_<seg>_<i>` 时，结果写回这条未关闭的 Run。找不到 owner 时退回新的 Run，把结果放进历史。无主的 Run 在返回工具后仍会关闭。同一会话加上第一条用户消息对应稳定的 `conversation_id`。

## Install

Node.js ≥ 22. This package peers `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` (Pi already provides them).

```bash
pi install npm:pi-cursor-provider
```

From a local checkout, install or link that directory:

```bash
pi install ./path/to/pi-cursor-provider
```

Leave `@rahularya01/pi-cursor` and `cursor-for-pi` disabled. Those packages register the same provider id, `cursor`.

## Sign in

Use one of these. `/cursor.doctor` reports which source matched and does not print the token.

1. `/login cursor` — browser PKCE, stored as Pi OAuth.
2. Environment variable `CURSOR_ACCESS_TOKEN`.
3. An existing cursor-agent `auth.json` (`accessToken` is read, never written):
   - macOS: `~/.cursor/auth.json`
   - Windows: `%APPDATA%/Cursor/auth.json`
   - Linux and others: `$XDG_CONFIG_HOME/cursor/auth.json`, or `~/.config/cursor/auth.json`
4. macOS keychain item `cursor-access-token`.
5. Cursor IDE state (`state.vscdb`, key `cursorAuth/accessToken`).

Then select a model:

```text
/model cursor/<id>
```

## How this relates to other Cursor packages

| Package | Role |
| --- | --- |
| `@rahularya01/pi-cursor` | Pi provider that keeps a long-lived HTTP/2 bridge, with checkpoint resume and a run journal. |
| `cursor-for-pi` | The same per-turn AgentService/Run protocol. `pi-cursor-provider` is that port under the magpie-aligned package name. |
| `@magpie-community/opencode-cursor-auth` | Cursor auth and Run for the OpenCode / magpie host. This package speaks Pi `streamSimple`. |

## Usage

`/cursor.usage` prints the plan and the billing-period windows. The command reads the same credential as `/cursor.doctor`. If nothing is signed in, it warns and does not print a token.

The same report is exported from the package.

```ts
import { fetchUsage, formatUsage, onDemandOf } from "pi-cursor-provider"
```

`fetchUsage(token, modelIds)` returns `{ plan?, windows, error? }`. `formatUsage` turns that into the text the command shows. `onDemandOf` reads a period payload and a hard-limit payload into `fixed`, `unlimited`, `disabled`, or `unavailable`.

Windows follow magpie, in this order.

- Cursor Models
- Other Models
- On-demand, when the account has a dollar limit or an open on-demand spend
- Grok Bot, or Grok Bot (trial), when the dashboard reports that allowance
- Total

Grok Bot is placed before an On-demand window that has no limit, and after one that has a limit. Total stays last.

```text
Plan: Pro
Cursor Models: 42% (resets 2026-11-01T00:00:00.000Z)
Other Models: 10%
On-demand: $1.23 / $10.00
Total: 35%
```

### Step usage (deferred ledger)

A finished Run reports token counts from `TurnEnded` when Cursor sends them. A tool step has no `TurnEnded` until results return on the same Run: after the Run closes, this package reads the dashboard's usage events (`GetFilteredUsageEvents`) by `conversation_id`, as magpie does.

Far from Cursor the event can land after the short poll. That step then reports 0 used and the conversation owes the event. Later steps collect it in the background. What a step collected of earlier steps is not added to its own `prompt_tokens` (Pi reads that as context fill); it is `usage.magpie_deferred` (`prompt_tokens`, `completion_tokens`, `cached_tokens`, `cache_write_tokens`). Pi ignores that field for context size.

A step that ends the turn waits for remaining debt. After three misses in a row for an account, steps stop waiting (retrying every tenth). Unreadable accounts (4xx on the events API) fall back to the previous estimate. Native finals also settle earlier debt into `magpie_deferred`, separately from the last call's share of `TurnEnded`.

## Native Run continuation

A native Run stays open in this process when the model returns tools. Each call id is `call_cursor_<hex>_<seg>_<i>`. The next turn in the same process resumes that Run and writes the matching tool results to it.

Resume happens only when every id in the trailing tool-result batch belongs to one live owner, and the history still matches that batch. Any of these opens a new stateless Run instead, and sends the results as history.

- The id is not a live handle.
- The process restarted, so the owner is gone.
- The history does not match the sealed batch.
- The owner is busy, expired, or near its lifetime deadline.

The stateless path still cancels the stream after tools. The native path does not.

## Transport

- Default: HTTP/2 `AgentService/Run` at the agent host from `ServerConfigService/GetServerConfig` (else the global agent URL).
- When HTTP/2 cannot open (no response head in 15s, ALPN / "h2 is not supported" / HTTP/2 protocol errors), the Run goes as Cursor's clients do without HTTP/2: `AgentService/RunSSE` down and `BidiService/BidiAppend` up over HTTP/1.1 on `api2.cursor.sh`. Blocked HTTP/2 keeps later Runs on HTTP/1.1 for 10 minutes; a plain connection failure leaves the next Run to try HTTP/2 again.
- A regional refusal refreshes GetServerConfig and retries once when the agent URL changed (or the failed attempt was already on HTTP/1.1). That refresh clears the HTTP/1.1 stickiness so the region's agent host can use HTTP/2 again.
- "Max Mode Required" retries once with Max Mode and remembers that model id for the process.

## Known gaps

Compared with magpie [`packages/cursor`](https://github.com/magpie-community/plugins/tree/main/packages/cursor), this package still does not include:

- Parked long-lived HTTP/2 bridge, checkpoint resume, and run journal (that is `@rahularya01/pi-cursor`'s model; this package stays per-turn Run + optional same-process native continuation).
- OpenCode chat-completions adapter surface (`X-Magpie-Cursor-Continuity` headers, AI SDK message shapes beyond what Pi `streamSimple` needs).
- Multi-account switching; web search and other Cursor-owned tools (refused like magpie).
- Client-side context compaction / summarization when the window fills (Pi or the host may compact before calling; this provider only maps Cursor's "input is too long" / context-length errors, same as magpie).
- Full empty-reply diagnostics (`emptyWhy` field inventory) and some magpie-only decode edge reporting.
- Browser / API-key exchange login paths that magpie implements for OpenCode (Pi uses `/login cursor` and the credential sources above).

## Development

```bash
npm install
npm run check
npm test
CURSOR_E2E=1 npm run test:e2e
```

`npm test` stays off the Cursor network (fetch is mocked where the dashboard is involved). `npm run test:e2e` hits a real Cursor account (cursor-agent `auth.json`, `CURSOR_ACCESS_TOKEN`, or `/login cursor`) and never prints the token. `codec.ts`, `run.ts`, `models.ts`, `client.ts`, `ledger.ts`, and `native-session.ts` keep their `// @ts-nocheck` magpie-port headers.

## License

MIT. The Run protocol comes from magpie [`packages/cursor`](https://github.com/magpie-community/plugins/tree/main/packages/cursor). Login patterns follow [pi-cursor](https://github.com/Rahularya01/pi-cursor).
