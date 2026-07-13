# ADR-0003 — Multi-tenant backend with token-authenticated ingest

- **Status:** Accepted
- **Amends:** [ADR-0001](0001-zellij-session-telemetry-architecture.md) — backend becomes multi-tenant + authenticated; wire contract → **v3**
- **Extends:** [ADR-0002](0002-configurable-telemetry-privacy-controls.md) — adds plugin `token` and `server_url` config
- **Amended by:** [ADR-0004](0004-google-auth-owner-sign-in.md) — supplies owner authentication (Google); closes the bootstrap gap below. [ADR-0009](0009-durable-notification-delivery.md) — picks **MariaDB** as the datastore. [ADR-0037](0037-host-shared-plugin-identity-via-cache.md) — the plugin's `machineId` (and token) persist in host-shared **`/cache`**, not per-session `/data`, and `machineId` is hostname-derived (closes the "wipe → history splits" gap)
- **Date:** 2026-07-10
- **Deciders:** project owner
- **Tags:** backend, multi-tenancy, auth, tokens, plugin, self-hosting
- **Testing:** unit (token hash, ≤10 cap, expiry, tenant scoping) + integration (ingest + MariaDB, 401/200) — see [ADR-0014](0014-testing-strategy.md)

## Context

ADR-0001/0002 describe a single-user tool: a plugin POSTs snapshots to one backend that prints them.
We now need the backend to serve **many users**, each with **many machines**, and to authenticate
who is sending data. Concretely:

- The backend issues **tokens** to an account; a plugin instance is configured with a token and uses
  it to authenticate its ingest.
- An account may have **up to 10** tokens, each with its own **expiry** (a fixed duration) or **no
  expiry** (infinite).
- The project will be **open-sourced**, so the plugin must let users point at a **different backend
  URL** (self-hosting) instead of the default hosted instance.

This ADR defines multi-tenancy, the token model, the authenticated ingest path, and the two new
plugin settings. It does **not** define how account *owners* log in, nor the status website.

### Scope & sequencing

- **This ADR (0003):** accounts, machines, tokens, token-authenticated **ingest**, and the plugin's
  `token` / `server_url` settings.
- **ADR-0004 (next): Google auth** — how account owners authenticate to *manage* tokens and how
  accounts are created. This ADR defines the management API *surface* but leaves owner-authentication
  to 0004 (see Open Questions for the bootstrap gap).
- **Later ADRs:** *attentions* ([ADR-0005](0005-attentions-detection-and-triggering.md)), then
  *notifications* (ADR-0006), then **the status website** — a read API + UI that queries per-account
  status ("show everything"). This ADR makes data **persist per account/machine** so those can read
  it; the read endpoints/UI come later.

## Decision Drivers

- **Two separate trust planes.** Ingest (a plugin pushing data) and account management (reading data,
  managing tokens) are different privileges and must not share a credential.
- **Tenant isolation.** Every stored row and query is scoped to an `accountId`.
- **Rotation without data loss.** Replacing/expiring a token must not orphan a machine's history.
- **Self-host friendliness** (open source): a plugin points anywhere; the backend runs for one user
  or many with the same code.
- **Least blast radius** if an ingest token leaks.

## Considered Options

**Token ↔ machine relationship** *(decided with the project owner)*
1. **Account-level tokens + a stable, plugin-persisted `machineId`** *(chosen)* — tokens authorize;
   machines are identified independently, so rotation/segmentation of tokens never resets machine
   identity, and "multiple machines" is decoupled from the ≤10 token cap.
2. Token = machine — simplest, per-machine revoke, but rotating a token starts a new machine identity
   (history resets). Rejected for the history-loss and coupling.

**Where the ingest credential travels**
1. **`Authorization: Bearer <token>` header** *(chosen)* — standard; kept out of the JSON body so it
   never lands in snapshot logs. (`web_request` supports arbitrary headers — see FINDINGS §5.)
2. Token in the JSON body — rejected: leaks into any body logging/inspection.
3. Token in the URL query string — rejected: leaks into access logs/proxies.

**Machine identity source**
1. **Plugin-generated persistent id in `/data`** *(chosen)* — stable, independent of the display
   hostname (which ADR-0002 lets users alias/hide) and of the token.
2. Hostname — rejected: can be hidden/aliased/duplicated across machines.
3. Derived from the token — rejected: couples identity to credential rotation.

**Token at rest**
1. **Store a SHA-256 hash + an indexed lookup prefix; show the secret once** *(chosen)* — tokens are
   high-entropy random, so a fast hash is sufficient and enables O(1) lookup.
2. Plaintext — rejected. Reversible encryption — unnecessary.

**Datastore**
1. **Relational (Postgres) recommended** — natural fit for accounts/tokens/machines with tenant
   scoping. The concrete choice is flagged as an implementation decision (see Open Questions).

## Decision

### 1. Entities (all tenant-scoped by `accountId`)

- **Account** — `accountId` (internal). The owner of tokens, machines, and data. Linked to a Google
  identity in ADR-0004; treated here as an abstract owner.
- **Token** — an account-level **ingest credential**:
  `id`, `accountId`, `lookupPrefix` (indexed), `secretHash` (SHA-256), `label?`, `createdAt`,
  `expiresAt` (nullable — `null` = infinite), `lastUsedAt`, `revokedAt` (nullable).
  Format `ztf_<base62 random ≥32 bytes>`; the full secret is shown **once** at creation and never
  stored or returned again.
- **Machine** — a reporting source under an account:
  `machineId` (plugin-generated, persisted in the plugin's `/data`), `accountId`, `displayName`
  (from ADR-0002's `machine.name`; mutable; may be `<hidden>`), `firstSeenAt`, `lastSeenAt`.
  Auto-registered on its first ingest.
- **Snapshot** — the latest state per machine (`account → machine → sessions → tabs → panes`),
  stored so the website (ADR-0008) can read it.

### 2. Token lifecycle & limits

- **Cap: ≤10 *active* tokens per account** (active = not revoked and not expired). Revoked/expired
  tokens free a slot. Creating an 11th active token → **409**; the cap is enforced **atomically**
  (transaction / conditional insert) so concurrent creates can't exceed it.
- **Expiry:** each token carries `expiresAt`. Creation accepts either a duration (e.g. `1h`, `24h`,
  `7d`, `30d`, `90d`, `365d`, or an explicit seconds value) or **`infinite`** (`expiresAt = null`).
  Expiry is enforced **server-side** on every ingest and every listing.
- **Revocation** is immediate (sets `revokedAt`; subsequent ingest → 401).

### 3. Ingest (the authenticated plugin path)

`POST {server_url}/api/v1/ingest`, `Authorization: Bearer ztf_…`, `Content-Type: application/json`,
body = wire contract **v3** (§6). The account is derived **server-side** from the token and is **not**
in the body.

Backend handling:
1. Split the token → look up by `lookupPrefix` → verify `secretHash` (constant-time). Miss/expired/
   revoked → **401**.
2. Resolve `accountId`; upsert the machine (`accountId`, `machineId`, `displayName`); auto-register if
   new.
3. Store/replace the machine's latest snapshot; update `token.lastUsedAt` and `machine.lastSeenAt`.
4. **200**.

> **Ingest tokens are write-only.** A token authorizes pushing snapshots for its account. It grants
> **no** ability to read account data or manage tokens — those require owner authentication
> (ADR-0004). A leaked ingest token therefore lets an attacker spoof/DoS snapshots for that account,
> but not read data or touch the account. This scoping is a core property, not an add-on.

### 4. Token management API (surface only; owner-auth = ADR-0004)

Requires an **authenticated account owner** (mechanism defined in ADR-0004):

- `POST /api/v1/tokens` — `{ label?, ttl: <duration> | "infinite" }` → returns the secret **once** +
  metadata. Enforces the ≤10-active cap (409 if exceeded).
- `GET /api/v1/tokens` — list token **metadata** (never secrets): id, label, createdAt, expiresAt,
  lastUsedAt, revoked/expired status.
- `DELETE /api/v1/tokens/:id` — revoke immediately.

Machine/status **read** endpoints (list machines, fetch snapshots, forget a machine) are defined in
ADR-0008; the storage here supports them.

### 5. Machine identity

On first run the plugin generates a random `machineId` and persists it (e.g. `/data/machine-id`; the
plugin's `/data` is its persistent dir — FINDINGS §12). It is sent in every snapshot and is stable
across restarts and across token changes. It is **independent** of the display hostname, so aliasing
or hiding the machine name (ADR-0002) does not change identity. If `/data` is wiped, a new
`machineId` is generated (the machine appears as new — see Open Questions).

### 6. Plugin config additions (extends ADR-0002 §1)

Two new keys, read like the others (`load` + `PluginConfigurationChanged`, live):

| Key | Meaning |
| --- | --- |
| `token` | The ingest token (secret). **Required to send** — if unset, the plugin idles and warns once. |
| `server_url` | Backend base URL. Defaults to the hosted instance; override for self-hosting. Must be `https://` (plaintext `http://` refused except `localhost` for dev). |

```kdl
plugin location="file:/path/to/zantiflow-plugin.wasm" {
    token       "ztf_9f3a…"
    server_url  "https://ingest.myhost.example"   // omit to use the default hosted instance
    // …ADR-0002 privacy keys…
}
```

> **Secret handling:** the token sits in the plugin config (KDL layout / CLI) in plaintext. Prefer
> passing it via `--configuration` or a permission-restricted layout file, and keep in mind the
> write-only scoping above limits the damage of a leak. A future "device pairing" flow is noted as a
> possible improvement.

### 7. Wire contract v3 (extends v2)

Changes from ADR-0002's v2: `version` → `3`; add top-level **`machineId`**; the account and token are
**not** in the body (account is derived from the `Authorization` token). Everything else (v2
`machine`, `privacy`, `sessions` tree, nullable names) is unchanged.

```json
{
  "version": 3,
  "machineId": "m-7f3a1c2e",
  "capturedAtTick": 42,
  "privacy": { "full": true, "machine": "alias", "sessionNames": "send", "tabNames": "send", "paneNames": "hidden" },
  "machine": { "source": "alias", "name": "red-laptop" },
  "sessions": [ /* …unchanged v2 sessions → tabs → panes… */ ]
}
```

### 8. Backend & storage changes

- ADR-0001's in-memory, console-only model is **superseded** by a **persistent, multi-tenant store**
  (accounts, tokens, machines, latest snapshots), recommended relational (Postgres). Every query is
  scoped by `accountId`.
- ADR-0001's console rendering is **demoted to an optional dev/debug view**; the authoritative output
  is stored state served via the read API (ADR-0008).
- The ingest endpoint moves from `POST /snapshot` to `POST /api/v1/ingest` (versioned, authenticated).
- **Self-host:** the same backend serves one or many accounts; a self-hoster is just an account on
  their own instance. Backend deployment/secret management is out of scope here.

## Consequences

**Positive**
- Clean tenant isolation and a clear split between write-only ingest tokens and owner management.
- Token rotation/segmentation without losing machine identity or history.
- "Multiple machines" is independent of the ≤10 token cap.
- Leaked ingest token has limited blast radius (spoof/DoS ingest only).
- Self-host works with the same code by changing one plugin setting.

**Negative / costs**
- Introduces real persistence, a machines table, and token lifecycle management (previously none).
- The token is a plaintext secret in the plugin config — a leak enables snapshot spoofing/DoS for
  that account.
- `machineId` lives in `/data`; wiping it makes the machine reappear as new (history splits).
- A public, open-source ingest endpoint adds an **abuse surface** (needs rate limiting/quotas).
- Owner authentication is **not yet defined**, so token creation has no API caller until ADR-0004
  (bootstrap gap).

**Neutral**
- Wire contract v2 → v3. Amends ADR-0001 (backend) and extends ADR-0002 (plugin config).

## Open Questions / Risks

1. **Bootstrap before ADR-0004:** ~~with no owner-auth yet, tokens can't be created via the API.~~
   **Resolved by [ADR-0004](0004-google-auth-owner-sign-in.md):** account owners authenticate with
   Google Sign-In → an `ztf_session` cookie, and the token-management API is gated by that session.
2. **Datastore choice** — **resolved by [ADR-0009](0009-durable-notification-delivery.md): MariaDB.**
   (The latest-snapshot representation — row vs cache — remains an implementation detail.)
3. **Rate limiting / quotas** per account and per token for the public ingest endpoint; abuse handling. **Decided:** yes — per-token/account ingest caps + login/redeem/read-API/SSE rate limits (defaults tuned at build).
4. **`machineId` durability** — confirm the plugin can write `/data` in the target sandbox; define
   behavior on wipe/regeneration and on repo/image re-clones (id collisions/duplication). **Decided:** on `/data` wipe, regenerate (appears new); re-clone dup flagged; verify `/data` write at build.
5. **History retention** — website "show everything": latest-state only, or recent history? Define
   with ADR-0008; affects storage growth. **Decided:** latest state always; **no history retained** (latest state only); pane-output latest-only.
6. **TLS strictness** — refuse `http://` except `localhost`? **Decided:** yes — refuse plaintext `http:` except localhost; surface a clear warning.
7. **Token secret in plaintext config** — **resolved by [ADR-0012](0012-plugin-device-pairing.md):
   device-pairing** (the plugin shows a code, the user approves it on the website, and the token is
   delivered to the plugin and stored in `/data` — no secret in a layout file). Manual token entry
   remains supported.

## References

- ADR-0001 — [session telemetry architecture](0001-zellij-session-telemetry-architecture.md)
- ADR-0002 — [configurable privacy controls](0002-configurable-telemetry-privacy-controls.md)
- FINDINGS §5 (`web_request` headers), §12 (plugin `/data` persistence) — [FINDINGS.md](../FINDINGS.md)
