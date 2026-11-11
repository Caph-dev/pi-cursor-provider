# Changelog

## Unreleased

## 0.8.0

- Selecting another Cursor model while fast is on carries it to that model when the response is finished and the model supports fast at the current thinking level. The previous model stays on. A busy response, a model without support, or a model that is already on does not record another change. Turning it off does not turn off the model being left.
- `/cursor.fast` now remembers the models left on for the session's working directory. The record is `cursor-fast.json` beside `cursor.json`, separate from that hand-edited file. A new session in the same directory inherits it. The first change on a branch records the inherited models too, so a reload keeps them. A branch that already chose, including one that turned fast off, keeps its own choice. A different directory, and a directory change inside an existing session, do not move the switch. A failed write still changes the current session and says the directory preference was not saved.

## 0.7.1

- Republished after npm staged 0.7.0 without making it installable.

## 0.7.0

- `/cursor.fast` with no argument toggles the current model between off and on. `/cursor.fast on`, `/cursor.fast off`, and `/cursor.fast status` are unchanged.
- Fast stays off the footer while it is off or unavailable. Enabling it publishes `Fast`; an enabled preference that the current thinking level no longer supports publishes `Fast unavailable`. Non-Cursor models still publish nothing.
- Each assistant stream event carries `cursorOutputTiming`, copied when the event is queued. The shared partial stays the one live message, so a consumer that reads the queue later still sees the reading from that moment: estimated output tokens, elapsed time, and a receive-side tokens-per-second once a measured interval exists. Bytes that open a burst, including the first delta after a tool call, are not in the rate. Cursor's own output count arrives with the stop and replaces the estimate only when it is measured. Replayed native events are marked and do not move the clock.

## 0.6.0

- A merged (unified) subscription now offers only the models its included weekly allowance covers. `GetPlanInfo`'s `isMerged` decides whether the filter runs; the current period's `autoBucketModels` names the ids that allowance pays for, and an entry is offered when the id a Run at its default parameters resolves to is one of them. The filter is applied when the catalogue is read, not to the catalogue itself: the stored list stays complete, request resolution keeps every variant, and `{ "showAllModels": true }` in `cursor.json` offers everything again without a refresh and without the plan lookups. Cursor's own plans filter nothing, and a plan or period report that cannot be read filters nothing either. Checked against a live X unified account: 6 of 65 entries stayed (auto, Grok 4.7 at two context sizes, Grok 4.6, Grok 4.5, Composer 2.5); two of the excluded ones were sampled and both were refused with `429 … is not included in your weekly usage`, and the rest were not each exercised. A refresh makes one more request (`GetPlanInfo`), and a second one (`GetCurrentPeriodUsage`) only on a merged plan.
- A model's `maxTokens` is no longer a flat 32k guess: it comes from [models.dev](https://models.dev/api.json), matched by model id, taken as the limit most providers report with one vote per provider, and clamped to the entry's context window both when the limit is reported and when it is not. The index is stored in `cursor-limits.json` beside `cursor.json`: the first catalogue refresh after an install or update writes it (the file records the package version that wrote it, so a version change refreshes it once), every other session reads the file without a request, and concurrent refreshes share one download. A failure backs off ten minutes and leaves the stored index in use. A model it does not list — Cursor's own Composer, and `auto`, whose picker name is the API keyword `default` — keeps the fallback. Checked live: Grok 4.7 at 256k reports 256k (clamped from models.dev's 500k), Grok 4.7 at 500k reports 500k, Grok 4.6 and 4.5 report 256k, Composer 2.5 reports 32k, and a session refresh makes no models.dev request at all.
- `/cursor-provider-update` refetches the models.dev index and the Cursor catalogue on demand, and reports how many models and limits it ended up with. Nothing else in this package reads models.dev during a session.
- Image input stays declared for every model: Cursor's `supportsImages` under-reports it for the models sampled. The flag is `false` for Grok 4.7 and Composer 2.5, yet Grok 4.7, Grok 4.6, Grok 4.5, and Composer 2.5 each described a real 512×396 photograph in detail — a black-and-white panda meme with a photoshopped human face — rather than echoing colours, and a smaller synthetic test image had only been refused for being too small. The samples cover those entries, not the whole catalogue.
- `/cursor.usage` no longer adds a Grok Bot window, and the cursor.com dashboard request that read it is gone. The report covers the allowance a Pi turn can spend; another product's allowance is not spendable here.

## 0.5.3

- The Cursor catalogue refresh on `session_start` no longer blocks the session in the TUI. Pi paints before it binds extensions and awaits `session_start` handlers one at a time, so the network round trip left the built-in footer on screen for as long as it took — measured 1.9 s with a healthy connection, up to the 15 s timeout without one — and every extension registered after this one waited with it. The TUI path now starts the refresh in the background and publishes when it lands; a new session, a reload, or a shutdown cancels the request it replaced, so `refreshModels` cannot publish a catalogue for a session that ended, and no status or warning from it is applied. Headless modes still await it: an RPC host reads the catalogue right after startup and has no other signal that it changed.

## 0.5.2

- The `cursor-fast` status is always published with `ctx.ui.setStatus`, not only when Pi's own footer is in use. A footer that renders extension statuses — including pi-ccline, which takes the only custom-footer slot on Pi 1.4 — now shows `fast: on/off/unavailable` instead of losing it. Cursor's own footer still filters that key out, so the inline badge never appears twice.

## 0.5.1

- A stored login renews the way the Cursor IDE does: a `refresh_token` grant at `api2.cursor.sh/oauth/token`, using the stored refresh token rather than the access token. A session Cursor ends asks for `/login cursor` instead of reporting a bare HTTP status. Checked against the real service: the grant minted a new access token, and that token opened a Run, listed models, and read usage. Offline tests cover the grant, rotation, and the failures.
- `/cursor.doctor` shows the transport, the agent host, native owners, and the usage ledger, with UTC times. It prints no token, header, or token hash, and reading it changes nothing.
- `CURSOR_DEBUG=1` keeps an in-memory journal of each turn's decisions, which `/cursor.doctor` prints. It records retry, fallback, and failure reasons that were dropped before.
- A native Run that cannot be created names its reason instead of returning `null`. A history mismatch keeps the specific error as `detail`.
- A finished login wait removes its abort listener.
- `headerWaitMs` is the HTTP/2 header timer. Callers who omit it still wait 15 seconds.
- Cancelling a request aborts the Connect call. A late model catalog is not cached.
- A failed model refresh returns that credential's last catalog, or an empty list when it has none.
- Tool names, descriptions, and schemas cannot close the catalog tags.
- Offline tests cover assistant events, Run retries, and HTTP/2 stickiness.
- `run.ts` is split by seam: the agent host cache is `endpoint.ts`, the HTTP/1.1 fallback is `transport.ts`, chat encoding and `exec` are `protocol.ts`, a single Run (stateless or native) is `agent-run.ts`. `run.ts` keeps `runAnswer` and its retry rules, and it is typechecked now. The unused exec refusal counter is gone.

## 0.3.0

- Pi provider for one HTTP/2 AgentService/Run per turn, with same-process native continuation, a deferred usage ledger, and an HTTP/1.1 fallback.
- The package entry is `src/index.ts`. Pi loads it. Plain Node does not.
