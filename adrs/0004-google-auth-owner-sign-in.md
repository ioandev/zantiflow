# ADR-0004 — Google authentication for account owners (via the `@zantiflow/oauth` package family)

- **Status:** Accepted
- **Amends:** [ADR-0003](0003-multi-tenant-backend-and-token-auth.md) — supplies owner authentication; closes its bootstrap gap
- **Amended by:** [ADR-0035](0035-self-host-owner-sign-in-secret.md) — adds an optional self-host-only owner sign-in via a configured secret (Google is no longer the only owner-auth path)
- **Date:** 2026-07-10
- **Deciders:** project owner
- **Tags:** auth, google, oauth, backend, website, packages, open-source
- **Testing:** unit (HMAC session, upsert) + integration (mocked-Google login, JWKS verify) + Playwright (login/logout) — see [ADR-0014](0014-testing-strategy.md)

## Context

[ADR-0003](0003-multi-tenant-backend-and-token-auth.md) established accounts, machines, and write-only
ingest tokens, and defined a token-management API surface (`POST/GET/DELETE /api/v1/tokens`) — but
deferred **how an account owner authenticates** to that API (its "bootstrap gap"). This ADR fills it
with **Google Sign-In**, and defines the resulting **backend** and **website** changes.

Google auth already exists, proven, in the sibling repo `/repos/packages` as a framework-agnostic
package family that powers `commenttoday`'s Google (+Apple) login:

- **`@commenttoday/oauth`** — provider core (Google/Apple): auth-code exchange → normalized
  `{ sub, email, name, picture }`.
- **`@commenttoday/oauth-express`** — `createOAuthRouter()`; mounts login/callback routes and delegates
  CSRF-state, session, and persistence to host-supplied hooks.
- **`@commenttoday/oauth-react`** — `useOAuthPopup()`; popup + origin-checked `postMessage` handshake.

Those are MIT-licensed, near-zero-dependency, and clean, but `@commenttoday`-scoped and published only
to a private Verdaccio. zantiflow will be **open-sourced**, so this ADR **copies them into the
zantiflow monorepo, rescoped to `@zantiflow/*`, for public-npm release**.

## Scope

- **This ADR (0004):** owner authentication (Google) — the OSS packages, the backend auth wiring +
  Account identity, and the website's login/logout/session surface.
- **Not here:** the full status website/read-API (**ADR-0008**); this ADR only adds the login surface
  the website needs.

## Decision Drivers

- **Reuse proven code**, don't reinvent OAuth. The in-house packages already fit and are tiny.
- **Two distinct auth planes** must stay separate: ADR-0003's **write-only ingest token** (plugin) vs
  this ADR's **owner session** (website/management). Different credentials, never conflated.
- **Open-source + npm**: the auth packages become a reusable, publishable byproduct.
- **Least surprise**: mirror commenttoday's battle-tested backend pattern (HMAC signed-cookie session,
  `(provider, sub)` identity).
- First-party dashboard ⇒ simple **redirect + cookie** login.

## Considered Options

**Reuse strategy**
1. **Copy the packages into zantiflow, rescoped `@zantiflow/*`, OSS on public npm** *(chosen)* — the
   originals are private/Verdaccio and wrong-branded; zantiflow owns its OSS release.
2. Depend on the private `@commenttoday/*` packages — rejected (private registry, foreign brand).
3. Adopt NextAuth/Passport/etc. — rejected: heavier and redundant given the existing near-zero-dep fit.

**Auth provider**
1. **Google** *(chosen, per project owner)* — wired now. The core is provider-agnostic, so **Apple**
   (already in the package) and others can be added later without touching the adapter.

**Session mechanism**
1. **Hand-rolled HMAC signed-cookie session** *(chosen)* — mirrors commenttoday: stateless
   `base64url(payload).hmac`, `typ`-domain-separated, no DB session table, no JWT library.
2. JWT library / server session store — rejected as unnecessary weight for the same result.

**Website login UX**
1. **Redirect + cookie** *(chosen)* — natural for a first-party dashboard.
2. Popup (`oauth-react`) — available (and published), but the popup lane exists for cross-origin
   embeds (commenttoday's iframe); unused by a first-party site.

## Decision

### 1. Packages (created in this repo)

`packages/oauth`, `packages/oauth-express`, `packages/oauth-react` — copied from the originals and
rescoped to **`@zantiflow/oauth`**, **`@zantiflow/oauth-express`**, **`@zantiflow/oauth-react`**
(v`0.1.0`, MIT, `publishConfig.access: public`, `repository`/`homepage`/`bugs` set, the internal dep
via `workspace:^`, and the React hook's default `postMessage` type neutralized from `ct-auth` →
`oauth`). The core stays **provider-generic** (Google + Apple); only Google is wired into the backend
now. This also initializes the monorepo's **pnpm workspace root** (`package.json` + `pnpm-workspace.yaml`),
partially realizing ADR-0001 §8 ahead of schedule.

> **Verified:** `pnpm -r build` compiles all three; `pnpm -r test` passes **51 tests** (oauth 29,
> oauth-express 12, oauth-react 10).

**Publish plan:** **local Verdaccio first** (until ready to deliver), then **public npm** under the
`@zantiflow` org, MIT, versions from `0.1.0`; `tsc` build, `prepublishOnly` cleans+builds. (See Open
Questions.)

### 2. Backend changes

- **Mount** `createOAuthRouter({ providers: [GoogleProvider], signState, verifyState, onLogin, startState, startMiddleware })`
  under `/api/v1`, giving `GET /api/v1/auth/google` (start → consent) and `GET /api/v1/auth/google/callback`.
  The `GoogleProvider` is built only when `GOOGLE_CLIENT_ID`/`SECRET` are configured.
- **State/CSRF:** `signState`/`verifyState` = HMAC over `TOKEN_SECRET`, `typ: 'state'`, ~10-min TTL
  (the app owns CSRF; the package is secret-free).
- **`onLogin`** (the upsert-and-respond hook): upsert the **Account** by `(oauthProvider, oauthId = Google sub)`,
  refreshing `name`/`email`/`avatarUrl`; then `setSession(res, accountId)` and redirect to the site.
- **Owner session:** signed cookie **`ztf_session`** — `HttpOnly; Path=/; SameSite=Lax` (+`Secure`
  when `COOKIE_SECURE`/prod), payload `{ accountId, epoch }`, `typ: 'session'`, TTL `SESSION_TTL_DAYS`
  (default **14**). Verified by middleware that re-checks the DB (account exists / not
  disabled/soft-deleted) **and that `payload.epoch === account.sessionEpoch`** — so bumping the
  account's `sessionEpoch` is **instant revocation / "log out everywhere"** (a stolen cookie is
  otherwise valid only until TTL). Sets `req.account`.
- **Gates the management API:** ADR-0003's `POST/GET/DELETE /api/v1/tokens` now require a valid owner
  session — **this closes ADR-0003's bootstrap gap.**
- **New endpoints:** `GET /api/v1/auth/me` (current account or 401), `POST /api/v1/auth/logout`
  (clears the cookie), `POST /api/v1/auth/logout-all` (**bumps `sessionEpoch`** → invalidates every session).
- **Account model gains** (extends ADR-0003's Account): `oauthProvider`, `oauthId` (unique
  `(oauthProvider, oauthId)`), `email`, `name`, `avatarUrl`, **`sessionEpoch`** (int; bump to revoke all sessions).

### 3. Website changes (login surface only)

- **Sign in with Google** → navigate to `GET /api/v1/auth/google?mode=session&redirect=<path>`. The
  backend **validates `redirect`** as a **same-site relative path** (allowlist; reject absolute/off-site
  URLs) before using it — **no open redirect**.
- Read auth state via `GET /api/v1/auth/me` (cookie sent automatically, same-origin).
- **Sign out** → `POST /api/v1/auth/logout`. The full dashboard/status UI is ADR-0008; the popup hook
  (`oauth-react`) is available but not used by the first-party site.

### 4. Configuration

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (the **web/public origin** that
  proxies `/api/v1` → backend, matching a Google-console-registered URI).
- `TOKEN_SECRET` (HMAC key for state + session tokens — **distinct** from ADR-0003's ingest tokens,
  which are random secrets hashed at rest), `SESSION_TTL_DAYS`, `COOKIE_SECURE`.
- **Google Cloud setup** (per deployer/self-hoster): OAuth consent screen **External** + publish;
  scopes `openid email profile`; **Web application** client; register JS origins + the
  `/api/v1/auth/google/callback` redirect URIs. (Mirrors commenttoday's `INSTRUCTIONS-SETUP-GOOGLE.md`.)

### 5. Two auth planes (recap, spanning ADR-0003 + 0004)

| Plane | Credential | Who | Scope |
| --- | --- | --- | --- |
| **Ingest** | `Authorization: Bearer ztf_…` (random, hashed at rest) | plugin | write snapshots only |
| **Owner** | `ztf_session` cookie (Google → HMAC-signed) | website/user | read data, manage tokens |

## Consequences

**Positive**
- Proven auth reused; **ADR-0003's bootstrap gap is closed** — tokens can now be created by an
  authenticated owner.
- Clean separation of the two auth planes.
- A reusable **OSS npm auth family** falls out as a byproduct; near-zero runtime deps; verified
  building and passing tests.
- pnpm workspace root now exists, unblocking the rest of the monorepo.

**Negative / costs**
- **Inherited security deltas** (see below) will draw scrutiny as a fresh OSS release.
- Maintaining published packages (versioning, security response) is an ongoing cost.
- A single `TOKEN_SECRET` underpins both state and session tokens — rotating it logs everyone out.
- The Account now stores **PII** (email/name/avatar) → deletion/GDPR handling is required.

**Neutral**
- Account model extended; monorepo pnpm workspace initialized ahead of ADR-0001's schedule.

### Inherited security posture (documented, accepted from commenttoday)

- ~~The Google **`id_token` is decoded, not signature-verified**~~ — **hardened (2026-07-11):**
  `@zantiflow/oauth`'s `GoogleProvider` now **verifies** the `id_token` against Google's JWKS
  (signature + `aud`==clientId + `iss` + `exp`) via `jose` before trusting any claim, so it refuses a
  forged/expired/wrong-audience/browser-transited token. The decode-only path (`decodeIdTokenPayload`)
  remains **server-side-only** and is now used only by the (unwired) Apple provider. See OQ1.
- **No PKCE** (optional, deferred). **`email_verified` is now captured** on the profile
  (`OAuthProfile.emailVerified`); storing/enforcing it in the backend Account lands in Phase 1.
- Identity = `(provider, sub)`; **no account-linking** — the same person via Google vs Apple would be
  two accounts. `email` is a cached attribute, not a join key.
- **No refresh tokens** — "refresh" = re-running OAuth against the still-valid Google session.

## Open Questions / Risks

1. **OAuth hardening** — **DONE at the package level (2026-07-11)** ✅ (was: HARD release-blocker;
   security-audit finding). `@zantiflow/oauth` `GoogleProvider.exchangeCode` now performs **JWKS
   signature verification** and validates **`aud`==clientId / `iss` / `exp`** (via **`jose` `^5`**,
   dual-CJS/ESM so the CommonJS package stays portable), **captures `email_verified`** on the profile,
   and **refuses to derive a profile from a forged/expired/wrong-aud/browser-transited id_token** —
   covered by hardening tests (forged-key, wrong-aud, wrong-iss, expired, malformed). The decode-only
   path is now server-side-only (Apple). Injectable `keyResolver`/`jwksUri` options make it testable
   without a live JWKS fetch. **Remaining:** wire `emailVerified` into the backend Account
   (Phase 1); PKCE optional/deferred; public-npm publish still gated on Verdaccio-first (OQ3).
2. **PII / account deletion** (GDPR) — **decided:** soft-delete + anonymize (`deletedAt`, reject the
   identity on the next request), mirroring commenttoday.
3. **npm publishing** — **decided:** publish to a **local Verdaccio** registry first (as the
   `@commenttoday/*` packages do), and release to **public npm** (org, CI provenance, versioning) only
   when ready to deliver.
4. **Self-hosting:** each deployer registers their **own** Google OAuth app + redirect URIs; document
   this alongside ADR-0003's `server_url` self-host story. **Decided:** yes — document self-host Google OAuth setup (own app + redirect URIs).
5. **Redirect-URI nuance:** must exactly match the console; mind the web/public proxy origin vs
   backend-direct origin. **Decided:** register the web/public proxy origin as the callback (documented).
6. **Multi-provider later** (Apple/GitHub) — **decided:** Google-only now; deferred (the packages
   already support more).

## References

- Packages: [`packages/oauth`](../packages/oauth), [`packages/oauth-express`](../packages/oauth-express), [`packages/oauth-react`](../packages/oauth-react)
- Upstream originals: `/repos/packages/{oauth,oauth-express,oauth-react}` (`@commenttoday/*`, MIT)
- commenttoday integration reference: `backend/src/routes/auth.ts`, `backend/src/auth/*`, `prisma/schema.prisma`, `INSTRUCTIONS-SETUP-GOOGLE.md`, `DECISIONS.md`
- ADR-0003 — [multi-tenant backend + token auth](0003-multi-tenant-backend-and-token-auth.md)
- Google Identity — OAuth 2.0 for Web Server Apps — https://developers.google.com/identity/protocols/oauth2/web-server
