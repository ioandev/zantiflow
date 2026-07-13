# ADR-0032 — Pane output is never persisted (in-memory relay, not the DB)

- **Status:** Accepted
- **Supersedes (in part):** [ADR-0030](0030-ephemeral-pane-output.md) — keeps everything ADR-0030
  decided about the pane-output *lifecycle* (opt-in, on-demand, one-shot, fresh-on-open, dropped on
  re-request, pruned past the retention window, purged on forget) but changes **where the captured
  content lives**: from an *ephemeral row in MariaDB* (`PaneOutput`, pruned ~2 min after capture) to a
  **process-local in-memory store that is never written to the database at all**.
- **Amends:** [ADR-0016](0016-dashboard-page-and-pane-output.md) — the on-demand pane-output channel.
- **Amends:** [ADR-0018](0018-engineering-and-operational-conventions.md) §11 — the pane-output row of
  the consolidated data-retention table.
- **Date:** 2026-07-12
- **Deciders:** project owner
- **Tags:** backend, dashboard, privacy, pane-output, retention
- **Testing:** unit tests for the store (`test/output.store.unit.test.ts`: last-write-wins, full-key
  scoping/no-bleed, delete, `deleteMachine` prefix-safety, retention prune) + the existing pane-output
  integration suite against **real MariaDB** (register→poll→deliver→read, fresh-on-open, prune,
  cross-session collision, concurrent delivery, IDOR/auth) re-pointed to assert the store instead of a
  DB row. See [ADR-0014](0014-testing-strategy.md).
- **Wire contract:** unchanged (**v4**); no protocol/API shape change.

## Context

ADR-0030 made pane output *ephemeral* but still stored the captured lines in a `PaneOutput` MariaDB
table, pruned ~2 min after capture. That was enough to stop the backend serving a *stale* capture, but
it still meant scrubbed terminal content — the single most sensitive thing the pane-output channel
touches — was **written to the central database**, even if only briefly. The user-facing promise on the
pairing page said pane output is **"never stored"**, and the homepage/docs say content *"otherwise
never leaves your machine"*. A ~2-minute row in the DB contradicts the plain reading of "never stored":
the content is now on the server's disk, in backups, in whatever the DB persists, until the sweep runs.

Nothing about the channel actually *needs* durable storage. Pane output is a **one-shot relay**: the
plugin delivers a capture for a specific request, the owner reads it once, and it is then discarded.
The backend already keeps comparable ephemeral coordination state **in process, not in the DB** —
presence (ADR-0026), the long-poll wake registry (ADR-0029), and the auto-refresh tier gate (ADR-0016)
are all in-memory singletons, justified the same way (single-backend deploy, no Redis — ADR-0019).
Pane content belongs in exactly that category.

## Decision

### 1. Captured content lives only in an in-process store

A new `PaneOutputStore` (`src/output/store.ts`) holds delivered captures in a `Map` keyed by
`(accountId, machineId, paneKey)` — the pane's **full** `sessionSid:tabId:paneId` identity, so panes
that merely share a numeric id in different tabs/sessions never collide (the invariant ADR-0016
established). `submitOutput` **puts** into the store (last-write-wins — a concurrent re-delivery just
leaves the newest, so the old unique-constraint race disappears); `readOutput` **gets** from it. The
`PaneOutput` table is **dropped** (migration `20260712010000_drop_pane_output`). It is created and owned
in `index.ts` and injected through the app like the other in-process singletons, so a test can hold the
same instance and assert on it.

### 2. Same lifecycle, now against memory

The request lifecycle is unchanged and still lives in the DB (`OutputRequest` — which pane was asked
for, pending/fulfilled; **no terminal content**): `readOutput` still returns `pending` until the
current request is fulfilled (fresh-on-open), then serves the held capture. `registerRequest` still
**drops** any prior capture — now `store.delete(...)` — so a re-open never falls back to old content
and a plugin that stopped sharing degrades to "not shared". Forget-machine and token-revoke still
**purge immediately** — now `store.deleteMachine(...)`, prefix-safe so `m-1` doesn't sweep `m-12`.

### 3. Retention becomes a memory sweep

The existing 10 s maintenance sweep now calls `outputStore.prune()` (was `pruneOutputs(prisma)`), which
drops entries older than `PANE_OUTPUT_RETENTION_SEC` (120 s) **by server-receipt time** — a tighter
basis than the plugin's `capturedAt` (no clock-skew, bounded by when it entered our memory). So content
lifetime is ~2 min *in RAM* and then gone. Losing the store on restart is harmless: the read reports
"not shared" and the next open captures afresh.

## Consequences

**Positive**
- "Never stored" is now literally true: captured pane content is never written to the database — it
  exists only in the backend's memory for the length of one read (≤~2 min), then is dropped. The
  pairing-page copy and the "content otherwise never leaves your machine" promise are honest.
- Simpler delivery: last-write-wins `Map.put` removes the P2002 unique-constraint race handling; one
  fewer table, two fewer `deleteMany` calls in the forget paths.
- Consistent with the existing in-process coordination state (presence / waiters / auto-refresh).

**Negative / costs**
- In-memory means **single-backend** for pane output (already true for presence/waiters/auto-refresh —
  ADR-0019). Horizontal scaling would need the delivering and reading requests to hit the same process
  (or a shared cache); out of scope while the deploy is single-backend.
- Content is lost on restart. Acceptable — it's one-shot, and a lost capture just re-captures on the
  next open.

**Neutral**
- `PANE_OUTPUT_RETENTION_SEC` is still a server constant (moved to `store.ts`); still not user-tunable.
- The overflow guard (100k entries) prunes expired first, then drops the oldest — a flood can't grow
  memory without bound.

## References

- [ADR-0030](0030-ephemeral-pane-output.md) — the ephemeral-but-stored decision this supersedes.
- [ADR-0016](0016-dashboard-page-and-pane-output.md) — the on-demand pane-output channel.
- [ADR-0017](0017-secret-scrubbing-and-adaptive-rendering.md) — scrubbing (still applied before send).
- [ADR-0019](0019-ux-decisions-deferred.md) / ADR-0026 / ADR-0029 — the in-process, single-backend
  coordination state this now joins.
- [ADR-0018](0018-engineering-and-operational-conventions.md) §11 — the retention table this updates.
