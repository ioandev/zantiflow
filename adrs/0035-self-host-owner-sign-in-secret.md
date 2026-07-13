# ADR-0035 — Self-host owner sign-in via a configured secret

- **Status:** Accepted (implemented)
- **Amends:** [ADR-0004](0004-google-auth-owner-sign-in.md) — adds a second owner-auth path (no Google app required); closes its self-host friction
- **Date:** 2026-07-12
- **Deciders:** project owner
- **Tags:** auth, self-hosting, backend, owner-session, security, config
- **Testing:** unit (secret compare, config validation) + recommended integration (mount gating, `401 invalid_secret`, `204` + cookie) — see [ADR-0014](0014-testing-strategy.md)

> **Retroactive ADR:** This decision was already implemented in the codebase before this ADR was written; it is recorded here after the fact to close a documentation gap — it was not written at the right time.

## Context

[ADR-0004](0004-google-auth-owner-sign-in.md) made **Google Sign-In the only way an account owner
authenticates** to the read/management plane (the `ztf_session` HMAC cookie). It is the right default
for the **hosted** multi-tenant deployment, but it imposes real setup friction on a **self-hoster**:
ADR-0004 §"Google Cloud setup" requires each deployer to register their *own* Google OAuth app —
create a Cloud project, configure an OAuth consent screen (External + publish), and manage redirect
URIs — before they can log in to their own single-user instance at all. For someone running zantiflow
on a personal box to watch their own machines, that is disproportionate ceremony, and it makes the
backend un-loggable-into out of the box without a third-party dependency.

The backend already has a proven, in-house primitive for verifying a high-entropy secret without an
at-rest artifact — ingest-token verification (`apps/backend/src/tokens/secret.ts`: fast SHA-256 +
`timingSafeEqual`, appropriate for random secrets rather than user passwords, audit F2/F7) — and a
complete owner-session plane keyed only by `accountId` (cookie + DB re-check + `sessionEpoch`,
`apps/backend/src/auth/session.ts`). A self-host login path can reuse both wholesale.

The implementation shipped (`apps/backend/src/auth/local.ts`, `apps/backend/src/auth/router.ts`,
`apps/backend/src/config/index.ts`) and its tests (`test/local.test.ts`, `test/config.test.ts`) cite
"ADR-0035" in 12+ places, but the ADR was never written. This records it.

## Scope

- **This ADR (0035):** an optional, self-host-only owner sign-in using a single configured secret; the
  config surface, the two routes it adds, the reserved owner identity, and the security reasoning.
- **Not here:** the owner-session mechanism itself (ADR-0004 §2 — unchanged and reused verbatim), the
  ingest-token (write) plane (ADR-0003), and the web login-surface presentation (deferred UX,
  ADR-0019 — the backend only exposes which methods are enabled).

## Decision Drivers

- **Self-hosting must not *require* a Google Cloud project.** A single-user deploy should be loggable
  into with only the env secrets the deployer already manages (`TOKEN_SECRET`, VAPID, `BOT_SERVICE_SECRET`).
- **Reuse the owner-session plane unchanged.** No second session mechanism, no new cookie, no new
  per-account scoping — the local owner must be a normal `Account` so `/auth/me`, logout, logout-all,
  tiers/promo, tokens, and machines all work identically.
- **Keep the two auth planes separate** (ADR-0003): this is strictly the *owner* plane; it never
  touches the write-only ingest-token plane.
- **One web image for hosted *and* self-host.** The server must advertise which methods are enabled so
  the same front-end renders the right login surface without a rebuild.
- **No new at-rest secret to protect**, and **brute-force resistance** for what is a static credential.

## Considered Options

1. **Google-only (status quo, ADR-0004).** Zero new code, but forces every self-hoster through a full
   Google OAuth app registration to log into their own box. Rejected — the friction is the problem.
2. **Local username/password accounts** (a credential table + a slow KDF + reset flow). A whole
   password store and lifecycle for what is a **single-owner** instance; new at-rest secret material to
   guard; overkill. Rejected.
3. **A single shared secret from config, verified in memory *(chosen)*.** No new table, no at-rest
   artifact (the secret is verified against `config`, never persisted), reuses the owner-session plane;
   the deployer already handles env secrets. Fast SHA-256 + timing-safe compare is the correct
   primitive for a high-entropy secret (same reasoning as ingest tokens).
4. **Delegate to reverse-proxy auth** (Caddy basic-auth / forward-auth). Offloads credentials to the
   proxy but couples the app to proxy config and yields no in-app session/logout/`logout-all`.
   Rejected as the *primary* path (a self-hoster may still front the app this way externally).

## Decision

Add an **optional, self-host-only** owner sign-in gated entirely on a single config secret,
`SELF_HOST_SECRET`. **Google stays the hosted default; the two can coexist** (a deployment may enable
either or both).

**Config (`src/config/index.ts`).** `SELF_HOST_SECRET` is parsed with a `z.preprocess` that maps the
empty string to `undefined` (so a blank `.env` line doesn't brick boot), then `.string().min(32)`
(≥256-bit, matching `TOKEN_SECRET`) `.optional()`. A `superRefine` **rejects boot** if
`SELF_HOST_SECRET === TOKEN_SECRET`: `TOKEN_SECRET` is the HMAC key that *signs* session cookies, so
reusing it as the login secret would let a leak of the login secret forge `ztf_session` cookies
directly. The parsed value surfaces as `Config.selfHostSecret?: string` (`undefined` = feature off).

**Verification (`src/auth/local.ts`).** `localSecretMatches(config, presented)` returns `true` iff a
string `presented` matches `config.selfHostSecret`, compared timing-safe over fixed-length SHA-256 hex
via `secretHashMatches(presented, hashSecret(config.selfHostSecret))` (`tokens/secret.ts`). Non-strings
and length mismatches return `false` without throwing (no length leak). The secret is **verified
against config and never stored** — there is no password hash at rest to crack. The local owner is a
fixed reserved identity: `LOCAL_PROVIDER = 'local'`, `LOCAL_OWNER_ID = 'owner'`, and
`localOwnerProfile()` → `{ sub: 'owner', email: null, emailVerified: null, name: 'Owner', picture: null }`,
so it funnels through the same `upsertAccount` path as OAuth (`src/auth/accounts.ts`) and becomes a
normal `Account` under identity `('local', 'owner')`.

**Routes (`src/auth/router.ts`).**
- `GET /auth/methods` (unauthenticated, no secret material) returns
  `{ google: providers.some(p => p.id === 'google'), local: Boolean(config.selfHostSecret) }` — `google`
  derived from the *actually-mounted* providers, not raw config — so the shared web image renders the
  correct login surface.
- `POST /auth/local` is **mounted only when `config.selfHostSecret` is set** (an unconfigured
  deployment returns `404` here — no existence oracle beyond `/auth/methods`). It has its **own,
  stricter rate-limit bucket**, `tokenBucket({ capacity: 5, refillPerSec: 1/60, key: ipKey('auth_local') })`
  — a distinct key prefix that must never share the OAuth-start `auth` bucket (10 burst / 10-per-min),
  because a static secret is a brute-force target. On a valid secret it upserts the local owner and sets
  the **same `ztf_session` cookie** as Google via `setSessionCookie`, then returns **`204`** (the client
  owns the post-login redirect, unlike Google's server-side redirect). A wrong secret returns
  **`401 invalid_secret`** — a distinct code (not the generic `unauthorized`) so the web can tell "wrong
  secret" apart from "session expired"; a missing/non-string body field returns `400`.

Because the local owner is an ordinary account, the entire downstream owner plane —
`requireSession` DB re-check, `logout-all` (`sessionEpoch` bump), tiers/promo, token management,
machines, SSE, `accountId` scoping — works unchanged. The ingest wire contract is untouched (this is
purely an owner-plane addition).

## Consequences

**Positive**
- A self-hoster can log into their own instance with **one env secret** — no Google Cloud project, no
  consent screen, no redirect URIs.
- **One web image** serves hosted and self-host; `/auth/methods` drives the login surface at runtime.
- **No new at-rest secret** and **no new table** — the secret lives only in `config`; the owner is a
  normal `Account`, so every owner-plane feature works for free.
- The two auth planes stay cleanly separate; the brute-force surface is isolated behind its own strict
  bucket and only exists when the secret is configured (no oracle otherwise).

**Negative / costs**
- A **static shared secret** is a brute-force and leak target. Mitigated by: ≥256-bit length, a
  dedicated 5-burst / ~1-per-minute bucket, timing-safe compare, and the route being absent unless
  configured. A **stolen secret grants full owner access** until it is rotated; rotation means editing
  the env and restarting (there is no in-app rotation UI), and existing sessions persist until TTL or a
  `logout-all` epoch bump.
- The local owner is a **single fixed identity** `('local','owner')`, so an instance using this path is
  inherently **single-account**. This is the intended self-host shape; the hosted multi-tenant
  deployment simply does not set the secret. A self-hoster wanting multiple distinct owners must use
  Google.

**Neutral**
- Google and local sign-in **coexist**; enabling one does not disable the other.
- An empty `SELF_HOST_SECRET` env line is treated as unset (feature off), not an error.
- `SELF_HOST_SECRET` reuses the `min(32)` / 256-bit convention already applied to `TOKEN_SECRET`.

## Open Questions / Risks

- **Deploy discoverability gap.** `SELF_HOST_SECRET` is not yet in `apps/backend/.env.example` nor the
  ADR-0021 example compose / Caddy files, so a self-hoster cannot discover the option without reading
  code. It should be documented in the deploy example and the ADR-0023 docs site.
- **Endpoint-level test coverage.** Only unit tests exist (`localSecretMatches`, config parsing). The
  route behaviors — `404` when unconfigured, `401 invalid_secret`, `204` + cookie on success, and
  `/auth/methods` shape — should get a supertest integration test and a web login-surface Playwright
  test (ADR-0014).
- **No in-app secret rotation** (restart-to-rotate). Acceptable for a single-owner self-host box.
- **Multi-owner self-host** is out of scope by design (single fixed identity). Acceptable.

## References

- [ADR-0004](0004-google-auth-owner-sign-in.md) — Google owner auth and the `ztf_session` HMAC session
  this reuses; amended here to add a Google-free path (resolves its self-host friction).
- [ADR-0003](0003-multi-tenant-backend-and-token-auth.md) — accounts and the two-plane separation
  (owner vs write-only ingest) this preserves.
- [ADR-0018](0018-engineering-and-operational-conventions.md) §4/§9 — env/secrets fail-fast validation
  and the rate-limit shape the dedicated `auth_local` bucket follows.
- [ADR-0021](0021-dockerization-and-deployment.md) — the deploy/compose surface where `SELF_HOST_SECRET`
  should be documented (Open Questions).
- `apps/backend/src/tokens/secret.ts` — the fast-SHA-256 + timing-safe verification primitive reused
  here (security-audit F2/F7).
- `SECURITY-NO-CROSS-ACCOUNT-DATA.md` §1 — the owner-session plane whose invariants this leaves intact.
- [ADR-0014](0014-testing-strategy.md) — testing strategy; every feature lands with tests.

## Testing

Implemented (unit): `apps/backend/test/local.test.ts` asserts `localSecretMatches` accepts the exact
secret, rejects a wrong one, rejects non-strings and length-mismatches without throwing, and returns
`false` when the secret is unconfigured; and that `localOwnerProfile()` is the fixed `('local','owner')`
identity. `apps/backend/test/config.test.ts` asserts `SELF_HOST_SECRET` parsing: accepted when valid,
`min(32)` enforced, empty-string → `undefined` (off), and boot rejected when it equals `TOKEN_SECRET`.
Recommended additions (ADR-0014): a supertest **integration** test over the real router — `POST
/auth/local` returns `404` when unconfigured, `401 invalid_secret` on a wrong secret, and `204` + a
valid `ztf_session` on success; `GET /auth/methods` reports the enabled methods — plus a **Playwright**
login-surface check that the web renders the local form only when `local` is advertised.
