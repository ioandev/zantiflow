# ADR-0043 — Telegram bot end-user surface: cold-start onboarding, command set, and async link confirmation

- **Status:** Accepted (implemented)
- **Amends/refines:** [ADR-0007](0007-chat-bot-notification-channels.md) — adds the bot's **in-chat, end-user** command surface beyond its backend↔bot protocol
- **Builds on:** [ADR-0006](0006-notifications-web-push-and-channels.md) (chat channels, linking prerequisite), [ADR-0010](0010-bots-in-python-and-token-storage.md) (Python / `aiogram`)
- **Date:** 2026-07-12
- **Deciders:** project owner
- **Tags:** telegram, bots, onboarding, ux, linking, aiogram, self-hosting
- **Testing:** pytest unit — `apps/telegram-bot/test_help.py` (help/onboarding copy + configurable website), `test_link.py` (username fallback + async confirmation routing), `test_unlink.py` (`user_command` reason) — see [ADR-0014](0014-testing-strategy.md)
- **Wire contract:** plugin↔backend (v4) unchanged; the backend↔bot WS is unchanged **except** `link_result` now carries an (already-implemented) optional `platformUserId` echo (§5)

> **Retroactive ADR:** This decision was already implemented in the codebase before this ADR was written; it is recorded here after the fact to close a documentation gap — it was not written at the right time.

## Context

[ADR-0007](0007-chat-bot-notification-channels.md) specified the **backend↔bot** contract: the outbound
WebSocket, the `hello`/`link_request`/`deliver`/`delivery_result`/`unlink_notice` messages, the
one-time link-token flow, and delivery/ack. [ADR-0010](0010-bots-in-python-and-token-storage.md) made
the bot Python (`aiogram` + `websockets`). Together they fully describe how the bot talks to the
*backend* and how a `?start=<token>` deep link (or manual `/link <token>`) binds a Telegram user to an
account.

Neither ADR describes what the bot presents to the **Telegram end user** at the moments that fall
*outside* that happy-path linking handshake — and the implementation (`apps/telegram-bot/bot.py`) makes
several concrete, non-obvious decisions there:

- A user very often opens a bot **cold** — taps the bot, sends a bare `/start`, or types `/help` —
  *without* a token. ADR-0007 only specced the token-carrying `/start <token>` path; a token-less user
  would otherwise get silence.
- Telegram `@usernames` are **optional**. `message.from_user.username` is frequently `None`, which would
  leave the account's linked-integration label blank in the dashboard.
- The `link_request` → `link_result` round-trip is **asynchronous and locally uncorrelated**: over a
  single shared WebSocket the bot fires `link_request` and does not block; the matching `link_result`
  arrives later in the connection-wide `on_backend` callback with no local memory of *which* chat asked.
- The website's Integrations-page design (D2) and first-run onboarding copy (D7) are explicitly
  **deferred** in [ADR-0019](0019-ux-decisions-deferred.md) — but those are *website* surfaces; the
  bot's *in-Telegram* command behavior is a runtime concern that shipped and needs recording.

This ADR documents the bot's **user-facing surface** as built. The shared WebSocket client, reconnect
/backoff, keepalive, and supervised restart live in `packages/notify-protocol` and are covered
(generically) by ADR-0007; they are out of scope here.

## Decision Drivers

- **No dead ends:** a user who opens the bot without a token must be guided, not ignored.
- **Discoverability without hijacking linking:** answering a bare `/start`/`/help` must not break the
  `?start=<token>` deep link that performs the actual account bind.
- **Always-identifiable links:** the dashboard's linked-account label must never be blank, despite
  Telegram usernames being optional.
- **Deliberate vs incidental unlink:** a user who *asks* to stop should be hard-revoked, distinctly from
  the passive "blocked / left" signal.
- **Async-safe confirmation:** the promised "you're linked" DM must reach the right chat even though the
  result comes back later with no request/response correlation on the bot side.
- **Self-hosting:** onboarding text must point at the operator's own site, not a hardcoded domain.

## Considered Options

- **Cold-start behavior:** answer bare `/start` **and** `/help` with an onboarding/help message that
  routes the user to the dashboard *(chosen)* — vs handle only `/link`/`/start <token>` (ADR-0007's
  literal spec — leaves token-less users staring at silence), vs a terse "send /link <token>" one-liner
  (no path to *get* a token).
- **Deep-link vs help dispatch:** register the **payload** handler (`CommandStart(deep_link=True)`)
  *before* the **bare** `CommandStart()` so a token start links and a bare start helps *(chosen)* — vs a
  single `/start` handler that branches on `command.args` (works, but couples two behaviors; aiogram's
  filter-based routing expresses the split more clearly and lets the bare handler also serve as the
  `/help` body), vs no bare handler (deep link works, bare start silent).
- **Missing-username fallback:** `platformUsername = username or full_name` *(chosen)* — vs send `None`
  (dashboard shows blank), vs send the raw numeric `user.id` (unfriendly, not human-recognizable).
- **`/unlink` semantics:** send `unlink_notice{ reason: "user_command" }` so the backend **hard-revokes**
  (status `revoked`), mirroring the website disconnect *(chosen)* — vs a soft "pause" (ambiguous), vs no
  bot-side unlink at all (forces the user back to the website).
- **Async confirmation routing:** the backend **echoes `platformUserId` back in `link_result`** and the
  bot DMs that chat, skipping the DM if an older backend omits it *(chosen)* — vs the bot holding a local
  `token → chat` map (fragile across the bot's own restart; the WS is the durable path), vs no
  confirmation (user left unsure whether linking worked).

## Decision

### 1. The command set (`apps/telegram-bot/bot.py`)

The bot registers exactly four end-user commands via `aiogram`:

- `/start <token>` — the website deep link (`https://t.me/<bot>?start=<token>`) → links the account.
- `/start` (bare) and `/help` — show the same onboarding/help message.
- `/link <token>` — manual linking (same effect as the deep link); a bare `/link` replies with usage.
- `/unlink` — stop notifications to this chat (§4).

### 2. Cold-start onboarding

`_help_text(website)` returns a short message that says what the bot is ("DMs you when one of your
terminal sessions needs attention"), points to the dashboard, and tells the user to **open the
dashboard → Integrations → Telegram** to get a link (deep link or `/link <token>`), then lists the four
commands. A token-less user therefore always has a next step. The copy is intentionally minimal and is
verified by tests, not frozen as a design (ADR-0019 D2/D7 still own the eventual polished wording).

### 3. Deep-link precedence

In `_wire()`, `CommandStart(deep_link=True)` is registered **before** the bare `CommandStart()`. aiogram
dispatches to the first matching handler, so:

- `/start <token>` → the deep-link handler → `_link()` (a defensive `if command.args:` guards an empty
  payload).
- bare `/start` → the bare handler → the help message (which also backs `/help`).

This keeps the account-binding path and the discoverability path from clashing.

### 4. Always-identifiable links & explicit unlink

- `_link()` sends `platformUsername = user.username or user.full_name`. Because Telegram `@usernames` are
  optional, `full_name` (Telegram guarantees `first_name`) is the fallback, so the dashboard's
  linked-account label is never blank.
- `_unlink()` sends `UnlinkNotice(reason="user_command")`, which the backend treats as a **deliberate
  hard-unlink** (status `revoked`) — the same effect as disconnecting from the website — distinct from
  ADR-0007 §4's passive `unlink_notice` (blocked bot / left server). The user gets a confirmation reply.

### 5. Asynchronous link confirmation

`_link()` sends `link_request` fire-and-forget and immediately answers *"Linking… you'll get a
confirmation shortly."* The correlated `link_result` returns later on the shared WS via `on_backend`,
which has no local memory of the originating chat. Routing is therefore driven by the **`platformUserId`
the backend echoes back in `link_result`** — a field present in the implemented model
(`packages/notify-protocol/src/zantiflow_notify/models.py`, `LinkResult.platformUserId`) but **not** in
ADR-0007 §2's `link_result{ token, ok, accountLabel?, error? }`. On success the bot DMs "✅ Linked!"; on
failure it DMs the `error` reason plus how to get a fresh token. If a (older) backend omits
`platformUserId`, the bot **skips** the DM rather than guessing — a documented graceful degradation.

### 6. Configurable onboarding site (`WEBSITE_URL`)

The site shown in all onboarding/help/confirmation text defaults to `https://zantiflow.com`
(`DEFAULT_WEBSITE`) and is overridable via the `WEBSITE_URL` env var so self-hosters point users at
their own dashboard. This is a config knob **beyond** ADR-0007 §7's telegram-bot list
(`TELEGRAM_BOT_TOKEN`, `BACKEND_WS_URL`, `BOT_SERVICE_SECRET`); it is documented in
`apps/telegram-bot/.env.example`.

## Consequences

**Positive**
- A user who opens the bot cold is never stuck — every entry point (`/start`, `/help`, bare `/link`)
  routes them to a token.
- Linked accounts are always identifiable in the dashboard, even for the common no-`@username` Telegram
  user.
- The async confirmation reaches the right chat without the bot holding fragile local state, so it
  survives the bot's own reconnects/restarts (the WS is the durable path).
- Self-hosters get correct onboarding text with one env var.

**Negative / costs**
- The onboarding/help copy is a maintenance surface (kept short; test-pinned) that the eventual
  design work (ADR-0019 D2/D7) may supersede.
- The `platformUserId` echo is an addition to ADR-0007 §2's `link_result` shape that must stay in sync
  across the backend TS types and the Python model (the ADR-0010 schema-sync concern).
- Handler-registration **order** is load-bearing (deep-link before bare); a reorder silently breaks the
  split.

**Neutral**
- Purely the bot's Telegram-facing surface; no plugin/wire-contract change and no change to the
  backend↔bot transport beyond the already-present `link_result.platformUserId` field.
- The parallel `apps/discord-bot` implements the same *concept* (a cold-start welcome + `/link`) with
  platform-native mechanics (slash commands); this ADR records the Telegram realization.

## Open Questions / Risks

1. **Copy ownership:** when ADR-0019 D2/D7 designs land, does the bot's in-chat wording get pulled into
   that design system or stay bot-local? Currently bot-local, test-pinned.
2. **`platformUserId` echo canonicalization:** it should be reflected in ADR-0007 §2 / the shared schema
   so the "abbreviated" `link_result` isn't mistaken for the full contract.
3. **`accountLabel` unused:** the backend sends `link_result.accountLabel` (ADR-0007 §2) but the bot's
   confirmation ignores it in favor of a generic "✅ Linked!" — intentional simplicity, or should the
   DM name the account?
4. **i18n:** onboarding/confirmation copy is English-only (baseline per ADR-0018; full i18n deferred by
   ADR-0019 D9).

## References

- ADR-0006 (chat channels, linking prerequisite), ADR-0007 (backend↔bot protocol, `/link`, deep link,
  `unlink_notice`), ADR-0009 (durable delivery/replay), ADR-0010 (Python / `aiogram`), ADR-0014
  (testing), ADR-0018 (env/config, i18n baseline), ADR-0019 (deferred website Integrations/onboarding
  design — D2, D7, D9)
- Code: `apps/telegram-bot/bot.py` (`_help_text`, `_wire`, `_link`, `_unlink`, `on_backend`, `main`);
  `apps/telegram-bot/.env.example` (`WEBSITE_URL`); `packages/notify-protocol/src/zantiflow_notify/models.py`
  (`LinkResult.platformUserId`)
- Tests: `apps/telegram-bot/test_help.py`, `test_link.py`, `test_unlink.py`
- aiogram `CommandStart(deep_link=…)`; Telegram Bot API deep-linking (`?start=`)
