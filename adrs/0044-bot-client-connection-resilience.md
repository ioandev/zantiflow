# ADR-0044 — Bot WebSocket client connection resilience: anti-flap backoff, keepalive tuning & supervised self-restart

- **Status:** Accepted (implemented)
- **Amends:** [ADR-0007](0007-chat-bot-notification-channels.md) — makes concrete its generic "bot reconnects with backoff" (§2 Resilience)
- **Refines / depends on:** [ADR-0009](0009-durable-notification-delivery.md) — durable replay only fires *after* a reconnect, and only if the process stays up (or restarts cleanly) to reconnect at all; [ADR-0010](0010-bots-in-python-and-token-storage.md) — built on the chosen Python `websockets` client; [ADR-0021](0021-dockerization-and-deployment.md) — the container `restart: unless-stopped` policy is the supervisor this relies on
- **Scope:** the shared `@zantiflow/notify-protocol` Python package (`packages/notify-protocol`), used by **both** `apps/discord-bot` and `apps/telegram-bot`
- **Date:** 2026-07-12
- **Deciders:** project owner
- **Tags:** bots, resilience, websocket, python

> **Retroactive ADR:** This decision was already implemented in the codebase before this ADR was written; it is recorded here after the fact to close a documentation gap — it was not written at the right time.

## Context

[ADR-0007](0007-chat-bot-notification-channels.md) established that each bot dials an **outbound**
WebSocket to the backend (`wss://…/internal/bots`) and, under *Resilience* (§2), stated only that "the
bot reconnects with backoff" — the backend queues deliveries while a bot is away and replays on
reconnect. [ADR-0009](0009-durable-notification-delivery.md) made that replay durable (MariaDB rows,
per-channel ack, idempotent `deliveryId`). [ADR-0010](0010-bots-in-python-and-token-storage.md) chose
the Python `websockets` library for the client. None of those ADRs specify **how** the reconnect
loop actually behaves — and the concrete client behaviour, now shipped in
`packages/notify-protocol/src/zantiflow_notify/client.py` (`BotClient`), embeds several non-obvious
decisions that are load-bearing for reliability and were reached by fixing a real incident:

- A naive "reset the backoff as soon as the socket opens" loop turns a **flapping** backend
  (mid-restart, crash-looping, or aborting the TCP right after `accept` — the *"no close frame
  received or sent"* case) into an endless **~1 Hz reconnect storm** that hammers the recovering
  backend and never lets it come back. This actually happened (the "stuck bots" incident that
  `tests/test_client_integration.py` reproduces).
- The backend culls a silent socket after a fixed idle window
  (`MAX_IDLE_MS = 15_000` in `apps/backend/src/bots/ws.ts`), so the client's keepalive cadence must
  be chosen *relative to that number*, not in isolation, or a perfectly healthy bot gets disconnected.
- `run_forever()` is an infinite loop by contract; if it ever *exits* — by crash or by returning —
  the bot process would keep serving Discord/Telegram while **silently no longer talking to the
  backend** (a "half-dead" bot). asyncio makes this worse: it holds only a weak reference to a bare
  task, and an unretrieved task exception vanishes.

Because this logic is identical for both bots, it lives once in the shared package
(`@zantiflow/notify-protocol`, per [ADR-0015](0015-modular-code-organization.md)), and both bots
consume it through `BotClient.start()` (`apps/discord-bot/bot.py`, `apps/telegram-bot/bot.py`). This
ADR records those decisions; it is strictly about **connection resilience / supervision** and does
**not** touch the protocol, the delivery queue, replay, or idempotency (owned by ADR-0007/0009/0010).

## Decision Drivers

- **Don't storm a recovering backend.** A backend that flaps must not be beaten down by a client
  reconnect loop; backoff must actually *grow* under sustained flapping.
- **Recover fast from a genuine single blip.** A one-off drop of an otherwise-healthy connection
  should reconnect quickly, not inherit a grown delay.
- **Never get culled while healthy.** Keepalive must be tuned so a live bot stays inside the
  backend's idle window.
- **Fail loud, not half-dead.** A dead backend link must never be silent; a wedged bot is worse than
  a restarted one, because durable replay (ADR-0009) can only catch up once a *working* connection
  is re-established.
- **Lean on the orchestrator.** Prefer letting the supervisor (`restart: unless-stopped`, ADR-0021)
  bring up a fresh process over trying to self-heal an arbitrarily corrupted in-process state.
- **Testable in isolation** (ports & adapters, [ADR-0014](0014-testing-strategy.md)) — the
  process-terminating side effect must be stubbable without killing the test runner.

## Considered Options

- **Backoff reset trigger:**
  - Reset on socket-open (naive) — simplest, but **causes the 1 Hz storm** against a flapping backend.
  - **Reset only after the connection has been stable ≥ `STABLE_CONNECTION_SEC`** *(chosen)* — a
    short-lived session keeps the backoff growing; a genuinely-up session resets it.
  - Never reset (pure monotonic backoff) — safe against storms but punishes a healthy bot after one
    blip with an ever-growing delay.
- **Backoff schedule:** **exponential doubling from 1 s, capped at 30 s, no jitter** *(chosen)* —
  simple and adequate for a **single** long-lived client per bot (no thundering-herd of many clients
  to de-correlate, so jitter buys little); vs adding jitter (deferred — see Risks).
- **Keepalive:** **library ping/pong (`websockets` `ping_interval`/`ping_timeout`) tuned below the
  backend's 15 s idle cutoff** *(chosen)* — no application-level heartbeat message needed (the
  backend's `ws` server auto-responds to pings); vs a custom protocol ping (redundant), vs no
  keepalive (silent half-open sockets go undetected).
- **On WS-loop death:** **terminate the process via SIGTERM so the supervisor restarts it** *(chosen)*
  — clean, orchestrator-friendly; vs restart the loop in-process (risks looping over a corrupt
  state), vs let it die silently (the half-dead bot — unacceptable). SIGTERM (not `os._exit`) so
  aiogram / discord.py run their graceful-shutdown handlers.
- **Task launch:** **`start()` holds a strong reference + attaches a done-callback** *(chosen)* — vs
  a bare `asyncio.create_task(run_forever())`, which asyncio may GC mid-flight and whose escaping
  exception would be swallowed.

## Decision

All identifiers below are in `packages/notify-protocol/src/zantiflow_notify/client.py` unless noted.

### 1. Anti-flap backoff-reset gate

`run_forever()` records `opened_at = time.monotonic()` the moment the socket actually opens, and after
each disconnect resets `backoff = 1.0` **only if** the connection stayed up at least
`STABLE_CONNECTION_SEC = 5.0` seconds:

```python
if opened_at is not None and (time.monotonic() - opened_at) >= self.stable_after:
    backoff = 1.0
await asyncio.sleep(backoff)
backoff = min(backoff * 2, max_backoff)
```

A socket that opened and dropped almost immediately (a flapping backend) — or a connect that never
opened at all (`opened_at is None`) — leaves the backoff **growing** rather than resetting, so the
client stops storming and lets the backend recover. `STABLE_CONNECTION_SEC` is deliberately
comfortably longer than a flap (sub-second to ~1 s) yet far shorter than a real session.
`stable_after` is a constructor parameter (default `STABLE_CONNECTION_SEC`) so tests can vary it.

### 2. Backoff schedule

Exponential doubling: base **`backoff = 1.0` s**, `backoff = min(backoff * 2, max_backoff)` per
disconnect, capped by **`max_backoff = 30.0` s** (a `run_forever` parameter). **No jitter** — a bot
runs a single long-lived client, so there is no fleet to de-correlate. Growth is `1 → 2 → 4 → 8 → 16
→ 30 → 30 …` while flapping continues.

### 3. Keepalive tuning coupled to the backend idle cutoff

The client passes `ping_interval=PING_INTERVAL` / `ping_timeout=PING_TIMEOUT` to
`websockets.connect`, with **`PING_INTERVAL = 10.0`** and **`PING_TIMEOUT = 5.0`** seconds. The
interval is chosen to sit **below the backend's own idle-disconnect threshold** — `MAX_IDLE_MS =
15_000` in `apps/backend/src/bots/ws.ts`, which `ws.terminate()`s any socket it hasn't heard from in
15 s — so a healthy bot pings roughly every 10 s and is never culled. If no pong returns within
`PING_TIMEOUT`, `websockets` closes the connection as dead, which drops into the reconnect loop
(§1–2). No application-level heartbeat frame is used: the backend's `ws` server auto-replies to
protocol pings, and it treats an inbound ping/pong as a liveness touch. **This 10 s / 15 s coupling
is the fragile part — the two constants live in different languages and repos and must move together.**

### 4. Supervised WS-loop task with SIGTERM self-restart

`BotClient.start()` launches `run_forever()` as a **supervised** background task:

- it stores the task on `self._task` (asyncio keeps only a *weak* reference, so an un-kept task can be
  garbage-collected mid-flight), and
- attaches `task.add_done_callback(self._on_task_done)`.

`_on_task_done` treats **any** completion of `run_forever` as a fault, because it is meant to loop
forever:

- **cancelled** → return (a clean, graceful shutdown — exempt);
- **raised an exception** → `log.critical(..., exc_info=exc)` then terminate;
- **returned normally** → `log.critical(...)` then terminate.

Termination is `_terminate_process()`, which sends **`os.kill(os.getpid(), signal.SIGTERM)`** — a
graceful signal (so aiogram / discord.py run their shutdown handlers), *not* `os._exit`. The process
exits and the supervisor (`restart: unless-stopped`, ADR-0021) starts a **fresh, fully-working** bot,
rather than leaving one that still serves chat with a dead backend link. `_terminate_process` is a
module-level function precisely so tests can stub it (asserting the supervisor *would* fire) without
killing the test runner.

Both bots use this: the Discord bot calls `self.ws.start()` from its `on_ready` handler
(`apps/discord-bot/bot.py`), and the Telegram bot calls `self.ws.start()` from `run()` before
`start_polling` (`apps/telegram-bot/bot.py`). The chat-side framework (discord.py client /
aiogram polling) remains the process's main coroutine; the WS client is the supervised side task.

### 5. Frame-parse isolation (loop hardening)

Inside the receive loop, a frame that fails `parse_backend_message` is logged (`"dropping unparseable
frame"`) and skipped — one bad frame never kills the loop or trips the supervisor. (The parsing /
schema itself is ADR-0010's concern; this is only the "don't crash on it" guard.)

## Consequences

**Positive**
- A flapping/crash-looping backend is met with **growing** backoff (proven up to the 30 s cap), not a
  1 Hz storm — the recovering backend gets breathing room.
- A genuine single blip still reconnects in ~1 s (backoff resets after a stable session).
- A healthy bot is never idle-culled (10 s ping < 15 s backend cutoff) with no custom heartbeat.
- No half-dead bots: a dead WS loop always becomes a **loud log + clean restart**, so ADR-0009's
  durable replay reliably gets a working connection to catch up on.
- The logic is written and tested **once** in the shared package; both bots inherit it identically.

**Negative / costs**
- The **10 s ping vs 15 s backend idle cutoff** is a cross-repo, cross-language coupling with no
  compile-time link; changing one without the other silently regresses (spurious disconnects or missed
  culls).
- SIGTERM self-restart **depends on an external supervisor** (`restart: unless-stopped`); run outside
  an orchestrator (bare `python bot.py`), a crash just exits and stays down.
- No jitter means many co-located clients would reconnect in lockstep — fine at one-client-per-bot,
  a latent limit if that ever changes.
- Backoff caps at 30 s, so a long backend outage means up to ~30 s of extra latency before the bot
  reconnects and replay begins (acceptable given ADR-0009's minutes-to-hours retention window).

**Neutral**
- Makes ADR-0007's generic "reconnect with backoff" concrete; changes nothing on the wire or in the
  protocol/queue/replay design (ADR-0007/0009/0010 stand). Plugin↔backend wire contract unchanged (v4).

## Open Questions / Risks

1. **The 10 s / 15 s coupling has no shared source of truth** — `PING_INTERVAL` (Python) and
   `MAX_IDLE_MS` (TS) are independently declared. Risk: an edit to one drifts from the other.
   Mitigation for now: both carry cross-referencing comments; consider surfacing the idle cutoff in
   the protocol/handshake so the client can derive its ping interval.
2. **No jitter** in the backoff — safe for a single client per bot, but revisit if a deployment ever
   runs multiple clients that could synchronize.
3. **`STABLE_CONNECTION_SEC = 5.0` is a heuristic** — if a real backend legitimately closes healthy
   sessions in under 5 s (it shouldn't), the client would keep backing off; tune if observed.
4. **Supervisor assumption** — the self-restart is only as good as the orchestrator; documented as a
   deployment requirement (ADR-0021). A non-containerized run needs its own supervisor (systemd, etc.).

## Testing

Per [ADR-0014](0014-testing-strategy.md), the resilience behaviour ships with tests in
`packages/notify-protocol/tests/`:

- **Unit** (`test_client.py`, default suite): keepalive kwargs are passed through to
  `websockets.connect` and defaults are `PING_TIMEOUT == 5.0`; a **flapping backend keeps backing off**
  (`test_flapping_backend_keeps_backing_off` asserts sleeps `[1.0, 2.0, 4.0, 8.0]` — no reset); a
  **stable connection resets** the backoff (`test_stable_connection_resets_backoff` asserts `[1.0,
  1.0, 1.0]`); the supervisor **terminates on crash** and on **clean-but-unexpected exit**, and
  **ignores clean cancellation**; `start()` **holds the task reference and wires supervision**.
  `_terminate_process` is monkeypatched so the runner is never killed.
- **Integration** (`test_client_integration.py`, `-m integration`, excluded from the default run):
  drives the shipped `BotClient` against a **real** localhost `websockets` server that accepts, holds
  briefly, then `transport.abort()`s (reproducing the exact *"no close frame received or sent"*
  incident) and asserts the client **backs off** — few reconnects with clearly growing gaps — rather
  than storming at ~1 Hz.

## References

- `packages/notify-protocol/src/zantiflow_notify/client.py` — `BotClient`, `run_forever`, `start`,
  `_on_task_done`, `_terminate_process`; `PING_INTERVAL` / `PING_TIMEOUT` / `STABLE_CONNECTION_SEC`.
- `apps/backend/src/bots/ws.ts` — the backend `MAX_IDLE_MS = 15_000` idle sweep this ping cadence is
  tuned against.
- `apps/discord-bot/bot.py`, `apps/telegram-bot/bot.py` — consumers calling `self.ws.start()`.
- `packages/notify-protocol/tests/test_client.py`, `…/test_client_integration.py` — the tests above.
- `deploy/docker-compose.example.yml` — `restart: unless-stopped` (ADR-0021), the supervisor.
- ADR-0007 (bot WS + generic backoff), ADR-0009 (durable replay this enables), ADR-0010 (Python
  `websockets` client), ADR-0014 (testing), ADR-0015 (shared-package promotion), ADR-0021 (container
  restart policy).
