# ADR-0051 — Tier-aware heartbeat snapshots with a machine claude-activity flag

- **Status:** Accepted
- **Amends:** [ADR-0026](0026-minimise-plugin-update-cadence.md) — bounds its "idle unwatched machine
  sends **nothing**" with a tier-paced heartbeat floor (the change-driven gate is otherwise
  unchanged); [ADR-0011](0011-tiers-and-monetization.md) — adds a tier-gated capability (data
  freshness bound: **30 s pro / 5 min free**).
- **Builds on:** [ADR-0029](0029-optin-longpoll-control-channel.md)/[ADR-0031](0031-longpoll-control-default-on.md)
  (the control channel that carries the interval), [ADR-0027](0027-machine-idle-claude-attention.md)
  (backend-derived `claude.idle` — still the authority on "across all sessions"),
  [ADR-0034](0034-reliable-claude-thinking-marker-freshness.md) (the per-pane freshness verdict the
  new flag aggregates), [ADR-0049](0049-plugin-debug-logging.md) (send-reason surfaced in debug logs)
- **Date:** 2026-07-22
- **Deciders:** project owner
- **Tags:** plugin, backend, cadence, tiers, wire
- **Testing:** plugin unit — cadence (heartbeat fires at the default 300-tick floor, at a
  backend-set 30, is clamped, resets on every send, and stays the **lowest-priority** reason);
  control parse (`heartbeatSec` absent → default, present → applied); snapshot (`claudeActive`
  aggregates own-session pane freshness); BDD — an idle unwatched machine heartbeats at the tier
  interval and nothing more. Backend integration — the control response carries `heartbeatSec` 30
  for a pro account and 300 for free; ingest accepts a snapshot with and without `claudeActive`.
  See [ADR-0014](0014-testing-strategy.md).
- **Wire contract:** **v4 unchanged** — one **additive optional** snapshot field (`claudeActive`);
  the backend's schema was already tolerant (unknown keys stripped), and old plugins simply omit it.
  The control channel is not part of the ingest contract (ADR-0026) and gains an additive
  `heartbeatSec` response field.

## Context

ADR-0026 made ingest change-driven: an idle, unwatched machine sends *nothing*. That is the core
cost win, but it leaves two gaps:

1. **No bounded-staleness guarantee.** `web_request` is fire-and-forget and the gate records a
   snapshot as sent whether or not it was delivered — a dropped or failed POST means the backend
   misses that state until the *next* change, potentially forever on a quiet machine.
2. **No explicit claude status.** The machine-level "is any claude session active?" picture is
   derived server-side from per-pane fingerprint changes (ADR-0027). The wire never states it, and
   when a claude pane merely goes quiet (freshness lapses by *time*, with no content change) the
   change-driven gate has nothing new to send — the backend only finds out by aging.

The owner wants a heartbeat: the plugin re-affirms its state — including claude active/inactive —
every **30 s**, degraded to **5 min for free accounts**. Only the backend knows the account's tier
(the plugin's ingest token is write-only), so the interval must come from the server.

## Decision

1. **Heartbeat = a normal ingest snapshot, no new endpoint.** `SendGate` gains a **lowest-priority**
   branch: send when `elapsed_since_last_send ≥ heartbeat_ticks`, even with no change (reason
   `heartbeat`, visible in the ADR-0049 debug line). Every send — whatever its reason — resets the
   clock, so a busy machine never sends *extra*; the heartbeat only bounds silence.
2. **The backend owns the tier policy.** The control response gains an additive `heartbeatSec`
   field: **30** when `effectiveTier` is pro, **300** when free (constants in `control/service.ts`).
   The plugin applies it, clamped to **[10 s, 3600 s]** (a buggy/hostile backend cannot make it
   spam), and defaults to **300 s** until the first control response arrives — free-tier behaviour,
   never better than the account is entitled to.
3. **The snapshot states claude activity: additive optional `claudeActive: boolean`.** True when at
   least one claude pane this instance observes is *fresh* (the same ADR-0034 verdict behind
   `claude.thinking`). Honest scope: scrollback is only readable for the instance's **own session**,
   so each per-session instance reports its own view and the backend — which merges per-machine —
   remains the authority on "across all sessions" (ADR-0027; its derivation is unchanged, the flag
   is corroborating/advisory and available to future consumers). The flag participates in the
   **salient** change-signature (an active↔idle transition is a content-level change → coalesced
   send within the 15/30 s floor) but **not** the structural one (it must not bypass the floors via
   the notable path).

## Consequences

- Backend data is never staler than ~30 s (pro) / ~5 min (free) per live session — lost sends
  self-heal within one heartbeat, and the claude active→idle *time-lapse* transition (invisible to
  the pure change-driven gate) now reaches the backend within a coalesce floor, worst-case one
  heartbeat.
- Idle-machine cost is no longer zero: one snapshot per interval **per session's plugin instance**
  (N sessions ⇒ N heartbeats per interval — each instance's own-session slice keeps its sids fresh).
  At 2/min (pro) this is ~2.5 % of the pre-ADR-0026 1/s rate; the change-driven win substantially
  stands.
- Tier degradation is server-enforced and self-applying: promo expiry flips the next control
  response to 300, no plugin involvement.
- Old plugin + new backend: `heartbeatSec` is ignored (unknown field), no heartbeat — old behaviour.
  New plugin + old backend: no `heartbeatSec` → the 300 s default still bounds staleness.
