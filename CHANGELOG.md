# Changelog

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

## 0.3.0

- Pi provider for one HTTP/2 AgentService/Run per turn, with same-process native continuation, a deferred usage ledger, and an HTTP/1.1 fallback.
- The package entry is `src/index.ts`. Pi loads it. Plain Node does not.
