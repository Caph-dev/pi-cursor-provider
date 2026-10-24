# pi-cursor-provider

Pi extension. Provider id: `cursor`. Each turn is one HTTP/2 `AgentService/Run`, then the connection is closed (magpie style): a new `http2.connect`, a heartbeat, and `NGHTTP2_CANCEL`. Tool calls leave through `CallDynamicTool` and end that Run. Pi runs the tool; the result is history on the next turn. The same Pi session and first user message keep a stable `conversation_id`.

Pi 扩展，provider id 为 `cursor`。每一回合单独建立一条 HTTP/2 `AgentService/Run`，心跳后以 `NGHTTP2_CANCEL` 关掉。工具经 `CallDynamicTool` 返回并结束这次 Run，由 Pi 执行，结果进入下一回合的历史。同一会话加上第一条用户消息对应稳定的 `conversation_id`。

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

## First version

This release has no usage dashboard and does not apply deferred usage from Cursor events. It also has no native Run continuation: a tool result always goes out as history on the next turn.

## Development

```bash
npm install
npm run check
npm test
```

`npm test` stays off the Cursor network. `codec.ts`, `run.ts`, `models.ts`, and `client.ts` keep their `// @ts-nocheck` magpie-port headers.

## License

MIT. The Run protocol comes from magpie [`packages/cursor`](https://github.com/magpie-community/plugins/tree/main/packages/cursor). Login patterns follow [pi-cursor](https://github.com/Rahularya01/pi-cursor).
