# ADR-0028 — Drop `session.detached` notifications; add machine-level `machine.offline`

- **Status:** Accepted
- **Supersedes (in part):** [ADR-0005](0005-attentions-detection-and-triggering.md) — retires `session.detached`
  as a *notifying* attention (detaching a session is normal usage, not something that needs the owner),
  and implements ADR-0005 §5's **backend-derived machine-offline** staleness signal, which had never
  been built. ADR-0005's detect-in-plugin / enforce-in-backend split, the `Observation` shape, wire
  contract v4, and every other attention are unchanged.
- **Amends:** [ADR-0027](0027-machine-idle-claude-attention.md) — extends its ~20 s machine-level sweep
  (now `sweepMachineAttentions`) to also compute `machine.offline`. Both machine-scoped attentions share
  the `"::"` `targetKey`, so they are emitted in **one** `processAttentions` call.
- **Builds on:** [ADR-0026](0026-minimise-plugin-update-cadence.md) (the ~5 s control-poll liveness touch
  keeps a live machine's `lastSeenAt` fresh, so a loss of contact is a real disconnect), [ADR-0008](0008-status-website.md)
  (`STALE_AFTER_MS` = the online/stale boundary), [ADR-0006](0006-notifications-web-push-and-channels.md) (delivery)
- **Date:** 2026-07-12
- **Deciders:** project owner
- **Tags:** attentions, notifications, backend, dashboard
- **Testing:** integration against **real MariaDB** — ingest drops `session.detached` while keeping other
  attentions; the sweep fires `machine.offline` once when a machine goes silent past `STALE_AFTER_MS`,
  respects the long cooldown (one per disconnect), clears when the machine returns, does not fire for an
  online machine nor for one dead beyond the 15-min lookback — see [ADR-0014](0014-testing-strategy.md)
- **Wire contract:** unchanged (**v4**).

## Context

`session.detached` fired for every Zellij session with **zero attached clients**. But detaching a
session and leaving it running is *how people use Zellij* — so it fired constantly (one dev machine had
**169** of them queued) and told the owner nothing actionable. What owners actually want is the opposite
scope: **notify me when the whole machine stops reporting** — the plugin died, the laptop closed, the
network dropped.

ADR-0005 §5 already named exactly this ("machine-offline / `session.stopped`, driven by staleness,
backend-derived") but nothing implemented it. And it *must* be backend-derived: an offline machine sends
nothing, so only the backend — watching `Machine.lastSeenAt` age out — can detect it. ADR-0026's
control-poll liveness touch bumps `lastSeenAt` every ~5 s for a live machine, so 60 s of silence
(`STALE_AFTER_MS`) is a genuine disconnect, not a quiet-but-live gap.

## Decision

### 1. Drop `session.detached`

The backend **filters `session.detached` out of the ingested `attentions[]`** before reconciliation
(`ingest/router.ts`) — authoritative and immediate, regardless of plugin version. Existing active rows
self-clear on the next ingest (the type is simply no longer in the reported set for that session's sids).
The plugin still emits it harmlessly for now; removing the plugin detector is a follow-up (it can't take
effect until the `.wasm` is reloaded anyway, which the backend filter makes unnecessary).

### 2. Add `machine.offline` — backend-derived, machine-scoped

Target `{ machineId }` (→ `targetKey` `"::"`, unique per machine by `type`). **Active** iff
`now − Machine.lastSeenAt > STALE_AFTER_MS`. Notification text: **"A machine went offline"**
(privacy-safe, name-free).

### 3. Firing: the shared machine-level sweep

Computed by the same ~20 s sweep as `claude.idle`, renamed **`sweepMachineAttentions`**. Per machine it
emits **both** machine-level attentions in **one** `processAttentions` call — they share the `"::"`
target, and the `"::"`-scoped end-of-tick clear would otherwise delete whichever one wasn't reported
that pass. `claude.idle` is only meaningful while online, so an offline machine forces it `cleared`.
`machine.offline` is **self-timed** (`thresholdSeconds('machine.offline') = 0` → fires as soon as the
sweep sees it offline) with a **long cooldown** (`cooldownSeconds` = 24 h) so it fires **once per
disconnect**; a reconnect clears the row, so the next drop fires anew. Only machines seen within a
**15-min lookback** are considered — a machine dead for hours is stale news, and the bound avoids a
burst of "offline" notifications for long-dead machines on first run.

### 4. Dashboard

`machine.offline` is **excluded from the "N need attention" count** (`machines/service.ts`) — the
machine's existing stale/offline card state already conveys the disconnect, so counting it would just
double-report it.

## Consequences

**Positive**
- Replaces a constant non-signal (`session.detached`) with the actionable one owners asked for
  ("your machine went offline"), reusing the episode engine, the ADR-0027 sweep, and the whole
  notification/SSE pipeline. No wire change, no new permission.
- Correct under ADR-0026: it reads liveness-touched `lastSeenAt`, so a live-but-quiet machine is not
  mistaken for offline, and a truly gone one is caught within ~20 s of crossing the 60 s boundary.

**Negative / costs**
- **Best-effort.** A flapping machine fires once per >60 s disconnect episode. A machine offline for
  more than the 15-min lookback keeps its single active row until it returns (or is forgotten) — it just
  won't re-fire. "Offline" can't distinguish a closed laptop from a network gap (same as the dashboard
  stale state — the data can't tell which).
- The plugin still emits `session.detached` until a follow-up removes the detector; the backend drops it.

**Neutral**
- Both new machine-level attentions are open-string `type`s on an unchanged v4 wire.

## References

- [ADR-0005](0005-attentions-detection-and-triggering.md) §3/§5 — retires `session.detached`; implements
  the machine-offline staleness signal it described.
- [ADR-0027](0027-machine-idle-claude-attention.md) — the machine-level backend sweep this extends.
- [ADR-0026](0026-minimise-plugin-update-cadence.md) (liveness touch), [ADR-0008](0008-status-website.md)
  (`STALE_AFTER_MS`), [ADR-0006](0006-notifications-web-push-and-channels.md) (delivery).
