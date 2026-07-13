# ADR-0045 — Optional self-host owner sign-in with a config secret (Google made optional)

- **Status:** Accepted
- **Amends:** [ADR-0004](0004-google-auth-owner-sign-in.md) — resolves its **OQ4** for the case where a
  self-hoster does **not** want to register a Google OAuth app. Google stays the default; this adds an
  alternative owner-auth method. The two auth planes of [ADR-0003](0003-multi-tenant-backend-and-token-auth.md)
  (write-only ingest token vs. owner session) are unchanged and still never conflated.
- **Relates to:** [ADR-0035](0035-self-host-owner-sign-in-secret.md) — a terse, auto-generated
  *retroactive* record of the same backend decision. This ADR is the full author-written record and
  additionally covers the **web `/login` surface** (methods-driven, one-click Google preserved). The
  two document one decision; ADR-0035 may be folded into this one.
- **Date:** 2026-07-12
- **Deciders:** project owner
- **Tags:** auth, self-hosting, backend, website, security
- **Testing:** unit (config fail-fast, `localSecretMatches`) + integration (login → `ztf_session` →
  `/auth/me`, wrong/missing secret, no-duplicate upsert, `logout-all`, `/auth/methods`, route-absent,
  rate limit — against real MariaDB) + web unit (`getAuthMethods`/`loginWithSecret`) + Playwright
  (`/login`: Google-only auto-forward, secret form success/error, both, signed-in bounce). See
  [ADR-0014](0014-testing-strategy.md).

## Context

[ADR-0004](0004-google-auth-owner-sign-in.md) made **Google Sign-In** the only way to authenticate as
an account **owner** (view the dashboard, manage ingest tokens). Google is already *optional at the
plumbing level* — the backend boots with zero auth providers when `GOOGLE_*` is unset — but then a
self-hoster has **no owner sign-in path at all**: the plugin can push snapshots, yet nobody can sign
in to view them. Registering a Google OAuth app (consent screen, redirect URIs) is friction a
single-owner self-host shouldn't have to take on.

This ADR lets a **self-hoster** set one long secret in config and sign in with it as the single owner
of their instance. The **public/hosted deployment** (the project owner's) sets no secret and stays
Google-only — **automatically, from the same Docker image** (ADR-0021 §5).

## Decision Drivers

- **Remove Google as a hard requirement for self-hosting** without weakening the hosted deployment.
- **Reuse the owner-session plane** (ADR-0004) untouched — a new method should only need to reach
  `setSessionCookie`; `/auth/me`, `logout`, `logout-all`/`sessionEpoch`, and per-`accountId` scoping
  must keep working with no changes.
- **Same image serves both** — the login UI must adapt to the deployment's config without a separate
  web build or a `NEXT_PUBLIC_*` flag.
- **Fit the existing "optional env → feature on" idiom** (Google, VAPID, bots).

## Decision

### 1. Config — `SELF_HOST_SECRET`

A new **optional** env var, added to the single Zod-validated config (`apps/backend/src/config`):

- Empty string is treated as **unset** (a blank `.env` line must not brick boot).
- When present it must be **≥32 chars** (same bar as `TOKEN_SECRET`); fail-fast otherwise.
- It **must differ from `TOKEN_SECRET`** (a boot-time `superRefine`). `TOKEN_SECRET` is the HMAC key
  that signs `ztf_session`; reusing it would let a leak of the *login* secret forge session cookies
  directly. This is the single most important guard.

### 2. Backend — `POST /auth/local` + `GET /auth/methods`

- **`GET /api/v1/auth/methods`** (always mounted, unauthenticated) → `{ google, local }`, reflecting
  which owner-auth methods this deployment offers (`google` derived from the actually-mounted
  providers; `local` = secret configured). No secret material is disclosed.
- **`POST /api/v1/auth/local`** (mounted **only** when the secret is configured; otherwise a normal
  404 with no oracle beyond `/auth/methods`). Body `{ secret }`. On a **timing-safe** match it resolves
  the single owner account and sets the same `ztf_session` cookie as Google, returning **204** (the
  client owns the post-login redirect). A wrong secret returns a **distinct `401 invalid_secret`** (not
  the generic `unauthorized`, so the web tells "wrong secret" apart from "session expired").

### 3. Single owner, verified against config (no DB column, no KDF, no migration)

The owner is a normal `Account` under a **reserved provider identity** `(oauthProvider:'local',
oauthId:'owner')`, created via the existing `upsertAccount` path (one account-creation path). The
secret is **verified against config and never stored** — reusing the audited fast-SHA-256 +
`timingSafeEqual` primitives from `tokens/secret.ts`. Because there is **no at-rest artifact**, a slow
KDF (bcrypt/argon2) would protect nothing here; the only attack surface is online guessing, defended
by the min length + rate limit.

### 4. Rate limiting

`POST /auth/local` gets its **own, stricter** token bucket (capacity 5, ~1/min) under a distinct key
prefix (`auth_local`) — never sharing the OAuth-start bucket. Returns `429 + Retry-After` when empty.

### 5. Web — the `/login` page (same image, config-driven)

All "Sign in" entry points route to a single **`/login`** page that reads `/auth/methods` and renders:

- **Google only** → forward straight to Google (hosted sign-in stays effectively one-click).
- **Secret set** → a secret form; on success navigate to the target.
- **Both** → both surfaces (see "pick one" below).
- **Neither** → "no sign-in method is configured on this deployment."

The marketing/anon-gate links change from "Sign in with Google" to a generic "Sign in"; the branded
Google label survives only on the `/login` page's Google button.

### 6. Google + secret may coexist

If a self-hoster sets both, both surfaces show and the backend boots fine. **Caveat (documented):**
signing in via Google vs. the secret yields **two independent owner accounts** (identity has no
cross-provider linking, ADR-0004), so self-host docs say **pick one method**. The hosted deployment
simply never sets the secret and stays Google-only.

## Consequences

**Positive**

- Self-hosting no longer requires a Google OAuth app; the whole owner-session plane is reused as-is.
- The same image/compose serves hosted (Google-only) and self-host (secret) with no separate build —
  the `/auth/methods` endpoint is the single source of truth for the UI.
- No schema change, no migration, no new crypto dependency; the secret lives only in env, like every
  other deployment secret.

**Negative / costs**

- A shared single secret is coarser than per-user OAuth (fine for a single-owner self-host, by design).
- Setting both Google and the secret can create two owner accounts — a documented footgun, not a bug.
- The login secret is a bearer-grade credential in env: it demands HTTPS (it's sent in a body) and env
  hygiene; a leak is as bad as a leaked session (but cannot forge cookies, thanks to the
  `!= TOKEN_SECRET` guard).

**Neutral**

- First backend config that meaningfully differs between hosted and self-host deployments, though the
  distinction is expressed purely as "is the secret set?", not a deployment-mode flag.

## Security posture (summary)

- `SELF_HOST_SECRET != TOKEN_SECRET` enforced at boot; `≥32` chars; generate with `openssl rand -base64 48`.
- Timing-safe compare over fixed-length SHA-256 hex (no length leak); secret never persisted → no
  offline-crackable artifact.
- Dedicated stricter rate limit (`auth_local`). `req.ip` trust follows `TRUST_PROXY` (ADR-0018 §8);
  behind the reference `caddy → web → backend` this may act as a global throttle on secret-guessing,
  which is acceptable for a single-owner endpoint.
- Cookie flags unchanged (`HttpOnly; SameSite=Lax; Secure` in prod). CSRF is not applicable (an
  attacker can't know the secret; credentialed CORS is locked to `WEB_ORIGIN`).
- Wire contract **unchanged (v4)** — this is an owner-plane addition only; ingest is untouched.

## References

- [ADR-0004](0004-google-auth-owner-sign-in.md) — Google owner sign-in (OQ4 resolved here)
- [ADR-0003](0003-multi-tenant-backend-and-token-auth.md) — the two auth planes
- [ADR-0021](0021-dockerization-and-deployment.md) — same image serves hosted + self-host
- [ADR-0018](0018-engineering-and-operational-conventions.md) — env/secrets, rate-limit shape, trust proxy
- Code: `apps/backend/src/auth/{local,router,session}.ts`, `apps/backend/src/config/index.ts`,
  `apps/web/app/login/page.tsx`, `apps/web/lib/api.ts`
