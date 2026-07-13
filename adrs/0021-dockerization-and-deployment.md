# ADR-0021 — Dockerization, Docker Hub publishing & example compose

- **Status:** Accepted
- **Implements:** [ADR-0018](0018-engineering-and-operational-conventions.md) §8 (deployment)
- **Builds on:** [ADR-0008](0008-status-website-dashboard.md) (web), [ADR-0009](0009-durable-notification-delivery.md)/[ADR-0010](0010-bots-in-python-and-token-storage.md) (backend/bots/MariaDB), the security audit's Infrastructure findings (§I)
- **Date:** 2026-07-11
- **Deciders:** project owner
- **Tags:** docker, deployment, docker-hub, compose, self-hosting, ops
- **Testing:** CI builds each image + a `docker compose up` smoke test (stack reaches healthy, `/healthz`·`/readyz` green) — see [ADR-0014](0014-testing-strategy.md)

## Context

ADR-0018 §8 decided **docker-compose** deployment (backend + MariaDB + optional bots; the Next.js web
tier proxies `/api/v1` → backend; TLS at a reverse proxy; CORS locked). This ADR makes it concrete:
how each service is **dockerized**, how images are **published to Docker Hub**, and ships an **example
compose** (in `deploy/`). The **plugin is a `.wasm`** distributed to users' Zellij — it is **not
containerized**.

## Decision

### 1. Images

Published under the **`zantiflow/*`** Docker Hub namespace:

- **`zantiflow/backend`** (Node/TS/Express) · **`zantiflow/web`** (Next.js, `output: 'standalone'`) ·
  **`zantiflow/discord-bot`** + **`zantiflow/telegram-bot`** (Python) *(when the bots are built)*.
- **MariaDB** uses the **official `mariadb`** image (not a custom one). The **plugin** is a `.wasm`
  (no image).

**Build (each `apps/<svc>/Dockerfile`):** **multi-stage** (deps → build → slim runtime); a **non-root
user**; a **minimal, pinned** base (`node:20-bookworm-slim`, `python:3.12-slim`); **prod deps only**;
**no secrets baked in** (all config at runtime via env); a **`HEALTHCHECK`** hitting `/healthz`
(backend/web). The backend image's entrypoint runs **`prisma migrate deploy`** before starting.

### 2. Publishing

Built in **CI** (GitHub Actions), **multi-arch** (`amd64` + `arm64`), tagged **SemVer**
(`zantiflow/backend:0.1.0`) plus `:latest`. **Verdaccio-style phasing** (mirrors ADR-0004's npm plan):
build locally / a private registry **now**, publish to **public Docker Hub when ready**. **Production
compose pins exact versions** — **no `:latest` in prod** (security-audit I8).

### 3. Compose topology (`deploy/docker-compose.example.yml`)

- **`mariadb`** — official image, **pinned**, **no published port** (reachable only on the compose
  network — *not* on the public internet, audit I3), named volume, healthcheck.
- **`backend`** — `depends_on: mariadb (healthy)`; env from `.env`; **no published port** (reached only
  via `web`); healthcheck `/healthz`; runs migrations on start; has egress (Google/token endpoint,
  web-push).
- **`web`** — the Next.js app; **proxies `/api/v1` → `backend`** (per ADR-0018 §8); `depends_on:
  backend (healthy)`; no published port.
- **`caddy`** (reverse proxy) — the **only** service publishing `80/443`; **terminates TLS**
  (auto-Let's-Encrypt) and sets the **security headers + CSP** (ADR-0018 §8 / audit #5) via
  `deploy/Caddyfile.example`. Traefik/nginx are drop-in alternatives.
- **bots** — **optional** (commented out); enable for pro Discord/Telegram delivery.
- **Resource limits** per service (`mem_limit`) — DoS-via-exhaustion guard (audit I9).

### 4. Secrets & config

All via **`.env`** (gitignored) — see `deploy/.env.example` (committed, placeholders only). Never bake
secrets into images or commit real values (ADR-0018 §4, audit I2). `TOKEN_SECRET` accepts
comma-separated `old,new` for **overlap rotation** (ADR-0018 §4).

### 5. Self-host vs hosted

The **same images/compose serve both**. A self-hoster copies `deploy/`, fills `.env` (their own Google
app, secrets, domain), points DNS at the host, and runs `docker compose up -d`. Bots are optional
(run 0/1/2). MariaDB backups are the operator's responsibility (hosted: an ops runbook, ADR-0018 §12).

## Consequences

**Positive**
- One-command self-host; the same artifacts for the hosted instance; minimal, non-root, pinned,
  resource-bounded images realize the security-audit infra items (I1/I2/I3/I8/I9).
- Docker Hub distribution is a familiar install path for the OSS audience.

**Negative / costs**
- Image build + multi-arch CI to maintain; a Docker Hub org to own; image-vulnerability scanning to run.
- `DB_PASSWORD` must be kept in sync between the `mariadb` env and `DATABASE_URL` (documented).

**Neutral**
- Implements ADR-0018 §8; the plugin remains a `.wasm` (out of the container story); example files live
  in `deploy/`.

## Open Questions / Risks

1. **Reverse proxy choice** — Caddy in the example (auto-TLS + easy headers); Traefik/nginx are fine.
   **(decided: Caddy in the example.)**
2. **Image scanning** (Trivy/Scout) in CI + base-image update cadence — an ops detail (ADR-0018 metrics OQ).
3. **Compose vs Kubernetes** at scale — compose is the v1 target (single-backend, no Redis); revisit only if needed.

## References

- ADR-0018 §8 (deployment conventions), ADR-0008 (web proxy), ADR-0009/0010 (MariaDB, bots), the
  security audit §I
- `deploy/docker-compose.example.yml`, `deploy/.env.example`, `deploy/Caddyfile.example`
