# ADR-0012 — Plugin token provisioning via device pairing

- **Status:** Accepted
- **Resolves:** [ADR-0003](0003-multi-tenant-backend-and-token-auth.md)'s "token secret in plaintext config" open question
- **Builds on:** [ADR-0003](0003-multi-tenant-backend-and-token-auth.md) (ingest tokens), [ADR-0004](0004-google-auth-owner-sign-in.md) (owner approval on the website), [ADR-0009](0009-durable-notification-delivery.md) (MariaDB)
- **Amended by:** [ADR-0037](0037-host-shared-plugin-identity-via-cache.md) — the received token persists in host-shared **`/cache`**, not per-session `/data`, so a host pairs **once** across its per-session plugin instances
- **Date:** 2026-07-10
- **Deciders:** project owner
- **Tags:** plugin, tokens, device-pairing, onboarding, security
- **Testing:** unit (userCode + rate-limit) + integration (pair flow + MariaDB) + Playwright (enter code → approve) — see [ADR-0014](0014-testing-strategy.md)
- **Wire contract:** unchanged; adds a pairing API + local token persistence

## Context

[ADR-0003](0003-multi-tenant-backend-and-token-auth.md) has the user **paste a secret ingest token**
into the plugin's config/layout (plaintext, world-readable risk). This ADR adds a **device-pairing**
flow — the OAuth 2.0 **Device Authorization Grant** (RFC 8628), adapted — so the plugin obtains its
token **without a pasted secret**. Manual token entry stays supported (headless/automation).

## Decision Drivers

- **No plaintext secret** in shared config files.
- Smooth onboarding: **approve on the website** (already the owner-auth surface, ADR-0004).
- Reuse ingest tokens (ADR-0003); a **standard, well-understood** pattern.

## Considered Options

- **Pattern:** device-authorization-grant (code → approve → poll) *(chosen)* vs pasted token (ADR-0003,
  kept as fallback) vs QR/deep-link (a nicety on top).
- **Token delivery:** plugin **polls** for the issued token *(chosen)* — the plugin has no ingress, so
  it can't be pushed to.
- **Token storage:** persist in the plugin's **`/data`** *(chosen, FINDINGS §12)* — not the layout file
  (the thing we're avoiding).

## Decision

### 1. Flow

1. A plugin with no token enters **pairing mode**: `POST {server_url}/api/v1/pair/start` (no auth) →
   the backend creates a `PairingSession` and returns `{ sessionId (unguessable), userCode (short,
   e.g. ABCD-1234), verificationUri, expiresIn, interval }`.
2. The plugin **displays** `userCode` + `verificationUri` ("Go to zantiflow.com/pair and enter
   ABCD-1234").
3. The user (logged in, ADR-0004) opens the page, enters `userCode` → the backend **binds** the pairing
   to their account.
4. On approval, the backend **mints an ingest token** (ADR-0003; counts against the 10-token cap;
   hashed in MariaDB) bound to the pairing.
5. The plugin **polls** `POST /api/v1/pair/poll { sessionId }` at `interval` → `authorization_pending`
   until approved, then `{ token }` **once**. The plugin **persists the token in `/data`** and starts
   sending. (RFC-8628-style responses: `authorization_pending` / `slow_down` / `expired` / `denied` /
   approved.)

### 2. Data model

`PairingSession { id, userCodeHash, status (pending|approved|consumed|expired|denied), accountId?,
issuedTokenId?, machineHint?, createdAt, expiresAt, lastPolledAt }` — short TTL (~10 min); `userCode`
**single-use**; polling is keyed by the **unguessable `sessionId`**, never the short code.

### 3. Security

- Short `userCode` + short TTL + **rate-limited entry** (defends the short code against brute force).
- Polling uses the unguessable `sessionId`; the token is delivered **once**, then `consumed`.
- The issued token is a normal **write-only ingest** token (ADR-0003).
- Approval requires an **authenticated owner**; the page shows what's being paired (a `machineHint` the
  plugin may send). Denial/expiry handled explicitly.

### 4. Config

- Plugin: **absent `token` → pairing mode** (or explicit `pairing = true`). Once paired, the token lives
  in **`/data`** (survives restarts; not in the layout file). `server_url` is still configurable.
- **Manual `token` config remains supported** (skips pairing) for automation/headless.

### 5. Coexistence

Pasted-token (ADR-0003) and device-pairing are both valid: **pairing is the recommended default for
humans**, manual token for automation. This **resolves ADR-0003's plaintext-secret concern**.

## Consequences

**Positive**
- No secret in shared config; clean onboarding; a standard pattern; reuses ingest tokens/auth; the
  token lives in the plugin's private `/data`.

**Negative / costs**
- More backend surface (pairing endpoints + `PairingSession` table + an expiry cron).
- The plugin must render a code and run a **polling loop** (extra UI + logic).
- Short-code **brute-force surface** (mitigated by TTL + rate limiting).
- Depends on `/data` being writable in the sandbox (shared with ADR-0003's `machineId` question).

**Neutral**
- Resolves ADR-0003's open question; manual token retained; no wire-contract change.

## Open Questions / Risks

1. Confirm the plugin can write `/data` in the target sandbox (shared with ADR-0003's `machineId`). **Build task** — real-Zellij smoke check (ADR-0014).
2. `userCode` format/length vs brute-force vs usability; the exact rate-limit policy. **Decided:** ~8-char base32 code, ~10-min TTL, entry rate-limited (e.g. 5 tries).
3. `machineId` (ADR-0003) stays **independent** of pairing (plugin-generated); pairing only provisions
&  **Decided.**
4. Re-pairing / rotation UX (revoke → re-pair). **Decided:** revoke token; plugin re-enters pairing.
5. Surfacing a meaningful machine label at approval time (the `machineHint` source). **Decided:** the plugin sends a hostname hint (subject to ADR-0002 privacy).

## References

- ADR-0003 (ingest tokens, `/data` `machineId`, the plaintext-secret concern), ADR-0004 (owner auth to
  approve), ADR-0009 (MariaDB `PairingSession`)
- RFC 8628 — OAuth 2.0 Device Authorization Grant
