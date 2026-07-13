# ADR-0027 — Machine-level `claude.idle`: notify when all Claude sessions go quiet

- **Status:** Accepted
- **Supersedes (in part):** [ADR-0005](0005-attentions-detection-and-triggering.md) — adds a new built-in
  attention `claude.idle` and, for the first time, **implements ADR-0005 §8's backend-derived attention
  injection** (attentions computed server-side and folded into the stored set, not sent by the plugin).
  It also **narrows ADR-0005's "detection runs in the plugin" rule for this one type**: `claude.idle` is
  a cross-session, whole-machine predicate that no single per-session plugin instance can observe, so it
  is detected in the backend. ADR-0005's detect-in-plugin / enforce-in-backend split, the `Observation`
  shape, wire contract v4, and every other attention are unchanged.
- **Amends:** [ADR-0026](0026-minimise-plugin-update-cadence.md) — that ADR stated firing "stays
  ingest-triggered (no new backend sweep)"; that holds for the per-pane attentions, but `claude.idle`
  **requires** a backend sweep (see Context, fact 3), which this ADR adds.
- **Builds on:** [ADR-0001](0001-zellij-session-telemetry-architecture.md) (per-pane activity is derived,
  not pushed), [ADR-0005](0005-attentions-detection-and-triggering.md) (attention model + episode engine),
  [ADR-0006](0006-notifications-web-push-and-channels.md) (delivery), [ADR-0011](0011-tiers-and-monetization.md)
  (effective tier), [ADR-0026](0026-minimise-plugin-update-cadence.md) (control-poll liveness touch)
- **Date:** 2026-07-12
- **Deciders:** project owner
- **Tags:** attentions, detection, backend, notifications, dashboard
- **Testing:** unit (`isClaudeCommand`; `watchedPaneKeys` scope selection + exited-pane exclusion;
  `computeMachineIdle` — all-idle-past-threshold → active, one fresh pane → cleared, `updatedAt:null`
  → cleared, empty → cleared, boundary equal-to-threshold → active; `idleThresholdSeconds` 60 pro /
  300 free) + integration against **real MariaDB** (fires once after the threshold, respects the 300 s
  cooldown, clears on resume, no fire with a fresh Claude pane or with zero Claude panes, tier crossings,
  the idle sweep does not clobber a live per-session attention, a closed session ages out of the freshness
  window, and an end-to-end ingest→freeze→sweep→`Notification`) — see [ADR-0014](0014-testing-strategy.md)
- **Wire contract:** unchanged (**v4**) — `Attention.type` is an open string and `AttentionTarget.machineId`
  already exists; a machine-scoped attention needs no schema bump.

## Context

The existing attentions (`claude.needs-input`, `claude.thinking`, `session.detached`) each fire about a
**single** pane or session. Users asked for the state they actually care about most across a whole box:
**"all of my Claude agents on this machine have stopped working."** When every Claude pane across every
session on a machine has produced no output for a while, the turns have finished (or stalled) and the
user should be pulled back to attend to them.

Three facts about the existing system shape how this must be built:

1. **Ingest is strictly per-session.** Zellij delivers only the current session to a plugin, so each
   session runs its own plugin instance and each ingest reports just that session; `Snapshot` and
   `PaneActivity` are keyed `(machineId, sid)` and "the machine view is the UNION on read"
   (`apps/backend/src/ingest/service.ts`). **No single plugin instance can observe all sessions**, so an
   "ALL Claude sessions idle" predicate can only be evaluated where the whole machine is visible — the
   backend. This is exactly the "backend-derived attention" ADR-0005 §8 anticipated but nothing had yet
   implemented.

2. **The silence signal already exists, backend-side.** `deriveActivity`
   (`apps/backend/src/machines/activity.ts`) already fingerprint-diffs every pane on ingest and stamps a
   backend-clock `entry.updatedAt` in the per-session `PaneActivity` map. A *thinking* Claude pane
   repaints its spinner every tick → its fingerprint changes → `updatedAt` stays fresh → it is correctly
   **not** idle. When Claude finishes, the pane freezes → `updatedAt` freezes → `now − updatedAt` grows.
   That is the exact "no output since" clock we need, already persisted.

3. **A backend sweep is required — an ingest-time check would never fire.** Under ADR-0026 the plugin's
   `SendGate` is change-driven and its keepalive is gated on an **active attention**; the behavior test
   `idle_unwatched_machine_sends_only_the_cold_start_over_three_minutes` proves an idle, unwatched machine
   with no active attention sends exactly one snapshot in three minutes and then goes silent. Because
   `claude.idle` is backend-derived, the plugin never emits it and it cannot be the attention that keeps
   the plugin sending. So in the primary scenario — Claude finishes, nobody is watching, no other
   attention — **ingests stop**, and a hook that only ran on ingest would never observe the idle window.
   The condition must be evaluated on a backend **timer**.

The sweep is made safe by ADR-0026's ~5 s **control-poll liveness touch** (`apps/backend/src/control/service.ts`),
which stamps `Machine.lastSeenAt`, each live session's `Snapshot.receivedAt`, and its `PaneActivity`
row `@updatedAt` — so a quiet-but-live session stays inside the 60 s `STALE_AFTER_MS` read-filter for the
whole idle period (even the free-tier 5 minutes), while a genuinely **closed** session (its instance
stops polling) ages out. The per-pane `entry.updatedAt` *inside* the JSON map is **not** touched by the
liveness poll, so the silence clock keeps ticking. Filtering the sweep to non-stale rows therefore cleanly
separates "live but idle" (fire) from "closed" (drop — no false positive).

## Decision

### 1. A new machine-scoped, backend-derived attention `claude.idle`

Its wire target is `{ machineId }` (no session/tab/pane), so its `targetKey` is `"::"` — unique per
machine because the `type` differs (`@@unique([machineId, targetKey, type])`). It is **computed in the
backend**, not detected in the plugin.

- **Condition:** there is at least one Claude pane on the machine, and **every** Claude pane has been
  silent for at least the tier threshold. "Claude pane" = a pane whose command contains `claude`
  (case-insensitive, mirroring the plugin's `is_claude_command`). Silence = `now − PaneActivity.updatedAt`.
- **Scope: Claude panes only.** Non-Claude panes (log tails, editors, shells) are ignored, matching "all
  Claude sessions went quiet". The enumerator (`watchedPaneKeys`) is parameterized by a `PaneScope`
  (`claude-only` | `claude-sessions` | `all`) so the scope is a one-line change if the product view
  shifts. **Exited panes are excluded** — a terminated process is a different, more final event than an
  idle-but-alive one.
- **Conservative false-negatives:** a Claude pane with no activity entry, or one never observed to change
  (`updatedAt === null`, i.e. first seen already-frozen), counts as **not** idle. A just-opened or
  already-static pane can never produce a spurious fire; the trade-off is that a pane that was already
  frozen before monitoring began never fires. Acceptable — that turn finished before we were watching.

### 2. Tier-aware threshold — 1 min PRO / 5 min free

`claude.idle` uses the same tier-gated cadence as the rest of the Claude family (ADR-0005 §5/§6):
**≥1 min pro, ≥5 min free** before it fires. The threshold lives in one place (`idleThresholdSeconds`)
and is the only tier-dependent number. Firing stays **server-side** and reads the account's **effective
tier** (ADR-0011), so a client can never unlock pro cadence.

### 3. Self-timed, reusing the existing episode engine

Because the condition is computed from the backend-clock `PaneActivity` timestamps, the exact idle
duration is already known when we evaluate it. So the backend emits a synthetic wire attention
`{ type: 'claude.idle', target: { machineId }, state: 'active' | 'cleared' }` — `active` **only once the
machine has already been quiet past the threshold** — and feeds it through the **unchanged**
`processAttentions` episode engine, with `thresholdSeconds('claude.idle') = 0` so the engine fires it
immediately rather than re-timing it (no double-counting). The engine still provides everything else: the
durable `Attention` row (survives restart), the 300 s **cooldown** (anti-spam), **clear-on-resume**, the
SSE `attention.update` fan-out, and `createForFired` → durable notification delivery. Notification text
is the privacy-safe, name-free **"All Claude sessions are idle"**.

Because a machine-level `"::"` target's leading sid is `""`, the engine's reportedSids-scoped clear never
touches it from the ingest path — so its lifecycle is driven **only** by the sweep's explicit
`active`/`cleared` emit, and the two `processAttentions` callers partition the attention space cleanly:
ingest passes the real session sids (touches only per-session rows), the sweep passes `{''}` (touches only
machine-level rows).

### 4. Firing: a backend sweep on a ~20 s timer

`sweepClaudeIdle` runs alongside the existing dispatch/prune sweeps in the entrypoint: for every online
machine it evaluates the condition from the machine's non-stale slices + activity maps and drives the
`claude.idle` row through the engine. ~20 s cadence → the notification fires within ~20 s of crossing the
threshold, independent of whether the plugin is still sending or anyone is watching.

### 5. Dashboard

`claude.idle` is an active, non-thinking attention, so it already folds into a machine's "N need
attention" count in `machines/service.ts` (it *is* a "go check them" state, unlike thinking, which
ADR-0025 excluded as "busy"). The detail view additionally surfaces it as a distinct machine-level
**"all Claude idle"** pill (its `"::"` target is not badged onto any pane/session). Broader presentation
stays governed by [ADR-0019](0019-ux-decisions-deferred.md).

## Consequences

**Positive**
- Delivers the most-requested cross-session signal — "all my Claude agents on this box went quiet" — as
  one machine-scoped notification, using data (`PaneActivity`) and machinery (the episode engine,
  notification delivery, SSE) that already exist. No wire-contract change, no new permission, no plugin
  change.
- Correct under ADR-0026: it fires precisely when the plugin has gone silent, because it runs on a
  backend timer over liveness-touched state — not on ingests that have stopped.

**Negative / costs**
- **Introduces a backend sweep**, which ADR-0026 had hoped to avoid. It is O(online machines) DB reads
  every ~20 s (mirroring the existing dispatch/prune sweeps) and can later be gated to machines whose
  newest activity is near the threshold.
- **Best-effort, and coupled to the derived silence clock.** If the user redacts pane commands, Claude
  panes are invisible to the detector and it cannot fire (consistent with the privacy model). A pane
  first observed already-frozen never fires (§1). A machine that goes **fully offline** (laptop closed)
  ages out of the sweep: it fires only if the threshold was crossed before it went dark, and afterwards
  neither re-fires nor clears — a distinct machine-offline/staleness attention is out of scope here.
- **Re-fires every cooldown (300 s) while a machine stays continuously idle** — the same anti-spam
  semantics as `claude.needs-input`. If a single fire per episode is preferred, raise the cooldown for
  this type.

**Neutral**
- Type stays an open string on the wire and the target's `machineId` field already existed; nothing
  downstream needed a contract change.

## References

- [ADR-0005](0005-attentions-detection-and-triggering.md) §3–§8 (attention model, tier thresholds,
  backend-derived injection) — this ADR implements §8 and adds `claude.idle`.
- [ADR-0025](0025-claude-thinking-attention.md) — the precedent for adding a new Claude attention via a
  supersedes-in-part ADR that reuses the v4 wire and the episode engine.
- [ADR-0026](0026-minimise-plugin-update-cadence.md) — the change-driven cadence (why a sweep is needed)
  and the control-poll liveness touch (why the sweep can trust non-stale state).
- [ADR-0011](0011-tiers-and-monetization.md) (effective tier), [ADR-0006](0006-notifications-web-push-and-channels.md)
  (delivery), [ADR-0019](0019-ux-decisions-deferred.md) (dashboard defaults).
