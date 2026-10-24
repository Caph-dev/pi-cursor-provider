# Changelog

## Unreleased

- A finished login wait removes its abort listener.
- `headerWaitMs` is the HTTP/2 header timer. Callers who omit it still wait 15 seconds.
- Cancelling a request aborts the Connect call. A late model catalog is not cached.
- A failed model refresh returns that credential's last catalog, or an empty list when it has none.
- Tool names, descriptions, and schemas cannot close the catalog tags.
- Offline tests cover assistant events, Run retries, and HTTP/2 stickiness.

## 0.3.0

- Pi provider for one HTTP/2 AgentService/Run per turn, with same-process native continuation, a deferred usage ledger, and an HTTP/1.1 fallback.
- The package entry is `src/index.ts`. Pi loads it. Plain Node does not.
