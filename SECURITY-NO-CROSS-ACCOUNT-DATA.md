# Why one account can never read another account's data

**Status:** audited 2026-07-12 (backend `apps/backend`, wire contract v4). This document explains the
mechanisms that make cross-tenant data access impossible in zantiflow, so a reviewer can verify the
claim and a future change can be checked against the invariants that hold it up.

The threat this addresses: **a malicious actor — an account owner, a leaked ingest token, a hostile
plugin, or a compromised bot — trying to read or infer another account's machines, sessions, pane
output, notifications, tokens, or profile.** The short answer is that every tenant-scoped read is
bound to the caller's `accountId` at the data layer, the two authentication planes are never
conflated, and machine identifiers are unguessable global keys that are ownership-checked on every
write. No endpoint returns another tenant's data, and nothing an attacker can reach discloses it.

---

## 1. Two authentication planes that are never conflated

zantiflow has exactly two ways to authenticate, and they reach disjoint sets of handlers.

| Plane | Credential | Set on request | Can do | Cannot do |
|-------|-----------|----------------|--------|-----------|
| **Owner session** | `ztf_session` HMAC cookie (Google Sign-In) | `req.account` | Read/manage **its own** account | Touch another account; be forged |
| **Ingest token** | `Authorization: Bearer ztf_…` | `req.ingest` | **Write** snapshots/output/control for **its own** machines | Read any data; manage the account; reach a read handler |
| **Bot service** | `serviceSecret` on the internal WS | (WS conn) | Relay name-free deliveries + link requests | Read account data; act on another platform |

- **Owner session** — `requireSession` (`auth/session.ts`) verifies the cookie's fixed-algorithm
  HMAC-SHA256 (timing-safe, `auth/tokens.ts`), then **re-checks the database every request**: the
  account must exist, not be soft-deleted (`deletedAt`), and its `sessionEpoch` must still match the
  cookie. Bumping `sessionEpoch` (`POST /auth/logout-all`) invalidates every outstanding cookie. The
  cookie payload carries only `{ accountId, epoch, typ:'session' }` — no other account's data, and a
  `typ` claim domain-separates it from OAuth `state` tokens so neither can be replayed as the other.
- **Ingest token** — `ingestAuth` (`ingest/auth.ts`) → `authenticateIngest` (`tokens/service.ts`)
  resolves the presented secret by an indexed `lookupPrefix`, compares the SHA-256 `secretHash`
  timing-safe, and enforces expiry + revocation **on every request**. It attaches only
  `{ accountId, tokenId }`. Ingest tokens are **write-only**: they are mounted only under
  `/ingest`, `/output`, `/control` (`http/router.ts`) and cannot reach a single read/management route.
- The two planes use **different middleware and different request properties** (`req.account` vs
  `req.ingest`). No handler reads both. A leaked ingest token therefore grants **no read access at
  all**, and an owner session cannot push telemetry.

---

## 2. The tenant-scoping invariant: every query carries `accountId`

Every tenant-owned row stores a scalar `accountId` and every model is indexed by it
(`prisma/schema.prisma`). Every data-layer query on tenant data is scoped by `accountId` — **not**
merely filtered in the route. Representative reads:

- **Machines / snapshots / activity / attentions** — `listMachines`, `getMachine`, `forgetMachine`
  (`machines/service.ts`) scope by `{ accountId }` or `{ id, accountId }`. A machine owned by another
  account reads as **404**, never as another tenant's data.
- **Pane output** — `readOutput`, `registerRequest`, `submitOutput` (`output/service.ts`) scope every
  row by `accountId` and re-check machine ownership (`ownsMachine`).
- **Attentions** — `listActiveAttentions` and the episode engine `processAttentions`
  (`attentions/service.ts`) scope by `accountId`.
- **Notifications** — `listRecentNotifications`, `createForFired` (`notifications/service.ts`) scope
  by `accountId`; push subscriptions and channel links are fetched `where: { accountId }`.
- **Tokens** — `listTokens`, `revokeToken`, `mintToken` (`tokens/service.ts`) scope by `accountId`;
  listing returns **metadata only** (the secret is shown exactly once at creation, never again).
- **Profile** — `GET /auth/me` returns only `req.account` (the caller's own fields).

A repo-wide sweep of every Prisma `findUnique/findFirst/findMany/groupBy/update*/delete*/count/upsert`
call confirms: **no client-reachable query trusts a client-supplied id alone.** Every one is either
scoped by `accountId`, or keyed by a value that is an unguessable secret (token `lookupPrefix`, link
`tokenHash`, pairing `sessionId`) or a global-unique identifier that is then ownership-checked
(`machineId`, below).

---

## 3. `machineId` is an unguessable **global** key, ownership-checked on every write

`Machine.id` is the primary key (`schema.prisma`, `id String @id // plugin-generated machineId`), so a
`machineId` maps to **exactly one account** — the database enforces it. The plugin generates it from a
256-bit CSRNG and stores it in its private `/data`; it is never shown to anyone but its owner.

This makes two things true:

1. **A token cannot hijack another account's machine.** On ingest, if the `machineId` already exists
   under a different account, the write is refused (`ingest/service.ts`, `storeSnapshot`). The control
   and pane-output planes repeat the identical ownership guard (`control/service.ts`,
   `output/service.ts`). The first account to register a given id owns it; nobody else can write it.
2. **A `machineId`-scoped sub-query can't cross tenants.** Because the id is globally unique and the
   owning machine is confirmed to belong to the caller first, any follow-up query keyed by that
   `machineId` stays within the tenant. (As defence-in-depth we still add `accountId` explicitly —
   see §6.)

Knowing another account's `machineId` buys an attacker nothing: the read plane is `accountId`-scoped
(→ 404) and the write planes refuse it (→ 403). And the id can't be obtained in the first place — it
appears only in that owner's own authenticated responses.

---

## 4. The live stream (SSE) is per-account and carries no payload data

The dashboard's `GET /api/v1/stream` (`sse/router.ts`) is owner-gated and subscribes on the caller's
own `accountId`. The in-process bus (`sse/bus.ts`) keys subscribers by `accountId`: `publish(accountId,
…)` only ever reaches that account's subscribers, and a client can only subscribe to its own account.
Even then, the events (`machine.update`, `attention.update`) carry **only a `machineId` string** —
never snapshot content. The browser reacts by re-fetching through the `accountId`-scoped read API. So
even a hypothetical bus mix-up could leak at most a bare machine id, and the subsequent fetch is still
tenant-checked.

---

## 5. Notifications and chat bots see no account internals

Notification text is composed to be **name-free and generic** (`notificationText` in
`notifications/service.ts`) — e.g. `"Claude needs your input"`. It never contains session/tab/pane
names or pane content. Bots receive only `{ deliveryId, platformUserId, text }` and route to the
`platformUserId` bound to the account through a `ChannelLink`, which is `@@unique([platform,
platformUserId])` — one platform user maps to at most one account. Linking requires a **single-use,
hashed, short-TTL, account-scoped** token that the owner mints and the platform user redeems through
the real (rate-limited) bot; the backend never trusts a `platformUserId` except via that consumed
token (`bots/linkToken.ts`, `bots/hub.ts`). Web-push payloads are likewise name-free (ADR-0006).

---

## 6. Hardening applied during this audit (2026-07-12)

Three defence-in-depth changes were made. None fixed a live cross-tenant read (there were none); each
removes a way one could be introduced later or narrows a trusted-plane blast radius.

1. **Bot plane pinned to its authenticated platform** (`bots/hub.ts`). Every bot message is now scoped
   to the platform the connection authenticated as: `delivery_result` acks are filtered by
   `channel: <conn platform>`, `unlink_notice` and `link_request` act on `<conn platform>`, and any
   frame whose own `platform` field contradicts the connection is ignored. A compromised or buggy
   discord bot can no longer settle or unlink a telegram account's rows (and vice-versa). *(No data is
   read on this plane regardless — delivery text is name-free.)*
2. **Explicit `accountId` on the `getMachine` activity read** (`machines/service.ts`). The per-pane
   activity query now includes `accountId` alongside `machineId`, so tenant isolation there no longer
   depends on the upstream ownership check — it matches every sibling query.
3. **Uniform, generic `403` on the three write-plane ownership guards** (`ingest/service.ts`,
   `control/router.ts`, `output/router.ts`). Refusing a machine owned by another account no longer
   discloses *why* (previously `machine_owned_by_another_account` / `machine_not_owned`); all three
   now return a bare `403 forbidden`. Combined with §3, the only cross-account-observable signal is
   whether a **guessed 256-bit `machineId`** is already registered — which reveals no user data and
   requires already possessing a secret that is never exposed to non-owners.

---

## 7. Supporting controls

- **Errors never leak internals** — handlers return the fixed envelope `{ error: { code, message } }`;
  unexpected errors become an opaque `500` with no stack trace (`http/errors.ts`).
- **CORS is locked to the single web origin** with credentials — never wildcard-with-credentials; the
  API sets a hard `default-src 'none'` CSP and disables `x-powered-by` (`http/app.ts`).
- **Authenticated responses are `Cache-Control: no-store`** (`/auth/me`, machines, tokens, output,
  attentions, notifications, control), and the web service worker **never caches `/api/`**
  (`apps/web/public/sw.js`).
- **The web tier is a same-origin proxy** with no server-side cross-user rendering — all dashboard
  data is fetched client-side with the caller's cookie (`apps/web/next.config.mjs`).
- **Secrets come from env only**, `TOKEN_SECRET` is required ≥256-bit, cookies are `Secure` in prod
  (`config/index.ts`); nothing is hardcoded or logged.
- **Rate limits** are keyed by the authenticated principal (token / account), not just IP, so one
  tenant can neither flood nor starve another.

---

## 8. Accepted residual risks (none is a cross-account data read)

- **`machineId` existence oracle** — an attacker with a valid token who *already knew* a victim's
  256-bit `machineId` could tell it is registered (403) rather than free (200). It discloses no user
  data and is unreachable because `machineId`s are never shown to non-owners. Mitigated by the uniform
  403 (§6.3), per-token rate limits, and 256-bit unguessability.
- **Trusted bot plane** — a leaked `BOT_SERVICE_SECRET` is a compromise of trusted infrastructure. It
  is now bounded per-platform (§6.1) and still cannot read account data (delivery text is name-free).
  Self-hosters run their own bots and secret.
- **Stateless session cookie** — a stolen `ztf_session` is valid until its TTL unless the owner runs
  `logout-all` (bumps `sessionEpoch`). This is the documented trade-off of a stateless HMAC session
  (ADR-0004); it does not enable cross-account access.

---

## 9. Enforcement in tests

Cross-tenant isolation is asserted by the integration suite (real MariaDB, testcontainers):

- **Tokens** — account B cannot revoke account A's token; a listed token never re-exposes its secret.
- **Machines** — `GET`/`DELETE` of another account's machine returns **404**; `forget` removes only
  the caller's rows.
- **Ingest** — a token presenting another account's `machineId` is refused **403**.
- **Control / pane output** — the same IDOR guard returns **403**; a token only ever sees its own
  machine's pending output.
- **SSE** — an ingest on account A publishes only to account A's subscribers (cross-account isolation).
- **Bots** — link tokens are single-use and account-scoped; deliveries route only to the linked user.

---

## 10. Invariants to preserve (checklist for future changes)

Any new endpoint or query must keep all of these true, or it risks a cross-tenant leak:

1. A tenant-data route sits behind exactly one plane — `requireSession` (read/manage) **or**
   `ingestAuth` (write) — and never mixes `req.account` with `req.ingest`.
2. Every tenant-data query is scoped by `accountId` at the data layer (not just in the route), or is
   keyed by an unguessable secret / a global-unique id that is ownership-checked first.
3. `machineId` writes are refused (generic `403`) when the machine belongs to another account.
4. SSE/bus publish targets the owning `accountId`; event payloads carry ids, not tenant content.
5. Anything sent off-box (push, bots) is name-free and routed only to an identity bound to the account.
6. Errors return the standard envelope; no internals, stack traces, or "why-forbidden" reasons leak.
7. Authenticated responses are `no-store`; the SW never caches `/api/`.
