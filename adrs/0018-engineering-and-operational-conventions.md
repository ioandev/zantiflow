# ADR-0018 — Engineering & operational conventions (pre-empting the "how do we…" questions)

- **Status:** Accepted
- **Cross-cuts:** every ADR (the shared defaults all components follow)
- **Builds on:** [ADR-0003](0003-multi-tenant-backend-and-token-auth.md), [ADR-0004](0004-google-auth-owner-sign-in.md), [ADR-0009](0009-durable-notification-delivery.md), [ADR-0010](0010-bots-in-python-and-token-storage.md), [ADR-0014](0014-testing-strategy.md), [ADR-0015](0015-modular-code-organization.md)
- **Date:** 2026-07-10
- **Deciders:** project owner
- **Tags:** conventions, api, ops, deployment, observability, config

## Context

The feature ADRs (0001–0017) leave a set of **cross-cutting engineering/ops questions** that would
otherwise surface during execution. This ADR fixes sensible defaults for all of them so the execution
plan is gap-free. Any item here can be superseded by a dedicated ADR if it needs depth.

## Decision

### 1. HTTP API conventions
- All HTTP under **`/api/v1`** (a breaking change → `/api/v2`); JSON; ISO-8601 **UTC** timestamps in
  responses.
- **Error shape:** `{ "error": { "code": "snake_case", "message": "...", "details"?: {…} } }` with the
  right status — `400` validation, `401` unauthenticated, `403` forbidden, `404`, `409` conflict (e.g.
  the ≤10-token cap), `429` rate-limited (with `Retry-After`), `5xx` server.
- **Pagination:** any unbounded list uses cursor pagination; the current lists (machines, tokens,
  active attentions) are small and don't need it. *(No history feed — latest state only, ADR-0008.)*

### 2. Versioning & negotiation
- **Wire contract (plugin→backend):** the snapshot body's `version` (now **4**; pane output is a
  **separate on-demand channel**, ADR-0016); the backend accepts a
  **supported range**, **ignores unknown fields** (forward-compat), and rejects an unknown-newer
  version with a clear `400`.
- **Bot↔backend WS:** `protocolVersion` in `hello`; reject on incompatible **major** (ADR-0010).
- **Packages/apps:** **SemVer**; publish **Verdaccio → npm** when ready (ADR-0004).

### 3. Plugin configuration
- **Precedence:** layout KDL (base) **<** CLI `--configuration` **<** live `PluginConfigurationChanged`
  (runtime).
- **Unknown keys** → warn + ignore; **invalid values** → fail-closed for privacy keys (ADR-0002),
  default otherwise.
- **Key catalog** (documented): `token`, `server_url`, `full`, `machine_name`, `session_names`,
  `tab_names`, `pane_names`, `pane_output`, `pane_output_scrub`, attention enable/params, `pairing`.
  *(The `pane_output` docs must state plainly: it only **permits** output, which is sent **solely on
  website request** — never streamed.)*

### 4. Secrets & env
- All secrets via **env**; `.env` gitignored, **`.env.example` committed**. Never log secrets or pane
  content. Backend: `DATABASE_URL`, `TOKEN_SECRET`, `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`,
  `VAPID_PUBLIC/PRIVATE_KEY`, `BOT_SERVICE_SECRET`, `SESSION_TTL_DAYS`, `COOKIE_SECURE`,
  `NOTIFICATION_RETENTION_HOURS`. Bots: `DISCORD_*`, `TELEGRAM_*`, `BACKEND_WS_URL`, `BOT_SERVICE_SECRET`.
- **Secret rotation:** the HMAC verifier accepts a **list** of `TOKEN_SECRET`s (current + previous) so
  keys rotate with **overlap** (no forced mass-logout); a rotation runbook is documented.

### 5. Database & migrations
- **Prisma Migrate** (MariaDB, ADR-0009/0010). Every schema change is a **committed migration**;
  deploys run `prisma migrate deploy`; dev uses `migrate dev`. Migrations named by domain.

### 6. Logging & observability
- **Structured JSON logs** (backend + bots), levels error/warn/info/debug, a **request id** per
  request; **no secrets/PII** (no tokens, no pane content). Health: **`/healthz`** (liveness),
  **`/readyz`** (DB reachable). Metrics + error-tracking are a future hook.

### 7. Time
- The **backend is the clock authority** — all stored times **UTC**. The plugin uses **relative
  ticks/elapsed** (no wall clock, ADR-0001). The client renders in the viewer's local timezone.

### 8. Deployment / hosting  *(concrete images + Docker Hub + example compose: [ADR-0021](0021-dockerization-and-deployment.md))*
- **docker-compose** for both self-host and hosted: `backend` + `mariadb` (+ optional `discord-bot`,
  `telegram-bot`). The **Next.js web tier proxies `/api/v1` → backend** and sits behind a TLS-terminating
  reverse proxy (matches ADR-0004's redirect-origin). The plugin ships as a `.wasm`. **CORS** is locked
  to the web origin (ingest is server-to-server, no browser CORS). Bots are **optional** (run 0/1/2).
- **Web security headers** (proxy/web tier): `Strict-Transport-Security`, `X-Content-Type-Options:
  nosniff`, `X-Frame-Options: DENY` / `frame-ancestors 'none'`, and a **strict CSP** (no inline/eval) —
  the dashboard renders **untrusted terminal output**, so CSP is defense-in-depth for XSS (ADR-0016 §D).
  **`Cache-Control: no-store`** on authenticated/sensitive responses (`/auth/me`, token lists, pane
  output). **MariaDB is not on the public network** (backend/bots only). Behind the proxy, derive client
  IP from a **trusted-proxy** config — do **not** blindly trust `X-Forwarded-For` (rate-limit spoofing).

### 9. Rate limiting
- **Token-bucket** per plane, returning `429` + `Retry-After`: ingest (per machine/token), auth/login,
  **promo redeem** (strict), read-API + **SSE connections** (per account). (Realizes ADR-0003 §3.)

### 10. Resilience & error handling
- **Plugin:** any backend/permission failure → **warn once + idle**, retry next tick (never crash the
  host).
- **Backend:** structured errors; nothing 500s without a log; **graceful shutdown** drains SSE + the
  delivery dispatcher.
- **Bots:** reconnect with backoff; idempotent deliveries via `deliveryId` (ADR-0009).

### 11. Data retention (consolidated — the single source of truth)

| Data | Retention |
| --- | --- |
| Latest snapshot (per machine) | kept while the machine exists; purged on **forget-machine** |
| **Pane output** (per pane) | **never persisted** — held **in process memory only** (ADR-0032), never the DB; ephemeral (~2 min) — dropped on re-request, pruned by the sweep past `PANE_OUTPUT_RETENTION_SEC`, and purged on disable/forget-machine |
| Attention state (current only) | **none — no history retained** |
| Notification **deliveries** (+ logical notification) | **6 h** (configurable, ADR-0009) |
| Pairing sessions / link tokens | **~10 min** TTL |
| Ingest tokens | until revoked/expired (**≤10 active**/account) |
| Promo codes / redemptions | **kept** (audit) |
| Owner session (cookie) | stateless HMAC, **30 d** (not stored) |
| Accounts | until **soft-deleted** → anonymized (ADR-0004) |

### 12. i18n / a11y / backups
- **English-only** v1 (i18n deferred). Dashboard meets a reasonable **a11y baseline** (keyboard nav,
  contrast in both themes, ARIA on interactive elements). Hosted **MariaDB backups** are an ops
  runbook item; self-host backups are the operator's responsibility.

## Consequences

- The execution plan can proceed without re-litigating cross-cutting choices; every "how do we handle
  errors / config / secrets / migrations / deploys / retention?" has a default.
- These are **defaults, not dogma** — any one can graduate to its own ADR when it needs depth.

## Open Questions / Risks

1. Metrics/error-tracking stack (Prometheus/OTel/Sentry) — deferred; the health endpoints exist now.
2. Backup cadence/retention for the hosted DB — an ops runbook detail. **(deferred: ops runbook.)**

## References

- ADR-0003 (rate-limit intent), ADR-0004 (auth/publish), ADR-0009/0010 (MariaDB, bots, versioning),
  ADR-0014 (testing), ADR-0015 (modules)
