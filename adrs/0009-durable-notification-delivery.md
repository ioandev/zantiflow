# ADR-0009 — Durable notification delivery: MariaDB-backed queue, per-channel ack, replay & cleanup

- **Status:** Accepted
- **Amends:** [ADR-0006](0006-notifications-web-push-and-channels.md) (delivery becomes persisted + acked), [ADR-0007](0007-chat-bot-notification-channels.md) (the per-platform queue becomes DB-backed & durable — resolves its Open Question 5)
- **Resolves:** [ADR-0003](0003-multi-tenant-backend-and-token-auth.md)'s open datastore question → **MariaDB**
- **Date:** 2026-07-10
- **Deciders:** project owner
- **Tags:** notifications, delivery, mariadb, durability, queue, cron, ack
- **Testing:** unit (delivery state machine, retry) + integration (MariaDB queue, restart → replay) — see [ADR-0014](0014-testing-strategy.md)
- **Wire contract:** unchanged (refines backend delivery internals + backend↔bot replay)

## Context

[ADR-0006](0006-notifications-web-push-and-channels.md) defined the notifier and per-channel delivery
status as *best-effort*; [ADR-0007](0007-chat-bot-notification-channels.md)'s per-platform delivery
queue was **in-memory** (its Open Question 5). We now require **durable** delivery:

- Every notification delivery is **persisted in MariaDB** and **acked** when the channel confirms
  success.
- A **cron** prunes rows older than a retention window — **default 6 hours, configurable**.
- A notification going to multiple channels **appears as multiple rows** — one per channel, each acked
  independently.
- **Bots can restart without missing messages** — on reconnect they **pick up where they left off**
  from the persisted, unacked rows.

## Decision Drivers

- **Durability:** survive bot *and* backend restarts without losing notifications (at-least-once).
- **Per-channel accountability:** independent status / ack / retry per channel.
- **Bounded storage:** scheduled pruning.
- **One datastore** — don't add a second system.
- **Exactly-once *effect*** via idempotent dedup.

## Considered Options

- **Datastore:** **MariaDB** *(chosen, per project owner)* — resolves ADR-0003's open question and
  matches the commenttoday MySQL/Prisma precedent; vs the earlier "Postgres recommended" note, vs a
  dedicated broker (Redis/RabbitMQ — heavier; unneeded at this scale).
- **Queue substrate:** the **MariaDB table as the queue** (claim via `SELECT … FOR UPDATE SKIP LOCKED`,
  MariaDB 10.6+) *(chosen)* — durable + gives history for free; vs an external broker.
- **Grouping:** **one logical `Notification` → N per-channel `NotificationDelivery` rows** *(chosen)* —
  matches "appears multiple times per channel."
- **TTL scope:** prune **delivered** (cleanup) **and stale-pending past TTL** (expired) *(chosen)* — vs
  keep-until-delivered (unbounded growth if a channel is down; and a 6h-late attention ping is
  worthless anyway).

## Decision

### 1. Datastore = MariaDB

The backend standardizes on **MariaDB** (accounts, machines, tokens, channel links, notifications, …)
via the ORM (Prisma, matching the JS backend / commenttoday precedent). This **resolves ADR-0003's
datastore open question** and supersedes its "Postgres recommended" note.

### 2. Model

- **`Notification { id, accountId, source (attentionType + target), text, createdAt }`** — the logical
  event (one per fired ADR-0005 trigger; `text` is composed **privacy-honored** per ADR-0002/0006).
- **`NotificationDelivery { id, notificationId, accountId, channel (webpush|discord|telegram),
  recipientRef, status (pending|delivered|failed|expired), attempts, createdAt, dispatchedAt?, ackedAt?,
  lastError? }`** — **one row per channel** (this is what "appears multiple times") and the **durable
  queue unit**. `recipientRef` = a push-subscription id, or a `ChannelLink`/`platformUserId`.
- Indexes for the dispatcher/cron: `(channel, status)`, `(status, createdAt)`.

### 3. Dispatch + ack

- On a fired trigger, the notifier (ADR-0006) writes one `Notification` + one `NotificationDelivery`
  per eligible channel (`status = pending`).
- A **dispatcher worker** claims pending rows with `SELECT … FOR UPDATE SKIP LOCKED`, bumps
  `attempts`/`dispatchedAt`, and dispatches:
  - **web-push** → send via `web-push`; **delivered** on push-service 2xx; on `404`/`410` mark
    `failed` **and prune the dead subscription**.
  - **Discord/Telegram** → send over the bot WS (ADR-0007), tagged with `deliveryId`.
- **Ack:** web-push acceptance = `delivered` (best-effort — push acceptance, *not* device-confirmed);
  bots return `delivery_result{ delivered|failed }` (ADR-0007) → set `ackedAt` + status. On failure,
  retry with backoff up to N attempts, then `failed`.

### 4. Durable replay (restart-safe)

Because deliveries are **rows**, nothing lives only in memory:

- On a **bot reconnect** (ADR-0007 WS), the backend **replays all `pending` deliveries for that
  platform** — "pick off where they left off."
- On a **backend restart**, the dispatcher resumes from `pending` rows.
- **Idempotent dedup** via `deliveryId` (ADR-0007) makes at-least-once **effectively once**.

This **resolves ADR-0007's Open Question 5** (queue durability across restarts).

### 5. Cleanup cron

A scheduled job prunes `NotificationDelivery` (and orphaned `Notification`) rows older than the
**retention TTL — default 6h, configurable** (`NOTIFICATION_RETENTION_HOURS`). It removes **delivered**
rows (cleanup) and **still-pending past TTL** (marked `expired` — a stale ping isn't worth sending).
Runs periodically (e.g. every ~15 min), batching deletes. **The TTL is also the durability window:** a
channel down longer than the TTL loses those deliveries (acceptable — they're stale).

### 6. Relationship to the website (ADR-0008)

This 6h **delivery queue** is **distinct** from ADR-0008's longer-lived **attention-episode / activity
history**. The website's history reads the attention store (its own retention), **not** the pruned
delivery queue. Longer notification history, if wanted, lives in the attention store — not here.

## Consequences

**Positive**
- Durable, restart-safe, **at-least-once** (idempotent → once) delivery; per-channel ack/retry/visibility.
- Bounded storage via the cron; **single datastore** (MariaDB); DB-as-queue is simple and yields
  history for free.
- Resolves ADR-0003's datastore question and ADR-0007's durability question.

**Negative / costs**
- DB-as-queue overhead (claim via SKIP LOCKED, indexes, a worker loop); a cron to operate.
- The retention TTL means a **>6h channel outage drops stale notifications** (by design).
- web-push "delivered" = push **acceptance**, not true device receipt.
- Multi-worker / multi-backend claiming needs SKIP LOCKED discipline.

**Neutral**
- Amends ADR-0006 (persisted, acked delivery) and ADR-0007 (durable queue); picks MariaDB for the
  whole backend; no plugin/wire-contract change.

## Open Questions / Risks

1. **Retry policy** per channel (max attempts, backoff) and when to mark `failed` vs keep retrying
   within TTL. **Decided:** exponential backoff, ~5 attempts within the TTL, then `failed`.
2. Should **pending-at-TTL** be surfaced to the user ("couldn't deliver") — **decided:** surfaced in the dashboard, not silent.
3. **DB-as-queue scaling** ceiling — fine at expected volume; move to a broker (Redis Streams/RabbitMQ)
   if it grows. Flag. **Decided:** no Redis/broker — MariaDB DB-as-queue at current volume; revisit only if it ever grows.
4. **Cron cadence vs retention** — batch deletes to avoid large bursts. **Decided:** cleanup runs ~every 15 min, batched.
5. **web-push receipt** is unconfirmable — consider a client-side ack (service-worker `postMessage`) if
   true receipt matters. **Decided:** `delivered` = push-service acceptance; a client-side SW ack is a future option.
6. Website notification-history length depends on the **attention store** retention, not this queue
   (§6) — finalize with ADR-0008. **Resolved:** there is no attention-history store (latest state only); only the 6 h delivery queue persists.

## References

- ADR-0003 (datastore question, accounts), ADR-0006 (notifier/delivery pipeline), ADR-0007 (bot WS,
  `deliveryId`, Open Question 5), ADR-0008 (activity-history distinction)
- MariaDB `SKIP LOCKED` (10.6+); `web-push` (Node); Prisma (MySQL/MariaDB)
