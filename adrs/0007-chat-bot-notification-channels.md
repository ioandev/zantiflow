# ADR-0007 — Chat-bot notification channels (Discord + Telegram): bots, account linking, backend↔bot WebSocket

- **Status:** Accepted
- **Fulfills:** [ADR-0006](0006-notifications-web-push-and-channels.md) — the deferred pro chat channels + account linking
- **Builds on:** [ADR-0003](0003-multi-tenant-backend-and-token-auth.md) (accounts/tier + token-hashing pattern), [ADR-0004](0004-google-auth-owner-sign-in.md) (owner auth; the website mints tokens), [ADR-0006](0006-notifications-web-push-and-channels.md) (notifier + delivery seam + privacy)
- **Amended by:** [ADR-0009](0009-durable-notification-delivery.md) — the per-platform delivery queue is MariaDB-backed & durable. [ADR-0010](0010-bots-in-python-and-token-storage.md) — bots implemented in **Python**; the protocol becomes language-neutral. [ADR-0042](0042-discord-slash-command-surface-and-deferred-link.md) / [ADR-0043](0043-telegram-bot-command-surface-and-onboarding.md) — each bot's actual in-chat command surface & linking UX. [ADR-0044](0044-bot-client-connection-resilience.md) — the shared client's connection-resilience design
- **Date:** 2026-07-10
- **Deciders:** project owner
- **Tags:** discord, telegram, bots, websocket, linking, notifications, self-hosting
- **Testing:** integration (real WS: link/deliver/ack/reconnect with a fake bot) + unit (message dedup) — see [ADR-0014](0014-testing-strategy.md)
- **Wire contract:** plugin↔backend (v4) unchanged; introduces the **internal backend↔bot** WS protocol

## Context

[ADR-0006](0006-notifications-web-push-and-channels.md) established that **pro** users get **Discord**
and **Telegram** notifications as **bot DMs**, but deferred the bots, the account-linking flow, and
the backend↔bot transport. This ADR specifies all three.

Shape (from the project owner's plan): each bot is a **separate service** holding a persistent
**WebSocket to the backend**. A user links by running a bot command with a **one-time token minted on
the website**; the bot relays it over the WS; the backend binds the platform user to the account.
Thereafter the backend dispatches "DM this user" over the WS and the bot delivers.

## Decision Drivers

- **Isolation:** bots use different SDKs, deploy/scale independently, and shouldn't share the
  backend's blast radius.
- **Firewall-friendly, real-time:** an **outbound** WS from bot→backend means the bots need **no
  public ingress**, while the backend can still push deliveries and the bot can push link requests
  live.
- **Secure linking:** bind a platform user to an account with an unguessable, one-time, scoped token —
  no hijack, no leak.
- Reuse the ADR-0006 notifier/delivery seam, ADR-0003 accounts/tier, ADR-0004 website auth.
- **Open-source / self-host friendly:** each deployer runs their own bots with their own tokens.

## Considered Options

- **Backend↔bot transport:** persistent **WebSocket** (bot dials out) *(chosen, per plan)* — bidirectional,
  real-time, no public bot ingress; vs backend→bot HTTP (needs bot ingress), vs a message queue (heavier op).
- **Bot topology:** **separate per-platform services** *(chosen)* — SDK isolation + independent
  scaling; vs one combined process.
- **Linking credential:** **one-time, short-TTL, hashed, single-use token** *(chosen)* — vs long-lived
  code (leak risk), vs full Discord OAuth (heavier; the plan is command + token).
- **Discord DM enablement:** **user joins a community guild** (mutual server → DMs allowed) + handle
  DM-privacy *(chosen, per plan)* — vs OAuth install flow.
- **Shared code:** an **internal `@zantiflow/notify-protocol`** package (WS message types + framing +
  thin client) shared by backend and both bots *(chosen)*; internal, not published (v1).

## Decision

### 1. Topology

Two Node/TS services in the monorepo (`apps/discord-bot`, `apps/telegram-bot`), each opening a
persistent **client WebSocket** to an **internal** backend endpoint (`wss://…/internal/bots`, TLS,
ideally private network). A shared internal package **`@zantiflow/notify-protocol`** defines the
message types, framing, and a small typed client used by the backend and both bots (keeps all three
in lockstep). Each bot authenticates on connect with a per-bot **service secret**.

### 2. Backend↔bot WS protocol (JSON, bidirectional)

- **bot → backend:** `hello{ platform, serviceSecret, version }`, `link_request{ platform,
  platformUserId, platformUsername?, token }`, `delivery_result{ deliveryId, status: delivered|failed,
  error? }`, `unlink_notice{ platform, platformUserId, reason }` (blocked bot / left server).
- **backend → bot:** `hello_ack{ ok }`, `deliver{ deliveryId, platformUserId, text }`,
  `link_result{ token, ok, accountLabel?, error? }`.
- **Resilience:** bot reconnects with backoff; the backend **queues deliveries per platform** while a
  bot is offline (TTL, best-effort per ADR-0006) and flushes on reconnect; **`deliveryId` makes
  retries idempotent** (the bot dedups).

### 3. Account-linking flow

1. In the authenticated web app (ADR-0004) → notification settings → **"Connect Discord/Telegram"** →
   the backend mints a **one-time link token** (random, **hashed at rest**, single-use, ~10-min TTL,
   scoped to `{ accountId, platform }`), shown once.
2. **Discord:** the site shows an **invite to the zantiflow community server** (so the bot shares a
   guild and may DM) and instructs **`/link token:<token>`**. The bot emits `link_request`.
   **Telegram:** the site shows a **deep link** `https://t.me/<bot>?start=<token>` (one click →
   `/start <token>`); the bot emits `link_request`. (Manual `/link <token>` also works.)
3. The backend validates the token (exists, unexpired, unused, platform matches), creates a
   **`ChannelLink`**, marks the token used, and returns `link_result{ ok, accountLabel }`; the bot DMs
   a confirmation. The channel can now be enabled in prefs (ADR-0006).
4. Failure handling: Discord DMs disabled → the bot replies ephemerally telling the user to enable
   DMs and stay in the server; invalid/expired token → friendly error.

### 4. Delivery

ADR-0006's notifier → for a **linked, enabled** chat channel → `deliver{}` to that platform's bot over
the WS → the bot sends the DM → `delivery_result` → the backend records status (ADR-0006). Bots
respect platform **rate limits**; the backend paces. On `unlink_notice`, the backend marks the
`ChannelLink` **stale**, stops routing there, and surfaces a **"reconnect"** prompt in the web app.

### 5. Data model

- **`ChannelLink { id, accountId, platform (discord|telegram), platformUserId, platformUsername?,
  status (active|stale|revoked), linkedAt }`** — unique `(platform, platformUserId)`; one **active**
  link per `(accountId, platform)` in v1 (multi later).
- **`LinkToken { tokenHash, accountId, platform, createdAt, expiresAt, usedAt }`** — one-time, short
  TTL (mirrors ADR-0003's hash-at-rest pattern, but ephemeral).
- **Unlink:** user revokes in the web app → `ChannelLink` → `revoked` (+ optional push to the bot).

### 6. Security

- Link tokens: unguessable, hashed at rest, single-use, short-TTL, `{account, platform}`-scoped →
  no hijack.
- WS: internal-only endpoint, per-bot service secret, TLS, ideally private network. The backend
  **never trusts a `platformUserId`** except via a validated link token.
- Notification text is already redacted (ADR-0002/0006); it transits Discord/Telegram (disclosed in
  ADR-0006). Bots see only `{ platformUserId, text }` — no account internals.

### 7. Config & self-hosting

- **discord-bot:** `DISCORD_BOT_TOKEN`, `DISCORD_APP_ID`, `DISCORD_GUILD_ID` (community server), DM
  intents; registers the `/link` slash command.
- **telegram-bot:** `TELEGRAM_BOT_TOKEN` (BotFather); handles the `start` deep-link payload.
- **both:** `BACKEND_WS_URL`, `BOT_SERVICE_SECRET`.
- **Self-hosters** register their own Discord app + Telegram bot and set their own tokens (like Google
  in ADR-0004); a deployment may run zero, one, or both bots.

### 8. Stack

> **Superseded by [ADR-0010](0010-bots-in-python-and-token-storage.md):** the bots are **Python**
> (`discord.py` / `aiogram` + `websockets`), and the protocol is a language-neutral schema rather than
> a shared TS package. The Node stack below is retained for historical context.

`discord.js` (Discord), `grammY` (Telegram), a `ws` client; TypeScript; long-running services deployed
alongside the backend (docker-compose / same infra).

## Consequences

**Positive**
- Fulfils ADR-0006's pro channels with reliable mobile DMs.
- Bots are isolated and **firewall-friendly** (outbound WS, no public ingress); secure one-time
  linking; self-host friendly.
- The shared `@zantiflow/notify-protocol` keeps backend and bots in lockstep.

**Negative / costs**
- Three services now (backend + 2 bots) plus a WS to operate — reconnection, per-platform delivery
  queue, idempotency.
- Discord requires users to **join a guild** (friction) and handle DM-privacy-off.
- Platform **rate limits + ToS/API changes** to track; link/unlink lifecycle and stale-link UX; more
  to deploy/monitor; self-hosters must register two bots.

**Neutral**
- Introduces the internal backend↔bot WS protocol (no plugin/wire-contract change) and an internal,
  unpublished `@zantiflow/notify-protocol` package.

## Open Questions / Risks

1. **Discord "DMs from server members" is often off** → some users can't be DMed; mitigation = ephemeral
   guidance, — **decided:** fall back to another enabled channel and prompt the user to enable DMs.
2. **Multiple links** per platform per account (multi-device / multi-account) — **decided:** one link per platform in v1; multi later.
3. **WS scaling** with multiple backend instances (which backend holds which bot connection) needs a
   routing layer — v1 assumes single-backend; flag for scale. **Decided:** no Redis — single backend (vertical scaling); revisit horizontal scaling with a non-Redis approach only if ever needed.
4. **Bot verification at scale** (Discord verified-bot requirements), rate limits, ToS — track. **Noted:** respect platform rate limits; pursue Discord verified-bot when scale requires.
5. **Delivery-queue durability** across backend restarts — **resolved by [ADR-0009](0009-durable-notification-delivery.md):** persisted in MariaDB; `pending` deliveries are replayed on reconnect/restart.
6. Publish `@zantiflow/notify-protocol` for self-host clarity, or keep internal? Internal v1. **Decided:** internal & unpublished; per ADR-0010 a versioned language-neutral **schema**, not a shared package.

## References

- ADR-0003 (accounts/tier + token-hashing pattern), ADR-0004 (owner auth; website mints tokens),
  ADR-0006 (notifier + delivery seam + privacy)
- Discord bot / slash commands (`discord.js`); Telegram Bot API deep-linking (`grammY`)
- Next: the **status website** (ADR-0008) — link/unlink UI, notification settings, and status display
