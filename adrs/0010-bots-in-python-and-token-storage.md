# ADR-0010 — Bots in Python (language-neutral protocol); tokens stored in MariaDB

- **Status:** Accepted
- **Amends:** [ADR-0007](0007-chat-bot-notification-channels.md) — bot stack becomes **Python**; the shared TS package becomes a **language-neutral contract**
- **Confirms:** [ADR-0003](0003-multi-tenant-backend-and-token-auth.md) + [ADR-0009](0009-durable-notification-delivery.md) — ingest & link tokens are stored in **MariaDB**
- **Date:** 2026-07-10
- **Deciders:** project owner
- **Tags:** bots, python, discord, telegram, protocol, mariadb, tokens
- **Testing:** pytest unit (WS models, `/link`, dedup) + integration (bot ↔ backend WS) — see [ADR-0014](0014-testing-strategy.md)
- **Wire contract:** unchanged

## Context

[ADR-0007](0007-chat-bot-notification-channels.md) assumed the Discord + Telegram bots would be
**Node/TS** (`discord.js`, `grammY`) sharing a TS **`@zantiflow/notify-protocol`** package with the
backend. The project owner has decided:

1. **The bots are written in Python.**
2. **Tokens are stored in MariaDB.**

A Python bot cannot import a TypeScript package, so the backend↔bot protocol must become
**language-neutral**. Token storage is already implied by [ADR-0009](0009-durable-notification-delivery.md)
(backend datastore = MariaDB) — this makes the token tables explicit.

## Decision Drivers

- The owner's language choice for the bots (mature Python bot ecosystem).
- A cross-language contract (TS backend ↔ Python bots) can't be a single shared **code** package.
- One explicit source of truth for **token storage** (MariaDB).

## Considered Options

- **Bot language:** **Python** *(chosen, per owner)* vs Node/TS (ADR-0007's original).
- **Libraries:** **`discord.py`** (Discord) + **`aiogram`** (Telegram, async) + **`websockets`**
  (backend WS client) *(chosen)* — all asyncio; `python-telegram-bot` is an equivalent alternative.
- **Protocol sharing:** a **versioned, language-neutral schema** (single source of truth) with TS
  types backend-side and Python models bot-side *(chosen)* — vs a shared code package (impossible
  across languages).

## Decision

### 1. Bots in Python

`apps/discord-bot` and `apps/telegram-bot` are **Python** asyncio services — **`discord.py`**,
**`aiogram`**, and **`websockets`** (the backend WS client). They live in the monorepo as Python
projects (own `pyproject.toml`/venv), **outside** the pnpm/TS workspace (pnpm ignores non-npm dirs).
This **supersedes ADR-0007 §8's Node stack** while leaving ADR-0007's topology, linking flow, WS
semantics, and delivery/ack/replay unchanged.

### 2. Language-neutral backend↔bot protocol

The WS message contract (ADR-0007 §2) is defined **once as a versioned spec / JSON Schema** — the
single source of truth — carrying a `protocolVersion`. The **backend** keeps TS types; the **bots**
keep Python models (pydantic/dataclasses). ADR-0007's **`@zantiflow/notify-protocol`** package is
**re-scoped to the backend's TS types + the canonical schema doc** (no longer imported by the bots).
Prefer **generating** both sides' types from the schema to prevent drift. This **supersedes
ADR-0007's "shared code package used by the backend and both bots."** The JSON messages on the wire
are unchanged — only how each side obtains its types.

### 3. Tokens in MariaDB (explicit)

- The **ingest `Token`** table (ADR-0003 — hashed secret + lookup prefix) and the **`LinkToken`**
  table (ADR-0007 — one-time link codes) are stored in **MariaDB** (the backend datastore per
  ADR-0009).
- **Owner sessions / state remain stateless HMAC tokens** (ADR-0004) and are **not** stored.

## Consequences

**Positive**
- Bots in the owner's preferred ecosystem (`discord.py` / `aiogram` are mature and async).
- Clean cross-language contract via a versioned schema; explicit, single-home token storage.

**Negative / costs**
- The **polyglot repo grows**: Rust plugin + TS backend/web/packages + **Python bots** → three
  toolchains, CI lanes, and deploy artifacts.
- The protocol contract must be **kept in sync across TS and Python** (mitigated by a shared JSON
  Schema + `protocolVersion`; ideally codegen).
- No code sharing between backend and bots — only the schema.

**Neutral**
- Supersedes ADR-0007's **stack** and **shared-package** decisions; the rest of ADR-0007 stands.
  Confirms MariaDB token storage. No plugin/wire-contract change.

## Open Questions / Risks

1. **Telegram library** (`aiogram` vs `python-telegram-bot`) — finalize at implementation; both fine. **Decided:** aiogram (async; matches the `websockets` client).
2. **Schema sync** — hand-maintained vs codegen from JSON Schema; prefer codegen to avoid TS/Python drift. **Decided:** codegen both sides from the JSON Schema.
3. **Python tooling** in a mostly-JS/Rust monorepo (packaging/venv, task running, CI) — pick `uv` or
   Poetry; Dockerize per bot. **Decided:** `uv`; Dockerize per bot.
4. **`protocolVersion` negotiation** on the WS `hello` to handle backend/bot version skew. **Decided:** version in `hello`; reject on incompatible major.

## References

- ADR-0003 (ingest `Token` table), ADR-0007 (bot topology / protocol / linking — amended here),
  ADR-0009 (MariaDB datastore; `LinkToken`)
- `discord.py`, `aiogram` / `python-telegram-bot`, `websockets`
