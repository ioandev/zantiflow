# ADR-0029 — Opt-in long-poll for the control channel

- **Status:** Accepted
- **Amends:** [ADR-0026](0026-minimise-plugin-update-cadence.md) — the always-on control poll keeps its
  fixed ~5 s cadence as the default; this adds an **opt-in** mode where the plugin asks the backend to
  hold each poll open. The liveness-touch / presence / pending-output / refresh semantics are unchanged.
- **Amends:** [ADR-0016](0016-dashboard-page-and-pane-output.md) — realises the "live-while-open via a
  held connection is a possible later enhancement" note (§ Delivery model) as a latency improvement for
  the on-demand pane-output channel, without moving output onto the ingest path.
- **Date:** 2026-07-12
- **Deciders:** project owner
- **Tags:** plugin, backend, protocol, pane-output, performance
- **Testing:** backend **unit** (the in-process wake registry: signal wakes a parked wait, timeout
  resolves, machine-scoped, multi-waiter) + **integration** against real MariaDB (`waitMs` omitted →
  immediate; `waitMs` with work already pending → immediate; a held poll woken by a view-request and by
  the refresh button; a held poll that times out empty). Plugin **native** (the pure `control_poll_due`
  decision incl. the watchdog; the `control_long_poll` config flag fails closed; `build_control_request`
  carries `waitMs` only when > 0). The one thing no layer can prove — that Zellij's `web_request` host
  actually *holds* a long request — is a **manual real-Zellij smoke** (throwaway session only), and gates
  ever defaulting the flag on. See [ADR-0014](0014-testing-strategy.md).
- **Wire contract:** ingest **unchanged (v4)**. The `@zantiflow/protocol` **control** request gains an
  optional `waitMs` (additive; absent = today's behaviour).

## Context

Pane output is an on-demand channel (ADR-0016): the website registers a request, and the plugin picks it
up on its next control poll (ADR-0026 folded the old output poll into the control channel). With a fixed
~5 s poll, a "show me this pane" click waits **up to ~5 s** before the plugin even learns of it — plus
the capture/deliver round-trip. The manual refresh button has the same up-to-5 s tail.

A true server push (SSE/WebSocket the plugin subscribes to) is **not possible** from a Zellij plugin:
`web_request` delivers a single, fully-buffered `WebRequestResult` — there is no streaming-body callback
and no persistent socket (FINDINGS.md §5). The plugin can only make discrete request→result calls.

The request→result shape *can*, however, express **HTTP long-polling**: the plugin issues a control poll
and the backend holds the response open until there is something to act on (or a timeout), then the
plugin re-issues. That cuts the pending-output / refresh latency from up to ~5 s to ≈1 s while sending
*fewer* requests than the fixed poll — in the spirit of ADR-0026, not against it.

The catch: it depends on the Zellij host actually holding an outbound request open, which FINDINGS.md §5
flags as unverified ("depends on Zellij being built/allowed with web access"). So this is added as an
**opt-in, OFF-by-default** mode, with the fixed poll retained as the default and permanent fallback.

## Decision

### 1. Protocol — additive `waitMs`

`ControlRequest` gains an optional `waitMs` (int, 0–30 000). Absent/0 ⇒ respond immediately (the current
behaviour). `> 0` ⇒ the backend may hold the response up to that long. The response shape is unchanged.

### 2. Backend — hold, then wake

A new in-process **wake registry** (`control/waiters.ts`; single-backend, no Redis — like the SSE bus
and presence tracker, ADR-0019) parks a held poll per `machineId`. `handleControl` does its
(always-immediate) liveness touch and first compute; then, only if `waitMs > 0` **and** there is nothing
pending, it parks on the registry until a **latency-sensitive event** signals it — a new pane-output
request (`registerRequest`) or a manual refresh (`bumpRefresh`) — or the clamped timeout
(`MAX_WAIT_MS = 25 s`, safely below the 60 s read-filter) fires, then recomputes once and returns. A
client disconnect during the hold releases the parked promise (`res.on('close')`). The immediate path is
byte-for-byte unchanged when `waitMs` is absent.

Not signalled: viewer-presence marks (SSE heartbeats, dashboard reads). Those tolerate the timeout — only
output and refresh are latency-sensitive. Any signal that races ahead of the park is not lost: the state
(the pending row, the refresh counter) is durable, so the next poll or the recompute-after-timeout still
delivers it — just later, bounded by `waitMs`.

### 3. Plugin — opt-in flag + watchdog FSM

A new KDL flag `control_long_poll` (OFF by default; fails closed on an invalid value). With it **off**,
`cadence::control_poll_due` fires the poll every `CONTROL_POLL_EVERY_TICKS` (5) exactly as before. With
it **on**, the plugin keeps a single request outstanding: it re-issues when nothing is in flight, and a
**watchdog** (`CONTROL_WATCHDOG_TICKS = 35`, comfortably above the 25 s hold) re-issues if no
`WebRequestResult` returns — so a silently dropped hold can't stall the loop. `build_control_request`
sends `waitMs = LONG_POLL_WAIT_MS` (25 s) only in this mode. On any terminal control result (2xx or not)
the in-flight flag clears so the next ~1 s timer re-arms; a non-2xx (e.g. a proxy 504 on a held request)
is logged, not fatal. The decision logic is a pure, natively-tested function; `plugin.rs` only feeds it
state.

### 4. Default stays the fixed poll

`control_long_poll` ships OFF. Long-poll is a strict overlay: the fixed 5 s poll remains the shipped
default and the fallback if the host won't hold requests. Turning it on is gated on the real-Zellij smoke.

## Consequences

**Positive**
- Pane-output and refresh latency drop from up to ~5 s to ≈1 s + RTT, with *fewer* control requests than
  the fixed poll (one held request per idle window instead of one every 5 s).
- No new permission, no ingest wire change, no server push. Reuses the existing control endpoint and the
  in-process presence/bus pattern.
- Purely additive and reversible: OFF reproduces the exact ADR-0026 behaviour.

**Negative / costs**
- Hinges on the Zellij host holding a long `web_request`. The watchdog degrades gracefully **only if the
  host returns *some* result on timeout/drop** (then it falls back to ~watchdog-interval re-polls). If the
  host drops a held request with **no** result at all, long-poll would re-poll only every ~35 s — *worse*
  than the fixed 5 s. Hence it must clear the real-Zellij smoke before being enabled anywhere.
- One held backend request per long-poll machine (cheap under async Node, but non-zero); the wake registry
  is the only new server-side state.
- A signal that races ahead of the park incurs up-to-`waitMs` tail latency in that rare window (nothing is
  lost, just delayed).

**Neutral**
- The control protocol is versioned in `@zantiflow/protocol`; `waitMs` is an additive, back-compatible field.

## Open Questions / Risks

- **Host hold behaviour (blocking).** Does `web_request` hold a 25 s request and deliver a result on
  timeout/drop? Unverified (FINDINGS.md §5). Resolve via the throwaway-session smoke before defaulting on.
- **Proxy timeouts.** A reverse proxy (Caddy, ADR-0021) must allow a 25 s idle response; `MAX_WAIT_MS`
  sits under common defaults but self-hosters may need to tune it.

## References

- [ADR-0026](0026-minimise-plugin-update-cadence.md) — the always-on control channel this makes long-poll-capable.
- [ADR-0016](0016-dashboard-page-and-pane-output.md) — the on-demand pane-output channel whose latency this improves.
- [FINDINGS.md](../FINDINGS.md) §5 — `web_request` is single-buffered fire-and-forget; no streaming, no socket.
- [ADR-0014](0014-testing-strategy.md) — test layers + the real-Zellij smoke gate.
