# ADR-0006 — Notifications: web-push (PWA) for all, Discord + Telegram for pro

- **Status:** Accepted
- **Builds on:** [ADR-0005](0005-attentions-detection-and-triggering.md) (fired triggers), [ADR-0004](0004-google-auth-owner-sign-in.md) (owner auth / settings), [ADR-0003](0003-multi-tenant-backend-and-token-auth.md) (accounts + tier), [ADR-0002](0002-configurable-telemetry-privacy-controls.md) (privacy)
- **Leads to:** [ADR-0007](0007-chat-bot-notification-channels.md) (the Discord + Telegram bots and account linking); the status website (ADR-0008)
- **Amended by:** [ADR-0009](0009-durable-notification-delivery.md) — delivery becomes persisted in MariaDB, acked, replayed, and pruned
- **Date:** 2026-07-10
- **Deciders:** project owner
- **Tags:** notifications, web-push, pwa, discord, telegram, channels, tier
- **Testing:** unit (routing/tier-gating) + BDD (trigger → per-channel deliveries) + Playwright (permission popup, settings) — see [ADR-0014](0014-testing-strategy.md)
- **Wire contract:** unchanged (this is backend→user delivery, not plugin→backend)

## Context

[ADR-0005](0005-attentions-detection-and-triggering.md) fires a **trigger** when an attention crosses
its threshold + cooldown (action `notify`). This ADR **delivers** those to the user, letting them
control **when / what / where / how**, tiered free vs pro.

Grounded in the notification-reliability review that preceded this ADR:

- **No native app will be built.** Delivery is **browser Web Push**, which means a real **PWA**
  (service worker + manifest).
- **Web Push is best-effort**, and on **iOS it only works for a home-screen-installed PWA** — so we
  must ship an installable PWA and **actively incentivize install**, especially on iOS.
- For **reliable mobile** delivery, **pro** users additionally get **Discord** and **Telegram**
  bot-DM channels (they ride those apps' own native push). **WhatsApp was dropped** — its Business
  API (approved templates, verification, per-message cost, phone opt-in) doesn't fit the bot+link
  pattern and adds disproportionate overhead; Telegram gives the same reliable mobile push for free.

## Decision Drivers

- No app → **Web Push + PWA**; iOS forces a genuine installable PWA + install nudges.
- **User control** over when/what/where/how; **tiered** option depth (free fewer, pro more).
- Delivery is **best-effort** → multi-channel; never assume a single send lands.
- Reuse accounts/tier (ADR-0003), owner auth for settings (ADR-0004), privacy (ADR-0002).

## Considered Options

- **Delivery tech:** Web Push via **VAPID + service worker** *(chosen)* — free, standard, no SaaS; vs
  native app (excluded by product), email-only (too slow/weak), push SaaS (unneeded).
- **Pro chat channels:** **Discord + Telegram** bot DMs *(chosen)* — same "`/link` a website token,
  bot DMs you" pattern, reliable mobile push. **WhatsApp rejected** (Business API templates/cost/opt-in;
  breaks the bot pattern).
- **Permission UX:** custom **pre-permission modal + gesture-triggered button** *(chosen)* vs
  auto-prompt on load (rejected — tanks opt-in; browsers penalize it).
- **Delivery structure:** one **notifier** fanning out to pluggable **channel adapters** *(chosen)*.

## Decision

### 1. Channels & tiers

| Channel | Tier | Delivery |
| --- | --- | --- |
| **Web Push** | free (all) | browser PWA + service worker |
| **Discord** | pro | bot DM |
| **Telegram** | pro | bot DM |

Each is a **channel adapter** behind a common interface; the notifier fans out to a user's enabled,
eligible channels.

### 2. Web Push (the PWA)

- Ship a PWA: `manifest.webmanifest` (name, icons, `display: standalone`), a **service worker**
  handling `push` + `notificationclick`, over HTTPS — installable.
- **VAPID** keypair on the backend; public key → client; `PushManager.subscribe()` → POST the
  `PushSubscription` to the backend, tied to the logged-in account and stored **per-device**
  (multiple subscriptions/account). Backend sends via the Web Push protocol (`web-push`) with the
  private key.
- Best-effort: set TTL/urgency; on `404`/`410` prune the dead subscription.

### 3. Permission UX (the popup + button)

- **Never auto-prompt.** A **custom pre-permission modal** explains the value and has an **"Enable
  notifications" button**; the click (a user gesture) calls `Notification.requestPermission()`, and on
  grant subscribes + registers the subscription.
- Handle **denied** (cannot re-prompt programmatically → show how to re-enable in browser settings)
  and **dismissed/default** (may ask again later).

### 4. PWA install incentivization (no app)

- **Android / desktop:** capture `beforeinstallprompt`; show a custom **"Install zantiflow"**
  button/banner.
- **iOS:** no programmatic prompt — show an **"Add to Home Screen" instructional modal**, because
  **iOS Web Push requires the installed PWA**. Detect standalone/installed state and nudge when not
  installed — especially when an iOS user tries to enable notifications.
- Messaging leads with reliability, and on iOS states plainly that notifications **require** install.

### 5. Pro chat channels (Discord + Telegram) — delivery seam only

- Both delivered as **bot DMs**. Each bot is a **separate service holding a persistent internal
  WebSocket to the backend**; on a notify trigger for a **linked** account with the channel enabled,
  the backend emits *"DM this user: `<text>`"* over the WS and the bot delivers.
- **Linking:** the **website mints a one-time link token**; the user runs the bot's `/link <token>`
  command; the bot relays it over the WS; the backend links `platformUserId ↔ accountId`.
- **The bots, the join/`/link` flow, and token consumption are specified in
  [ADR-0007](0007-chat-bot-notification-channels.md).** This ADR defines only: the channel adapters,
  the **linked-account prerequisite**, that the website mints link tokens, and the backend→bot
  **delivery contract** (internal WS message). Pro chat delivery is not functional until ADR-0007 ships.

### 6. Notification preferences ("when / what / where / how"), tiered

Per-account, edited in the authenticated web app (ADR-0004):

- **What / when:** which ADR-0005 attention types notify (using ADR-0005's tier-gated thresholds);
  **quiet hours / DND schedule**; **frequency caps / digest**.
- **Where / how:** per-type **routing** to the account's enabled channel(s).
- **Tier gating:** free = web push + a limited option set (on/off per type, basic quiet hours); pro =
  Discord/Telegram + full routing and options. Ship sensible defaults so it works out of the box.

### 7. Delivery pipeline

ADR-0005 fires a trigger → the **notifier**:

1. Load account prefs; filter to enabled/eligible channels (**tier** + routing + quiet hours +
   frequency caps).
2. **Compose** the message honoring **ADR-0002 privacy** — redacted names render as generic text;
   never leak a hidden session/pane name.
3. Dispatch to each channel adapter (web-push send; bot-over-WS DM).
4. Record per-channel **delivery status**. **[ADR-0009](0009-durable-notification-delivery.md) makes
   this durable** — each delivery is a MariaDB row, acked on success, replayed after a restart, and
   pruned by a cron (default 6h).

> **Layering:** ADR-0005 decides **if** a trigger fires; ADR-0006 decides **whether / where / how**
> it is delivered.

### 8. No wire-contract change

The plugin→backend contract (v4) is untouched. The only new contract is the backend↔bot WS message,
specified fully in the chat-bot ADR.

## Consequences

**Positive**
- Universal, free web-push with **no app to build or ship**; the PWA also seeds the eventual status
  website.
- Reliable pro mobile delivery via Discord/Telegram native push, using one clean linking pattern.
- User-controlled, tiered; reuses auth/tier/privacy foundations.

**Negative / costs**
- Web push is **best-effort** (iOS background throttling); **iOS requires PWA install** → onboarding
  friction and an ongoing PWA/service-worker to maintain; opt-in rates are low.
- Push-subscription lifecycle (expiry/pruning, multi-device) to manage.
- **Pro chat delivery depends on the future bot ADR** (linking prerequisite) — not functional until it
  ships.
- Enabling a chat channel means notification text transits a third party (Discord/Telegram) — a
  privacy point to disclose (see Open Questions).

**Neutral**
- Introduces the PWA/frontend (a subset of the later status website). WhatsApp dropped in favor of
  Telegram. No plugin/wire-contract impact.

## Open Questions / Risks

1. **iOS install conversion** — **decided: no email channel** (no emails, ever). iOS users who won't
   install the PWA are reachable only if they go pro (Discord/Telegram); install nudges are the only
   free mitigation.
2. **Privacy of notification text** — exact generic templates when names are hidden (ADR-0002); and
   disclose that enabling Discord/Telegram sends text to that platform. **Decided:** generic templates when names hidden (ADR-0002); disclose third-party transit in the UI.
3. **Frequency / digest** — batching multiple attentions without spam (**digest design deferred to ADR-0019**); interaction
   with ADR-0005 cooldown. **(decided: deferred to ADR-0019.)**
4. **Link-token** lifetime/security (one-time, short TTL) — finalized with the chat-bot ADR. **Resolved by ADR-0007** (one-time, ~10-min TTL, hashed).
5. **Free-tier fallback** — **decided:** strictly web push (no email). Pro adds Discord/Telegram.
6. **Push budget** — keep notifications user-visible to avoid browser silent-push penalties. **Decided:** every push is user-visible (no silent pushes).

## References

- ADR-0002 (privacy), ADR-0003 (accounts/tier), ADR-0004 (owner auth/settings), ADR-0005 (triggers)
- Notification-reliability review (this session): Web Push is best-effort; iOS needs an installed PWA
- Web Push Protocol / VAPID — RFC 8030, RFC 8291, RFC 8292
- Next: **[ADR-0007](0007-chat-bot-notification-channels.md)** — the Discord + Telegram bots, server join, `/link <token>`, and the backend↔bot WebSocket
