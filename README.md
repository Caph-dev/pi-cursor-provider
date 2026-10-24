# pi-cursor-provider

Pi extension. Provider id: `cursor`. A turn is one HTTP/2 `AgentService/Run`.

When this process still holds that Run, and the next turn's tool results use ids of the form `call_cursor_<hex>_<seg>_<i>`, those results are written to the open Run. If that owner is gone, the turn opens a new Run and sends the results as history. A stateless Run still closes after it returns tools. The same Pi session and the first user message keep a stable `conversation_id`.

Pi 扩展，provider id 为 `cursor`。每一回合是一条 HTTP/2 `AgentService/Run`。同一进程仍持有这条 Run，且下一回合的工具结果 id 为 `call_cursor_<hex>_<seg>_<i>` 时，结果写回这条未关闭的 Run。找不到 owner 时退回新的 Run，把结果放进历史。无主的 Run 在返回工具后仍会关闭。同一会话加上第一条用户消息对应稳定的 `conversation_id`。

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

A finished Run still reports token counts from TurnEnded when Cursor sends them. This package does not keep magpie's deferred step-usage ledger.

## Native Run continuation

A native Run stays open in this process when the model returns tools. Each call id is `call_cursor_<hex>_<seg>_<i>`. The next turn in the same process resumes that Run and writes the matching tool results to it.

Resume happens only when every id in the trailing tool-result batch belongs to one live owner, and the history still matches that batch. Any of these opens a new stateless Run instead, and sends the results as history.

- The id is not a live handle.
- The process restarted, so the owner is gone.
- The history does not match the sealed batch.
- The owner is busy, expired, or near its lifetime deadline.

The stateless path still cancels the HTTP/2 stream after tools. The native path does not.

## Development

```bash
npm install
npm run check
npm test
```

`npm test` stays off the Cursor network. `codec.ts`, `run.ts`, `models.ts`, `client.ts`, and `native-session.ts` keep their `// @ts-nocheck` magpie-port headers.

## License

MIT. The Run protocol comes from magpie [`packages/cursor`](https://github.com/magpie-community/plugins/tree/main/packages/cursor). Login patterns follow [pi-cursor](https://github.com/Rahularya01/pi-cursor).
