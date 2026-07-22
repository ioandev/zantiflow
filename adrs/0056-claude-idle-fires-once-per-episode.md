# ADR-0056 — `claude.idle` fires once per idle episode

- **Status:** Accepted
- **Amends:** [ADR-0027](0027-machine-idle-claude-attention.md) — replaces its 300 s cooldown with
  the once-per-episode pattern [ADR-0028](0028-machine-offline-attention.md) established for
  `machine.offline` (24 h cooldown + clear-on-resume re-arm).
- **Date:** 2026-07-22
- **Deciders:** project owner
- **Tags:** backend, attentions, notifications
- **Testing:** backend integration — still-idle past the old 300 s window does **not** re-fire; a
  resume (clear) followed by a new idle episode fires anew (row deletion resets the cooldown).
- **Wire contract:** unchanged (**v4**) — backend policy only.

## Context

The moment `claude.idle` actually started firing (ADR-0055 fixed its pane scope), its inherited
default **300 s cooldown** produced a *"All Claude sessions are idle"* Telegram/Discord message
**every 5 minutes for as long as the machine stayed idle** — an idle machine is the steady state,
so this nags indefinitely. Owner requirement: notify **once** when everything goes quiet, then stay
silent until some Claude session becomes active again and the machine goes idle again.

The episode engine already supports exactly this (proven by `machine.offline`, ADR-0028): a fire
records `lastFiredAt` on the attention row; a **clear deletes the row** (clear-on-resume), wiping
the cooldown state — so a long cooldown means "once per continuous episode" while a new episode
(after real activity) fires immediately.

## Decision

`cooldownSeconds('claude.idle')` = **24 h** (same bucket as `machine.offline`). Semantics:

- Machine goes all-idle → **one** notification (~60–80 s pro / ~5 min free after the last activity).
- Stays idle → silence (a >24 h continuously-idle machine may re-fire once a day — acceptable, and
  identical to `machine.offline`'s accepted behavior).
- Any Claude pane becomes active → the sweep clears the episode (row deleted) → the **next**
  all-idle episode fires again, immediately on crossing its threshold.

## Consequences

- The 5-minute nag observed live (2026-07-22, ~18:26 onward) stops; per-session attentions
  (needs-input/thinking) keep their 300 s cooldown — unchanged.
- Both machine-level attentions now share one cooldown rule, stated in `attentions/policy.ts`.
