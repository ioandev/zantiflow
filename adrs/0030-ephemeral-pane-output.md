# ADR-0030 — Pane output is ephemeral (fresh-on-open, not persisted)

- **Status:** Accepted — storage decision partly superseded by [ADR-0032](0032-pane-output-never-persisted.md)
  (captured content now lives **in process memory, never the DB**; the lifecycle here is unchanged).
- **Amends:** [ADR-0016](0016-dashboard-page-and-pane-output.md) — keeps pane output an opt-in, on-demand,
  one-shot snapshot, but changes its **storage from "latest-only, persisted until overwrite/forget" to
  ephemeral**: the backend never serves a *previous* capture, and captured content is pruned shortly
  after it is read. Everything else about ADR-0016 (opt-in `pane_output`, privacy gating, scrubbing per
  [ADR-0017](0017-secret-scrubbing-and-adaptive-rendering.md), the request→poll→deliver→read channel,
  the full `sessionSid:tabId:paneId` key) is unchanged.
- **Amends:** [ADR-0018](0018-engineering-and-operational-conventions.md) §11 — updates the pane-output
  row of the consolidated data-retention table.
- **Date:** 2026-07-12
- **Deciders:** project owner
- **Tags:** backend, dashboard, privacy, pane-output, retention
- **Testing:** integration against **real MariaDB** — a re-open never serves the prior capture (returns
  `pending` until a fresh one arrives, and the stale row is gone); an unfulfilled re-request never
  regresses to the old content; the sweep prunes captures past the retention window while keeping fresh
  ones. See [ADR-0014](0014-testing-strategy.md).
- **Wire contract:** unchanged (**v4**); no protocol/API shape change.

## Context

ADR-0016 stored the last delivered pane output **latest-only** and served it on read. But `readOutput`
returned that stored row **before** checking whether a newer request was still outstanding, and the row
was only ever deleted on machine-forget. So re-opening a pane showed the **previous capture** instantly
("captured 12 m ago"), and scrubbed pane content (even masked, it can be sensitive) **persisted in the DB
indefinitely** between views. Both read as the backend "caching" pane output, which it should not: ADR-0016
intends a *fresh* one-shot snapshot per click, and content that "otherwise never leaves the machine" should
not linger centrally once viewed.

## Decision

### 1. Fresh-on-open — never serve a previous capture

`readOutput` gates on the **request lifecycle**, not on the mere existence of a stored row: while a
just-registered request is still `pending` (and within `REQUEST_TTL_SEC`), it returns `{ pending: true }`
so the drawer waits for a **new** capture; only once that request is **fulfilled** does it return the
stored output (which was captured *for this request cycle*). Using request status (not a `capturedAt` vs
`requestedAt` comparison) avoids any plugin↔backend clock-skew ambiguity.

### 2. Drop the prior snapshot on re-request

`registerRequest` **deletes any existing `PaneOutput`** for the pane before re-arming. So a re-open can
never fall back to the old capture — including the degraded case where the plugin never delivers (e.g.
`pane_output` turned off, or the machine went offline): the read stays `pending` for the TTL, then
reports `shared: false`, rather than resurrecting stale content.

### 3. Ephemeral storage — prune shortly after read

A delivered capture is kept only long enough for the owner's one-shot read, then removed. `pruneOutputs`
deletes `PaneOutput` older than **`PANE_OUTPUT_RETENTION_SEC` (120 s)** and runs on the existing **10 s
sweep** (alongside delivery dispatch), so content lifetime in the DB is bounded to ~2 min after capture.
The dashboard drawer holds its fetched lines in **component state only** (a one-shot fetch; it stops
polling once shown), so a drawer that stays open keeps displaying its copy after the server row is pruned
— the client is not "caching" server-side, it is showing what it fetched, and closing the drawer drops it.

Machine-forget still purges immediately (unchanged, ADR-0016).

## Consequences

**Positive**
- Re-opening a pane always yields a fresh capture; the stale "captured N min ago" surprise is gone.
- Scrubbed pane content no longer persists centrally between views — it lives ~2 min server-side and in
  the open drawer's memory, strengthening the ADR-0016/0017 privacy posture ("content otherwise never
  leaves the machine" now also means "and doesn't linger once it has").
- Small, contained: read-ordering + a delete + one prune line on an existing sweep; no wire/API change.

**Negative / costs**
- When `pane_output` is OFF or the plugin is offline, a re-opened drawer now shows a spinner until the
  request TTL (≤30 s) elapses, then "not shared", instead of an immediate "not shared". Acceptable — the
  channel is inherently "expect a spinner while the plugin responds" (ADR-0016), and it never shows wrong
  (stale) content.
- Output is genuinely one-shot: an open drawer does not live-update. Live-while-open remains a deferred
  enhancement (ADR-0016 §Delivery-model), now easier to layer on given the request-scoped freshness.

**Neutral**
- `PANE_OUTPUT_RETENTION_SEC` is a server constant, not user-configurable (no need surfaced yet).

## References

- [ADR-0016](0016-dashboard-page-and-pane-output.md) — the on-demand pane-output channel this refines.
- [ADR-0017](0017-secret-scrubbing-and-adaptive-rendering.md) — scrubbing (still applied before send).
- [ADR-0018](0018-engineering-and-operational-conventions.md) §11 — the retention table this updates.
