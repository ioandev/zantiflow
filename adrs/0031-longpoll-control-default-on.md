# ADR-0031 — Long-poll control channel is ON by default

- **Status:** Accepted
- **Amends:** [ADR-0029](0029-optin-longpoll-control-channel.md) — flips the plugin `control_long_poll`
  default from **OFF** to **ON**. The mechanism (backend hold + wake registry, plugin watchdog FSM,
  additive `waitMs`) is unchanged; only the default and its justification change.
- **Date:** 2026-07-12
- **Deciders:** project owner
- **Tags:** plugin, performance, pane-output
- **Testing:** plugin native — `parse_config` defaults `control_long_poll` to true and an explicit `off`
  still forces the fixed poll (existing long-poll unit/integration coverage from ADR-0029 is unchanged).
  End-to-end latency is confirmed by loading the rebuilt `.wasm` in real Zellij (the ADR-0029 smoke,
  now performed by running with the default on). See [ADR-0014](0014-testing-strategy.md).
- **Wire contract:** unchanged (**v4**).

## Context

ADR-0029 shipped long-poll opt-in / OFF by default, gated on a real-Zellij smoke, because it was unknown
whether Zellij's `web_request` host holds a long request (FINDINGS.md §5). The practical result: pane
output still took **up to ~5 s** to fetch — the ADR-0026 fixed 5 s control poll — because nobody had the
flag on. The owner wants the fast path to be the default.

The key realisation that makes default-on safe is that long-poll **self-degrades**, so it is a latency
win regardless of whether the host actually holds requests:

- **Host holds and delivers on a wake** → a pending-output/refresh request wakes the parked poll → ≈1 s.
- **Host doesn't hold** (returns immediately, ignoring `waitMs`) → the plugin re-issues on the next ~1 s
  tick → effectively a ~1 s poll → ≈1 s latency (at the cost of ~1 control request/s while running).
- **Host holds and idles** (no wake) → returns empty at the 25 s clamp → low traffic; a real request
  still wakes it in ≈1 s.

The only regression is a host that **holds and then silently drops** a request (never delivers any
result): the plugin's watchdog re-issues after ~35 s, so latency is worse than the 5 s fixed poll. That
case is uncommon and **immediately visible** on reload, and `control_long_poll off` reverts to the fixed
poll.

## Decision

1. **`control_long_poll` defaults to ON** (`config.rs`); an explicit `off` forces the ADR-0026 fixed
   ~5 s poll. An invalid value uses the default (ON) with a warning.
2. **Tighten the dashboard drawer poll** (`PaneOutputDrawer.tsx`) from 2 s to **1 s** while pending, so
   the website side doesn't re-add latency once the plugin captures in ≈1 s.
3. Takes effect only after the plugin `.wasm` is **rebuilt and reloaded** — the running plugin predates
   ADR-0029. That reload is the real-Zellij verification ADR-0029 asked for.

## Consequences

**Positive**
- Pane-output and refresh feel near-instant (≈1 s) out of the box, no config needed.
- Robust: a latency win whether or not the host holds requests (self-degradation above).

**Negative / costs**
- If the host does not hold requests, "on by default" means ~1 control request/s per running session —
  more than ADR-0026's held-poll ideal (though still cheap, and it does not change snapshot-send cadence
  or the ingest traffic ADR-0026 targeted). A deployment that cares can set `control_long_poll off`.
- Residual bad case: a host that silently drops held requests → ~35 s via the watchdog. Visible on
  reload; disable to revert.

**Neutral**
- No wire/API/schema change; purely the plugin default plus a web poll interval.

## References

- [ADR-0029](0029-optin-longpoll-control-channel.md) — the long-poll mechanism whose default this flips.
- [ADR-0026](0026-minimise-plugin-update-cadence.md) — the fixed 5 s poll that remains the `off` fallback.
- [FINDINGS.md](../FINDINGS.md) §5 — `web_request` host-hold behaviour (the reason it was gated).
