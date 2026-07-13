# ADR-0042 — Discord slash-command surface + async-deferred link confirmation (with DM/welcome fallbacks)

- **Status:** Accepted (implemented)
- **Date:** 2026-07-12
- **Deciders:** project owner
- **Tags:** discord, bots, slash-commands, interactions, onboarding, intents, linking
- **Testing:** pytest unit — `apps/discord-bot/test_slash.py`, `test_welcome.py`, `test_link.py`, `test_unlink.py`, `test_help.py` — see [ADR-0014](0014-testing-strategy.md)
- **Wire contract:** plugin↔backend (v4) unchanged; backend↔bot WS protocol (ADR-0007/0010) unchanged

> **Retroactive ADR:** This decision was already implemented in the codebase before this ADR was written; it is recorded here after the fact to close a documentation gap — it was not written at the right time.

## Context

[ADR-0007](0007-chat-bot-notification-channels.md) §7 says the Discord bot "registers the `/link`
slash command" and §3.2 shows the linking flow as `/link token:<token>` → `link_request` →
`link_result` → "the bot DMs a confirmation." [ADR-0010](0010-bots-in-python-and-token-storage.md)
fixes the bot's language (Python / `discord.py`). Neither ADR specifies **how** the Discord command
surface is actually built, and the implementation in `apps/discord-bot/bot.py` had to make several
non-obvious, Discord-specific decisions that no ADR captures:

1. **Slash commands must work in a DM**, because a DM is the primary (and default) place a
   notification bot talks to a user. An earlier version scanned inbound message **content** for a
   literal `/link …` string. That does **not** work in DMs: the Discord client owns the `/` key — it
   opens the native command picker — so the raw `/link` text never reaches the bot's `on_message`.
   The bot's module docstring records this explicitly.

2. **The link confirmation is asynchronous.** `/link` does not resolve locally; it emits a
   `link_request` over the outbound WS (ADR-0007) and the answer arrives *later* as a separate
   `link_result` frame. A Discord **interaction** (what a slash command is) expects a timely response
   and renders a native "thinking…" state; bridging the WS round-trip into that lifecycle is not
   addressed by ADR-0007's "the bot DMs a confirmation."

3. **Discord has no `/start` deep-link.** The Telegram bot links in one click via
   `https://t.me/<bot>?start=<token>` (`apps/telegram-bot/bot.py`). Discord offers no equivalent
   payload-carrying entry point, so Discord onboarding — how a user discovers the bot and learns to
   link — has to be solved differently.

This ADR records the Discord command / interaction / onboarding surface as built. The shared WS
client, reconnection/keepalive, supervision, protocol models, and `handle_deliver` live in
`packages/notify-protocol` (imported by both bots) and are covered by ADR-0007/0009/0010 — they are
out of scope here.

## Decision Drivers

- **Works in DMs:** the command entry points must fire when a user types them in a DM, which is where
  the bot lives.
- **Bridge async → interaction:** turn the WS `link_request`/`link_result` round-trip into a single
  in-place slash-command response, without a jarring interstitial.
- **Keep a mistyped token private:** a link token pasted into a channel or a typo should not be
  world-visible.
- **Onboard without a Telegram-style deep link:** give a Discord user a way to find out what the bot
  is and how to connect.
- **Degrade gracefully:** a failed command sync, an expired interaction, or a user with DMs closed
  must not crash the bot or silently strand the user.

## Considered Options

- **Command surface:**
  - **Real application (slash) commands on `commands.Bot.tree`, globally synced** *(chosen)* — real
    interactions dispatch in DMs; global sync propagates to DMs (guild-scoped would not).
  - Message-content prefix parsing (the earlier approach) — rejected: the Discord client intercepts
    `/`, so the text never arrives in a DM.
  - Guild-scoped command sync — rejected: guild commands don't cover DM interactions.
- **Async link confirmation:**
  - **Defer the interaction (ephemeral, "thinking"), track it by `platformUserId`, resolve it in
    place when `link_result` returns, DM as fallback** *(chosen)*.
  - Immediate interstitial "Linking…" message then a later DM — rejected: two messages, noisier, and
    a mistyped token shown non-ephemerally.
  - DM-only confirmation (no interaction resolution) — rejected: leaves the slash command's
    "thinking" state hanging until it times out.
- **Onboarding entry point:**
  - **Welcome-DM on member join + help on any non-command DM** *(chosen)* — the closest Discord
    analogue to Telegram's `/start`.
  - Rely on the `/help` command only — rejected: a user who never types `/help` gets no guidance.

## Decision

### 1. Real slash commands on the command tree, globally synced

The bot is a `discord.ext.commands.Bot` (not a bare `Client`) purely so it exposes a `.tree`. Three
application commands are registered on that tree — **`/help`**, **`/link <token>`**, **`/unlink`** —
and `await bot.tree.sync()` runs in `on_ready`. Sync is **global** (no `DISCORD_GUILD_ID` pin), so the
commands propagate to DMs. A sync failure is caught and logged, never fatal (`log.exception` then carry
on) — Discord's global propagation is eventual, and a bot that can still deliver notifications must not
die because command registration lagged. The `command_prefix` is `commands.when_mentioned` — a
placeholder; prefix commands are never used.

### 2. Async link confirmation resolved in place on the deferred interaction

`/link` cannot answer synchronously, so `link_cmd`:

1. `await interaction.response.defer(ephemeral=True, thinking=True)` — acknowledges immediately with a
   native "thinking" state and **no interstitial text**; `ephemeral` keeps a mistyped token private.
2. Stashes the interaction in an in-memory `self._pending_links[str(user.id)]` keyed by
   `platformUserId`.
3. Emits `LinkRequest{ platform:"discord", platformUserId, platformUsername, token }` over the WS.

When the backend's `LinkResult` arrives (`on_backend`), the bot looks up the pending interaction by
`platformUserId` and calls `interaction.edit_original_response(...)` to fill the deferred bubble in
place — "✅ Linked!" or a friendly "❌ Couldn't link: <reason>. Get a fresh token at …". If the
interaction is gone (expired, or the command came in as pasted text — see §3) it **falls back to a
DM**. A `LinkResult` without a `platformUserId` (an older backend) is a no-op — there is no one to
route it to.

### 3. Onboarding + text fallback via `on_message` and `on_member_join`

Because Discord has no `/start` payload, onboarding is handled two ways:

- **`on_member_join` → `_welcome`:** when a human joins a server the bot is in, DM them the help /
  onboarding text (skip other bots; a member with DMs closed is silently un-greetable, caught and
  logged).
- **`on_message` (DM only):** a **fallback**, not the primary path. Slash commands arrive as
  interactions, not messages; but a user who *pastes* `/link <token>` (or `/unlink`) as literal text
  is still handled, and **any other DM** is answered with the help text — the Discord stand-in for a
  greeting on first contact. A pasted `/link` gets no interstitial ack (its `LinkResult` DMs the
  confirmation, per §2's fallback).

The help text (`_help_text`) names the configured website and lists the three commands, and points the
user at "dashboard → Integrations → Discord" to mint a token.

### 4. Gateway intents

Two **privileged** gateway intents are enabled on top of `Intents.default()`:

- **`message_content`** — required for the `on_message` text fallback / onboarding (§3).
- **`members`** — required for `on_member_join` welcome DMs (§3).

Both must be toggled on in the Discord Developer Portal for the bot to receive those events, and
Discord gates them behind verification once a bot is in many servers.

### 5. Config divergence from ADR-0007 §7

ADR-0007 §7 anticipated `DISCORD_APP_ID` and `DISCORD_GUILD_ID`. The implementation uses **neither** —
global `tree.sync()` needs no guild pin, and the app id is implicit in the bot token. Instead it adds
**`WEBSITE_URL`** (default `https://zantiflow.com`) so self-hosters can point help/onboarding at their
own site (`apps/discord-bot/.env.example`). `DISCORD_BOT_TOKEN`, `BOT_SERVICE_SECRET`, and
`BACKEND_WS_URL` are unchanged from ADR-0007.

### 6. `/unlink` semantics

`/unlink` (and pasted `/unlink`) sends `UnlinkNotice{ reason:"user_command" }`, which the backend
treats as a deliberate **hard revoke** (status `revoked`) — the same effect as disconnecting from the
website (ADR-0007 §5). This reuses ADR-0007's `unlink_notice` message (originally framed for
blocked-bot / left-server) for a user-initiated command via the `reason` field.

## Consequences

**Positive**
- Commands actually fire in DMs (the earlier content-scan silently did nothing there).
- One clean, in-place slash-command response instead of an interstitial-plus-DM; a mistyped token
  stays ephemeral/private.
- A Discord user with no `/start` still gets onboarded (welcome on join, help on any DM) and can link
  by pasting or by slash command.
- Failures are contained: sync errors, expired interactions, and closed DMs each degrade instead of
  crashing.

**Negative / costs**
- Two **privileged intents** (`message_content`, `members`) must be enabled in the Developer Portal
  and are subject to Discord's verification once the bot scales — an operational and review burden
  Telegram doesn't have.
- Global command sync propagates **eventually** — freshly changed commands can lag before they appear
  in DMs.
- `_pending_links` is **in-process** — a bot restart between `/link` and `link_result` loses the
  tracked interaction, so that confirmation arrives as a DM (acceptable fallback, but the "thinking"
  bubble is orphaned).

**Neutral**
- Discord's command/onboarding surface deliberately **diverges** from Telegram's deep-link model; the
  two bots share only the WS client and protocol models (`packages/notify-protocol`), not their
  command UX.
- No wire-contract change (plugin↔backend v4; backend↔bot protocol unchanged).

## Open Questions / Risks

1. **Privileged-intent verification at scale** — `members` + `message_content` require Discord
   approval past ~100 servers; track alongside ADR-0007's verified-bot question.
2. **Global-sync latency** — acceptable for now; a guild-scoped dev sync could speed iteration if
   command churn increases.
3. **Lost pending interaction on restart** — currently falls back to a DM; a durable pending-link
   store is unwarranted at this volume (mirrors ADR-0019's "in-process single-backend" posture).
4. **One link per (platform, user)** — inherited from ADR-0007 §5; multi-link is future work.

## References

- [ADR-0006](0006-notifications-web-push-and-channels.md) (pro chat channels; the `/link`-a-token
  pattern), [ADR-0007](0007-chat-bot-notification-channels.md) (bot topology, linking flow, WS
  protocol, `unlink_notice`), [ADR-0009](0009-durable-notification-delivery.md) (delivery/ack/replay),
  [ADR-0010](0010-bots-in-python-and-token-storage.md) (Python / `discord.py`; language-neutral
  protocol), [ADR-0014](0014-testing-strategy.md) (testing), [ADR-0019](0019-ux-decisions-deferred.md)
  (in-process single-backend state)
- Code: `apps/discord-bot/bot.py` (command tree + `tree.sync`, deferred `link_cmd`, `on_backend`
  in-place resolution, `on_message` / `on_member_join` fallbacks, intents), `apps/discord-bot/.env.example`
- Contrast: `apps/telegram-bot/bot.py` (`?start=<token>` deep link — the model Discord cannot use)
- `discord.py` `app_commands` / command tree; the "meditation-bot" slash-command reference cited in
  the bot's docstrings

## Testing

Per ADR-0014, the behavior lands with pytest unit tests (fakes for the Discord interaction/user and
the WS, so no gateway or live socket is needed):

- `apps/discord-bot/test_slash.py` — `/help`, `/link`, `/unlink` are real tree commands; `/link`
  defers ephemerally with no interstitial and tracks the interaction; `link_result` resolves the
  pending interaction **in place** (edits, does not DM); `/unlink` sends `reason:"user_command"`.
- `apps/discord-bot/test_welcome.py` — `on_member_join`/`_welcome` DMs help to a new human, skips
  bots, and survives a member with DMs closed.
- `apps/discord-bot/test_link.py` — `link_result` (ok / failure / missing `platformUserId`) DM
  fallback path.
- `apps/discord-bot/test_unlink.py` — `_unlink` emits the `user_command` `UnlinkNotice`.
- `apps/discord-bot/test_help.py` — help text honors the configured `WEBSITE_URL` and lists the
  commands.
