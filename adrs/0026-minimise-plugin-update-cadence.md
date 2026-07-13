# ADR-0026 — Minimise plugin→backend updates (change-driven, presence-aware sends)

- **Status:** Proposed
- **Amends:**
  - [ADR-0001](0001-zellij-session-telemetry-architecture.md) §2 (cadence) — replaces "~1 s POST each
    tick" with a change-driven, presence-aware send policy. The transport, wire body, snapshot shape,
    and per-pane derived activity are unchanged; only *when the plugin POSTs* changes.
  - [ADR-0005](0005-attentions-detection-and-triggering.md) §4 — the plugin's send behaviour gains a
    keepalive while an attention is active and gates ordinary sends on change; detection, the backend
    episode engine, and tier thresholds are untouched.
  - [ADR-0008](0008-status-website-dashboard.md) §3/§6 — adds a viewer-presence signal and a
    per-session liveness touch so a quiet-but-live session does not drop from the dashboard. Retention
    stays **none** (latest state only).
  - [ADR-0016](0016-dashboard-page-and-pane-output.md) — the `pane_output`-gated 5 s output poll
    generalises into an **always-on control channel** that also carries liveness and returns presence.
- **Builds on:** [ADR-0003](0003-multi-tenant-backend-and-token-auth.md) (token plane, `machineId`),
  [ADR-0009](0009-durable-notification-delivery.md) (durable delivery — unchanged),
  [ADR-0018](0018-engineering-and-operational-conventions.md) (rate-limit shape, versioning)
- **Date:** 2026-07-11
- **Deciders:** project owner
- **Tags:** plugin, backend, cadence, presence, attentions, performance, wire-contract
- **Testing:** unit (plugin `dirty` excludes `capturedAtTick`; coalesce floors 30 s idle / 15 s watched;
  watched/unwatched FSM; onset bypasses the floor; keepalive cadence · backend: control-poll touch
  updates `lastSeenAt`/`receivedAt`; `isWatching` TTL + SSE-count logic) + BDD (idle unwatched machine →
  **0 ingest POSTs** over minutes, only 5 s control polls; silent Claude pane ≥ threshold with no viewer
  → notification still fires; watched machine updates within ~15 s; closed session ages out; quiet-live
  session stays visible) + integration/real-MariaDB (`POST /control` stamps `lastSeenAt` + touches
  slices; a 5-min-quiet session still reads while control-polled; IDOR on `/control` + `/refresh`) +
  Playwright (dashboard live under watched cadence; refresh button; presence via SSE and polling
  fallback) — see [ADR-0014](0014-testing-strategy.md).
- **Wire contract:** ingest body **unchanged (v4)**. The **output channel becomes a control channel**
  (new request/response fields) — versioned in `@zantiflow/protocol`, not the ingest `version`.

## Context

ADR-0001 pinned the plugin to POST a **full sessions→tabs→panes snapshot every ~1 s,
unconditionally**: the `Timer` handler calls `send_snapshot()` every tick and re-arms `set_timeout(1)`,
with no "skip if unchanged". Every tick therefore re-writes the machine's per-session slices, re-derives
per-pane activity, and reconciles attentions server-side — **even when nothing changed and nobody is
watching**. For an idle machine that is pure waste; at scale it is the dominant cost.

The actual product requirement is far looser than 1 s. What must stay reliable is **notification
delivery**, and even that tolerates being **~2 minutes late**. Concretely, the plugin should:

1. Send **nothing** when no pane has produced new output (and nothing else changed).
2. Keep a **cheap ~5 s poll** to the backend to pick up on-demand requests — this must stay tiny.
3. **Never** send every second; send **on change**, coalesced to ~30 s.
4. Use that same ~5 s poll to learn whether a **dashboard is open and wants a fresh view** (the website
   asks ~15 s while open, or on a refresh button ≥5 s apart); when no dashboard is loaded, push nothing
   for the dashboard.

Three facts about the *current implementation* make this safe and shape the design:

- **The backend times attention episodes by wall-clock, not by counting snapshots.**
  `processAttentions` stamps `activeSince = now` (ingest arrival) on the first snapshot that reports an
  attention active, and fires when `now − activeSince ≥ threshold`. The plugin's `since` field is
  ignored. So slowing the cadence does **not** change *when* a threshold is crossed — it only delays the
  *evaluation* (which happens on ingest) by up to one send-interval, and only while the attention keeps
  being re-reported (a continuous re-report never resets `activeSince`).
- **Firing is only evaluated on ingest.** `processAttentions` runs solely from the ingest router; there
  is no background timer. If the plugin goes silent while an attention is pending, nothing fires until
  the next ingest.
- **Snapshots are stored as per-session slices keyed by `(machineId, sid)`, and each Zellij plugin
  instance reports only its own session.** The machine's tree is the *union* of slices on read.
  Reads currently drop any slice older than `STALE_AFTER_MS = 60 s`; that 60 s filter is the *only*
  thing that makes a **closed** session disappear (storage is upsert-only — nothing deletes a slice).
  Under the old 1 s cadence a live session's slice is always <60 s fresh, so the filter drops only
  genuinely-gone sessions. **The moment the plugin goes quiet for a live-but-idle session, that
  invariant breaks** and the session would wrongly vanish — unless something else keeps its slice fresh.

There is also **no viewer-presence concept** today: SSE (`/api/v1/stream`) is per-account and in-process,
and `bus.countFor(accountId)` exists only to enforce the ≤5 connection cap — the plugin is never told
whether anyone is watching. And `session.stopped` / machine-offline inference was specified in ADR-0005
but **never implemented** (it never fires).

## Decision Drivers

- **Drastically fewer POSTs and backend writes**, especially for idle and unwatched machines.
- **Notification correctness within ~2 minutes** — the one hard constraint.
- **Live-enough while a viewer is watching**, cheap-or-silent otherwise.
- **No privacy regression** — ingest stays v4; redaction (ADR-0002) and secret scrubbing (ADR-0017)
  remain in-plugin, before send.
- **Reuse existing infrastructure** — the in-process SSE bus, the token plane, the 5 s poll cadence —
  and keep the **backend surface minimal** (no new sweeps/timers).

## Considered Options

**Send policy.**
- *Unconditional 1 s (status quo)* — simplest, but the waste this ADR exists to remove.
- *Skip-if-unchanged only* — better, but still fires every second whenever any repainting pane exists,
  and is blind to whether anyone is looking.
- **Change-driven + presence-aware, with coalescing *(chosen)*** — sends on change, coalesced; sends
  more while watched, near-nothing while unwatched-idle.

**Firing under reduced cadence.**
- **Plugin keepalive, firing stays ingest-triggered *(chosen)*** — while an attention is active the
  plugin keeps ingests flowing (~30 s); no new backend code. Costs up to one keepalive interval of extra
  latency and inherits `web_request`'s fire-and-forget fragility (a lost onset POST delays `activeSince`
  by ≤1 keepalive) — both comfortably inside the 2-min budget.
- *Backend attention-evaluator sweep (rejected)* — a server timer that fires threshold-crossed attentions
  regardless of cadence and even if the plugin dies. Strictly more robust, but more code and a new
  concurrent-fire race to defend; deferred as a future upgrade if the keepalive proves insufficient.

**Session liveness under "idle sends nothing".**
- *Periodic full-snapshot idle keepalive (rejected)* — defeats the entire goal.
- **Per-session liveness touch on the 5 s control poll *(chosen)*** — the always-on poll carries the
  instance's live sids; the backend touches those slices' `receivedAt`, so the **existing 60 s
  read-filter keeps working unchanged**: quiet-but-live sessions stay fresh, closed sessions age out.
  No read change, no sweep, no immortal rows.

**Presence source.**
- *Explicit viewer ping only (rejected as sole source)* — needs a website polling loop even in the
  common case where an SSE stream is already open.
- **Live SSE connection + TTL, with an explicit ping fallback + a refresh endpoint *(chosen)*** — free
  for the SSE case, covers browsers where SSE is blocked, and powers the manual refresh button.

## Decision

### 1. Plugin send FSM — change-driven and presence-aware

Local sampling stays at **1 s** (needed for prompt attention onset and fingerprint diffing — all local,
no network). Each tick the plugin computes `dirty` = a change in the **salient hash** of the last
**sent** snapshot: the tree structure (sessions/tabs/panes and their identity/state) + each pane's
`contentFingerprint` + the active-attention set, **excluding `capturedAtTick`** (which changes every
tick and must not by itself look like a change). It also tracks `attentionActive` (any attention
currently active) and `watched` (from the control response, §2). It sends an **ingest POST** when any of:

- **Attention transition** (active↔cleared) **or structural change** (a session/tab/pane appears or
  disappears) → send promptly, **bypassing the coalesce floor**, with a small ~2 s debounce to absorb
  flapping. This keeps notification *onset* accurate (an accurate `activeSince`).
- **Attention active** → **keepalive** re-send every **~30 s** while any attention is active, so the
  ingest-triggered engine evaluates (and re-fires after cooldown) within budget. A continuous re-report
  preserves `activeSince`.
- **Watched and `dirty`** → send, floored at **~15 s** (an open dashboard is a standing request; this
  matches the website's ~15 s ask).
- **Unwatched and `dirty`** → send, floored at **~30 s** ("send on change, ~30 s").
- **Refresh requested** — the control response's `refreshSeq` increased → force one send within ≤5 s.
- **Cold start** — one send on `load`, and one on an unwatched→watched transition (so a viewer who just
  opened the dashboard gets fresh data quickly).
- **Otherwise** (unwatched, not dirty, no active attention) → **send nothing**. This is the core win.

### 2. Always-on control channel (generalises the output poll)

Replace the `pane_output`-gated `GET /output/pending` with an always-on **`POST /api/v1/control`** on
the token plane, run every **~5 s regardless of `pane_output`**:

- **Request** `{ machineId, liveSids[] }` — the sids this instance currently reports.
- The backend **touches** `Machine.lastSeenAt = now` **and** `Snapshot.receivedAt` /
  `PaneActivity.updatedAt` for each `(machineId, sid ∈ liveSids)`. This is the load-bearing move: a
  **quiet-but-live** session stays under the existing 60 s read-filter, while a **closed** session (its
  instance is gone → it stops polling) ages out on its own. The read path and `mergeSlices` are
  **unchanged**; no background sweep is added.
- **Response** `{ pendingOutput[], viewers: { active, until? }, refreshSeq }`. The plugin acts on
  `pendingOutput` **only when `pane_output` is on** (unchanged ADR-0016 semantics — content still never
  leaves the machine otherwise); uses `viewers.active` to choose watched/unwatched; and treats a bumped
  `refreshSeq` as a one-shot "send now". The payload is tiny — it keeps requirement (2) cheap.

### 3. Presence (SSE primary + explicit fallback; in-process, single-backend)

`isWatching(accountId) = bus.countFor(accountId) > 0 OR (now − lastViewerSeenAt < 45 s)`. Bump
`lastViewerSeenAt` on: SSE **subscribe** and each **25 s SSE heartbeat**; an explicit fallback
view-request; and owner **read-API** hits (`GET /machines[/:id]`). The **45 s** TTL exceeds the 25 s
heartbeat, so an idle-but-open tab still counts and an SSE reconnect blip does not flap the plugin
between modes. Endpoints:

- **`POST /api/v1/machines/:id/refresh`** — the manual refresh button, **rate-limited ≥5 s (429 if
  faster**, per ADR-0018 §9) → bumps that machine's `refreshSeq`.
- **Fallback view-request** — for browsers where SSE is blocked, the website POSTs ~15 s while the
  dashboard is open, bumping `lastViewerSeenAt` (may reuse `/refresh` without the strict rate-limit, or
  a sibling route).

Presence ships **account-scoped** (any open tab marks all of that account's machines watched — cheap at
the 15 s watched cadence). **Machine-focus** (only the expanded machine ramps up) is a noted future
refinement, not required for v1.

### 4. Notification firing — unchanged engine + plugin keepalive

Firing stays in `ingest/router.ts → processAttentions`; **no backend evaluator sweep and no staleness
sweep are added**. The §1 keepalive keeps ingests flowing while an attention is active. Worst-case
firing latency (against the ~2-min-late budget):

- **Pro** (needs-input / thinking): 60 s threshold + ≤30 s keepalive ≈ **≤90 s**.
- **Free**: 300 s threshold + ≤30 s ≈ **≤330 s** — i.e. ≤30 s past the 5-min threshold.

Both are comfortably inside budget. `session.stopped` / machine-offline **notifications remain out of
scope**: a fully-dead plugin cannot emit them and we are adding no server timer to infer them — which is
**no regression**, since they never fire today. A closed session still disappears from the dashboard
(its slice ages out of the 60 s filter) and `online` still flips via `lastSeenAt` (now refreshed by the
5 s control poll rather than by a 1 s snapshot).

### Locked intervals

| Parameter | Value | Rationale |
|---|---|---|
| Local sampling tick | 1 s (unchanged) | prompt onset detection + fingerprint diff; local only |
| Control poll (always-on) | ~5 s | reuses the ADR-0016 cadence; tiny payload; touches liveness |
| Unwatched dirty coalesce | ~30 s | requirement (3); bounds a repainting-pane worst case |
| Watched dirty coalesce | ~15 s | matches the website's request rate; open SSE = standing watch |
| Attention onset / structural | prompt, ~2 s debounce | keeps notification onset (`activeSince`) accurate |
| Attention-active keepalive | ~30 s | ingest-firing within budget; preserves `activeSince` |
| Manual refresh min-gap | 5 s (429 if faster) | reflects within ≤1 poll; anti-abuse |
| Presence TTL | 45 s | > 25 s SSE heartbeat; absorbs reconnect blips |
| Read-filter (`STALE_AFTER_MS`) | 60 s (unchanged) | kept fresh by the 5 s control touch |

## Consequences

**Positive**
- **30×+ fewer ingest POSTs** on idle machines (and near-zero while unwatched-idle), and ~2–15× fewer
  while watched — the whole point.
- The backend's write load (per-session upserts, activity derivation, attention reconcile) drops with it.
- **No new backend sweeps or timers**; the read path and `mergeSlices` are untouched — the 5 s control
  touch makes the existing 60 s filter Just Work for quiet-but-live sessions.
- **Ingest wire contract unchanged (v4)**; privacy and secret scrubbing are untouched.
- Adds the missing **viewer-presence** concept, reusable later (machine-focus, live pane-output).

**Negative / costs**
- **Repainting TUIs** (htop, clocks, spinners) keep `dirty` permanently true, so an unwatched machine
  POSTs at the ~30 s floor rather than truly nothing. Acceptable (still a ~30× cut); only genuinely
  static panes reach zero. (Optional future mitigation: skip the fingerprint for non-`claude` panes when
  unwatched — attention detection still scans `claude` panes.)
- **Watched pickup latency**: a viewer opening the dashboard waits ≤5 s (next control poll) + one floor
  before fresh data — the unwatched→watched cold-start send mitigates once the mode is learned.
- **Account-scoped presence** ramps *all* of an account's machines to the watched cadence when any tab
  is open.
- A **new always-on control channel** and a small **presence module** to build and test.
- Fire-and-forget POSTs have no retry; a lost onset POST delays `activeSince` by ≤1 keepalive (~30 s) —
  still within budget, and the accepted cost of the "keepalive only" choice.

**Neutral**
- Retention stays **none** (latest state only, per ADR-0008). `capturedAtTick` remains on the wire but
  is not load-bearing (the backend times off `receivedAt`).

## Open Questions / Risks

- **Reporter-ownership (verify at build).** The `liveSids` touch assumes each plugin instance reports
  only its own session's sids (consistent with `storeSnapshot`'s per-`(machineId, sid)` slices). Confirm
  via the ADR-0014 §6 real-Zellij smoke check that an instance never reports another instance's session
  — otherwise the touch/age-out reasoning needs per-reporter scoping.
- **Local sampling cost.** Sampling stays 1 s so onset stays prompt; optionally relax to 2–3 s when
  unwatched **and** no attention is active to cut CPU, at the price of slower onset (still within budget).
- **Presence scope.** Ship account-scoped; revisit machine-focus if the sibling-ramp cost matters.
- **`session.stopped` on plugin death** stays deferred — it requires a backend staleness timer, which
  the keepalive-only decision intentionally omits.
- **Firing robustness.** If the keepalive + fire-and-forget combination ever proves too lossy in
  practice, the rejected backend evaluator sweep is the pre-scoped upgrade (with a compare-and-set fire
  claim to avoid double-notifying alongside the inline ingest fire).

## References

- [ADR-0001](0001-zellij-session-telemetry-architecture.md) §2 (cadence), §4 (derived activity) —
  amended here.
- [ADR-0005](0005-attentions-detection-and-triggering.md) §4/§5 (plugin send, backend episode engine),
  [ADR-0025](0025-claude-thinking-attention.md) (thinking) — firing engine unchanged.
- [ADR-0008](0008-status-website-dashboard.md) §3 (SSE), §6 (retention) — presence + liveness touch.
- [ADR-0016](0016-dashboard-page-and-pane-output.md) (the 5 s output poll, now generalised).
- [ADR-0018](0018-engineering-and-operational-conventions.md) §9 (rate-limit shape), §2 (versioning).
- FINDINGS §4 (`set_timeout`/`Timer` one-shot re-arm), §6 (no push signal for new stdout; poll+diff) —
  [FINDINGS.md](../FINDINGS.md).
- `plans/execution-plan.md` — **Phase 11** implements this ADR; Appendix C records the new timings.
