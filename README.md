# @caph42/pi-cursor-provider

Pi extension. Provider id: `cursor`. A turn is one `AgentService/Run` (HTTP/2, with HTTP/1.1 RunSSE + BidiAppend when HTTP/2 cannot open).

When this process still holds that Run, and the next turn's tool results use ids of the form `call_cursor_<hex>_<seg>_<i>`, those results are written to the open Run. If that owner is gone, the turn opens a new Run and sends the results as history. A stateless Run still closes after it returns tools. The same Pi session and the first user message keep a stable `conversation_id`.

Pi 扩展，provider id 为 `cursor`。每一回合是一条 `AgentService/Run`（默认 HTTP/2；HTTP/2 打不开时走 HTTP/1.1 的 RunSSE + BidiAppend）。同一进程仍持有这条 Run，且下一回合的工具结果 id 为 `call_cursor_<hex>_<seg>_<i>` 时，结果写回这条未关闭的 Run。找不到 owner 时退回新的 Run，把结果放进历史。无主的 Run 在返回工具后仍会关闭。同一会话加上第一条用户消息对应稳定的 `conversation_id`。

## Install

Node.js ≥ 22. This package peers `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` (Pi already provides them).

```bash
pi install npm:@caph42/pi-cursor-provider
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

`/login cursor` stores a Pi OAuth credential. Renewal follows the Cursor IDE: a `refresh_token` grant at `api2.cursor.sh/oauth/token` with the stored refresh token, not the access token. When Cursor ends the session, the next turn asks you to run `/login cursor` again.

Then select a model:

```text
/model cursor/<id>
```

## Hide models

`/model` lists every model Cursor offers the account. To shorten it, put `cursor.json` beside Pi's config (`$PI_CODING_AGENT_DIR/cursor.json`, else `~/.pi/agent/cursor.json`):

```json
{ "hiddenModels": ["claude-*", "gpt-5", "cursor/gpt-5-mini"] }
```

The extension registers a native Pi provider. Its synchronous model directory and availability filter read `cursor.json`, so local rules apply even when Cursor cannot refresh its remote catalogue. The availability filter also covers models added through `models.json`.

Successful discovery saves the complete catalogue in Pi's `models-store.json`. Startup and `/reload` restore that catalogue before applying the current hide rules; a session-start refresh discovers models when no cache exists. In the TUI that refresh runs in the background, so the session opens without waiting for the network and the fast badge or a failure notice arrives when it lands; headless hosts await it. Offline mode restores the cache without fetching. A failed remote refresh keeps the previous catalogue, and a first-load failure is reported instead of silently returning an empty list.

A pattern matches the whole id `/model` shows (the part after `cursor/`), ignoring case. `*` stands for any run of characters; every other character, `?` included, is literal. A pattern without the `@300k` size suffix hides every context size of that model. A missing or malformed file hides nothing, and `/cursor.doctor` prints the patterns in force. Reopen `/model` and let its catalogue refresh finish to see the new list. After updating the extension itself, run `/reload` once. When developing from a checkout, configure that local path as the package source; `/reload` reloads configured sources and does not copy checkout changes into an npm installation.

Hidden models are removed from the live provider directory, so normal directory lookups no longer resolve their ids. A session already running on a hidden model keeps it; resuming one may require selecting another model. `/cursor.usage` still classifies usage by every model the account has.

Pi keeps a separate scoped model list (`/scoped-models`, `enabledModels`, or `--models`). Its picker can retain previously scoped model objects independently of the provider directory. If a hidden model still appears under **scoped**, remove it with `/scoped-models` and update any matching scope patterns. Provider filtering cannot remove those saved references through the public extension API.

If resume must keep working for the scoped-away models, Pi's own `enabledModels` setting scopes `/model` without removing anything from the registry: `{ "enabledModels": ["cursor/*sonnet*"] }` opens the picker on that scope, and Tab still reaches the rest.

## Unified subscription

An account on Cursor's merged (unified) subscription — one weekly allowance billed through xAI's own commerce — is still served the whole picker, but the plan's included usage covers only part of it. This package offers the ids that allowance reports as covered and leaves the rest out of `/model`. Sampled against a live X unified account: a Run on two of the excluded models was refused with `429 … is not included in your weekly usage: Buy credits or switch to a Grok model`; the other excluded ones were not each exercised.

`GetPlanInfo`'s `isMerged` decides whether the filter runs at all; the current period's `autoBucketModels` names the ids the included usage pays for. An entry is offered when the id a Run at its default parameters resolves to is one of them, which is why an included effort can carry its family and an excluded default does not. Cursor's own plans filter nothing, and neither does a plan or period report that cannot be read.

Measured on that account: 6 of 65 entries stayed (auto, Grok 4.7 at two context sizes, Grok 4.6, Grok 4.5, Composer 2.5). Whether buying credits makes an excluded model run is not established here — the reports above name covered ids only, so this package cannot tell an account's credits apart from its plan, and does not try.

To offer every model Cursor lists, write `{ "showAllModels": true }` to `cursor.json` (see [Hide models](#hide-models)). The setting is applied when the catalogue is read, so it needs no refresh, and it skips the plan lookups altogether. The stored catalogue always stays complete: only what this provider offers is narrowed.

Plan facts are cached for an hour per credential. The catalogue keeps the covered ids with it, so a plan change reaches `/model` on the next refresh or `/reload`.

## Model metadata

Each model entry carries what Pi needs to route a turn correctly:

- `contextWindow` comes from Cursor's own picker: one entry per context size a model offers (`@256k`, `@500k`), else the model's token limit. Models the picker gives no size for fall back to 200k.
- Thinking levels come from the model's `effort` parameter, mapped onto Pi's `off`…`max` levels; a model with only a `thinking` switch becomes `off`/`high`.
- `maxTokens` comes from [models.dev](https://models.dev/api.json), matched by model id and taken as the limit most providers report, one vote per provider. It is never larger than the entry's context window, so a small-context entry also gets a small answer budget; a model models.dev does not list, such as Cursor's own Composer, keeps a 32k fallback. Pi clamps the value to the room left in the context before a request, so a generous limit only costs accuracy when it is too small.
- `input` is `text` and `image` for every model. Cursor's `supportsImages` flag under-reports image support for the models sampled: it says `false` for Grok 4.7 and Composer 2.5, yet both described a real 512×396 photograph in detail (a black-and-white panda meme with a photoshopped human face), as did Grok 4.6 and Grok 4.5. The samples cover those entries, not the whole catalogue, and declaring `image` also stops Pi from replacing images with a placeholder before they reach Cursor.

### The models.dev index

The document is 5.5 MB of JSON, about 600 KB gzipped, so a session does not read it. `/cursor-provider-update` and the first catalogue refresh after an install or update write `cursor-limits.json` beside `cursor.json` (`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`); every other refresh reads that file only. The file records the package version that wrote it, so updating this package refreshes the index once and leaves it alone afterwards, and concurrent refreshes share one download. A failed read is retried no sooner than ten minutes later and leaves the stored index in use; if the file cannot be written, the index still serves this session and the next one reads again.

```text
/cursor-provider-update
```

The command refetches the index and then the Cursor catalogue, and reports how many models and limits it ended up with. It takes no arguments.

Cost stays zero for every model: a subscription bill is not a token price.

## Fast mode

Select a Cursor model, then use:

```text
/cursor.fast
/cursor.fast on
/cursor.fast off
/cursor.fast status
```

With no argument, `/cursor.fast` toggles the current model: off becomes on, and on becomes off. `/cursor.fast on` and `/cursor.fast off` set it explicitly. In the TUI, type `/cursor.fast ` and press Tab to choose `on` or `off`; a unique prefix such as `of` completes to `off` without executing the command. `/cursor.fast status` only reports the current state. In the TUI, enabled fast shows `Fast` on the second footer row beside the model/thinking information. Off shows nothing there. Other extension statuses retain their own row. The same text is also published through `ctx.ui.setStatus`, so a footer that renders extension statuses — Pi's own footer, or pi-ccline's — still shows it when another extension owns the footer slot; Cursor's footer filters that key out, so it never appears twice. RPC clients continue receiving the `cursor-fast` status text. Enabling fast preserves the selected model ID, context size, and thinking level. It requires an account-available fast variant at the same context and effective thinking parameters; unsupported combinations are rejected.

The setting defaults to off and belongs to the current model. Selecting another Cursor model while fast is on carries that choice when the response is finished and the new model supports fast at the current thinking level; a busy response, a model without fast, or a model that is already on leaves the recorded choices unchanged. Turning it off does not turn off the model being left. Turning it on or off is recorded in the current session branch and in `cursor-fast.json` beside `cursor.json`, keyed by the session's working directory. The first change on a branch also records the models that branch inherited, so a later reload keeps every model, not only the one just changed. A branch that already chose — including one that turned fast off — wins over the file. A new session with no choice of its own inherits the models last left on in that directory, so the same project starts with fast on again; a different directory does not. Changing directory inside a session does not move the switch. If the directory file cannot be written, the change still applies to this session and Pi says it was not saved. Changes apply to the next request and require the current response to finish first.

If fast is enabled and a later thinking change or catalogue update removes support, the footer shows `Fast unavailable` and requests report an error until you select a supported thinking level or run `/cursor.fast off`. The command does not add duplicate fast models to `/model`.

The second-row display uses Pi 1.4's custom-footer slot and its default renderer. On other Pi versions it falls back to the standard status row until the footer adapter is verified. Extensions that replace the same footer slot can replace this layout; Cursor yields if another extension takes ownership. The `cursor-fast` status row is still set in that case, so a footer that renders extension statuses keeps showing the fast state; otherwise `/cursor.fast status` remains the source of truth.

## How this relates to other Cursor packages

| Package | Role |
| --- | --- |
| `@rahularya01/pi-cursor` | Pi provider that keeps a long-lived HTTP/2 bridge, with checkpoint resume and a run journal. |
| `cursor-for-pi` | The same per-turn AgentService/Run protocol. `@caph42/pi-cursor-provider` is that port under the magpie-aligned package name. |
| `@magpie-community/opencode-cursor-auth` | Cursor auth and Run for the OpenCode / magpie host. This package speaks Pi `streamSimple`. |

## Usage

`/cursor.usage` prints the plan and the billing-period windows. The command reads the same credential as `/cursor.doctor`. If nothing is signed in, it warns and does not print a token.

The same report is exported from the package.

```ts
import { fetchUsage, formatUsage, onDemandOf } from "@caph42/pi-cursor-provider"
```

Pi loads the package through `pi.extensions`, which points at `src/index.ts`. The import above also works under a TypeScript loader such as `tsx`, and under `node --experimental-strip-types` when the files are outside `node_modules`. Node does not strip types for files inside `node_modules`. A normal Node program that imports the installed package fails with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. `main` is the same TypeScript file Pi loads. It is not a compiled JavaScript entry.

`fetchUsage(token, modelIds)` returns `{ plan?, windows, error? }`. `formatUsage` turns that into the text the command shows. `onDemandOf` reads a period payload and a hard-limit payload into `fixed`, `unlimited`, `disabled`, or `unavailable`.

Windows follow magpie, in this order.

- Cursor Models
- Other Models
- On-demand, when the account has a dollar limit or an open on-demand spend
- Total

Total stays last. Only what a Pi turn can spend is reported: a plan's allowance for another product, such as Cursor's Grok bot, is left out even when the dashboard reports it.

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

## Doctor

`/cursor.doctor` shows what this process holds for Cursor. The report has these lines.

- The credential source and the client version. The token is never shown.
- The models `cursor.json` hides.
- The transport, HTTP/2 or HTTP/1.1. After HTTP/2 fails on this network, Runs stay on HTTP/1.1 until the time shown.
- This account's agent host, without its path, and when GetServerConfig is asked again.
- Max-mode models this process learned.
- Native owners. Each line gives the state, model, tool rounds, and lifetime deadline, and says whether the owner belongs to this account. Complete owners kept for replay are listed too.
- The usage ledger, as counts of Runs owed, usage misses in a row, and accounts whose usage events Cursor refuses.

"This account" is the token `/cursor.doctor` resolves, the same way `/cursor.usage` does. The doctor does not refresh OAuth. A token near expiry may be refreshed by the next turn, so until then the doctor can name the account that token had. Every time is UTC, written `HH:MM:SSZ`. No line holds a token, an authorization header, or a hash of a token. Reading the report changes nothing and sends no request.

Start Pi with `CURSOR_DEBUG=1` to keep a decision journal. The doctor then lists the last 16 turns, oldest first, with what each turn decided. That covers the agent host lookup, HTTP/2 or HTTP/1.1, whether the turn went native and why not, why a native owner ended, region and max-mode retries, why the turn failed, and usage reads that failed or were refused. A decision that repeats shows once with a count. A turn keeps 32 decisions and counts the rest. The journal lives in memory. Nothing is written to the terminal, a file, or the session. Without the variable nothing is recorded. Pi reads `CURSOR_DEBUG` at startup, and `0`, `false`, `off`, and `no` leave the journal off.

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

`npm test` stays off the Cursor network (fetch is mocked where the dashboard is involved). `npm run test:e2e` hits a real Cursor account (cursor-agent `auth.json`, `CURSOR_ACCESS_TOKEN`, or `/login cursor`) and never prints the token. The checker reads `client.ts` and `run.ts`. `codec.ts`, `ledger.ts`, `models.ts`, and `native-session.ts` still keep their `// @ts-nocheck` magpie-port headers.

The renewal grant is checked against the real service: `POST api2.cursor.sh/oauth/token` answered with a new access token, and that token listed models, read usage, and completed a Run. `npm test` covers the request shape, the rotation, and the failures offline; how the server itself answers still needs a live check.

## License

MIT. The Run protocol comes from magpie [`packages/cursor`](https://github.com/magpie-community/plugins/tree/main/packages/cursor). Login patterns follow [pi-cursor](https://github.com/Rahularya01/pi-cursor). Session renewal follows [oh-my-pi](https://github.com/can1357/oh-my-pi).
