# ADR-0048 — Docs site ships as the `zantiflow/docs` container, served at `docs.<domain>`

- **Status:** Accepted
- **Amends:** [ADR-0023](0023-documentation-site-starlight.md) §4 — selects the "`zantiflow/docs` image" hosting option it left open, over the "default: GitHub Pages" wording
- **Builds on:** [ADR-0021](0021-dockerization-and-deployment.md) (dockerization/deploy pipeline), [ADR-0018](0018-engineering-and-ops-conventions.md) §8 (docker-compose + Caddy)
- **Date:** 2026-07-14
- **Deciders:** project owner
- **Tags:** docs, deploy, docker, caddy
- **Testing:** CI builds the `docs` image (no-push, amd64) on PRs and multi-arch on publish — same gate as every other service image (ADR-0014/0021)

## Context

ADR-0023 built the docs as a **Starlight (Astro) static site** and named **GitHub Pages** as the
default host, while explicitly leaving the door open: *"the hosted instance may also serve it at
`docs.<domain>` (static behind Caddy, or a `zantiflow/docs` image per ADR-0021)."* The hosted instance
already runs a docker-compose + Caddy stack (backend, web, bots, MariaDB) on one server. Rather than
stand up a **second, different** delivery path (a GitHub Pages workflow, its own DNS/TLS, its own drift
risk) we want docs delivered **the same way as every other service** and reachable on the same server.

There was also a concrete gap: **no docs deploy workflow existed at all** — `astro build` ran only
locally, so docs published nowhere.

## Decision

**The docs site is a container** (`zantiflow/docs`), built + published by the **existing pipeline** and
served at **`docs.zantiflow.com`** by the same Caddy that fronts the app. It is **not** deployed to
GitHub Pages.

### 1. Image (`docs/Dockerfile`)

Two-stage build, context = repo root (like `apps/web`):

1. `node:22-slim` → `corepack enable` → `pnpm install --frozen-lockfile` → `pnpm --filter @zantiflow/docs build` → `docs/dist`.
2. **`nginxinc/nginx-unprivileged:1.27-alpine`** runtime — **non-root** (uid 101), listens on **8080**
   (ADR-0021's non-root / no-privileged-port posture; pinned, multi-arch amd64+arm64). Serves
   `docs/dist` with a small `docs/nginx.conf` (directory-style pages, `error_page 404 /404.html`,
   immutable long-cache on `/_astro/`). Ships `LICENSE`/`NOTICE` for compliance (ADR-0036).

`docs` is a **top-level `docs/` folder, not under `apps/`**, so the pipeline's Dockerfile path is
service-aware: `${{ matrix.service == 'docs' && 'docs/Dockerfile' || format('apps/{0}/Dockerfile', matrix.service) }}`.

### 2. Pipeline

`docs` is added to the `service` matrix of **both** `docker-publish.yml` jobs (`build` per-platform by
digest → `merge` multi-arch manifest + tags) and to `ci.yml`'s no-push `image-build` validation. It
therefore inherits the **whole ADR-0021 tagging scheme** unchanged — `:X.Y.Z` / `:X.Y` / `:latest` on a
stable Release, `:edge` + `:sha-<short>` on a main push, `:next` on a pre-release — and the same
tests-gated, all-or-nothing publish. No new workflow.

### 3. Serving

- `deploy/docker-compose.example.yml`: a `docs` service (`zantiflow/docs`, **no published port**,
  128 MB, wget healthcheck); Caddy `depends_on` it.
- `deploy/Caddyfile.example`: a `docs.<domain>` site block → `reverse_proxy docs:8080`, with TLS +
  security headers. Its **CSP is docs-appropriate** (`script-src`/`style-src` allow `'self'
  'unsafe-inline'` for Starlight's inline theme script/styles + Pagefind) — deliberately *looser* than
  the dashboard's strict CSP, which is justified because **docs render only trusted, first-party
  authored content**, never untrusted terminal output (contrast ADR-0016 §D).

Ingest/read wire contracts are untouched — docs is a static site with no API.

## Consequences

**Positive** — one delivery mechanism for every service (build/publish/deploy/observe identically); docs
live on the same server + TLS as the app; the "docs publishes nowhere" gap is closed; self-hosters get
docs for free by running the compose stack.

**Negative / costs** — one more image to build in CI (adds an amd64 leg to PRs, a full matrix row to
publish); a running container + its RAM instead of free static Pages hosting; the docs image must exist
before the compose `docs` service can start.

**Neutral** — GitHub Pages remains a *possible* alternative for a pure-docs fork, but is no longer the
project's path; ADR-0023 §4's open "Hosting" question is now **resolved** (containerized).

## Open Questions / Risks

1. **`nginxinc/nginx-unprivileged` as a new base image** — well-known, non-root, multi-arch; pinned to a
   minor (`1.27-alpine`). Low risk.
2. **CSP `'unsafe-inline'`** — acceptable because docs content is first-party/authored; if Starlight
   later exposes nonces/hashes we can tighten. Not a regression (docs had no CSP before).

## References

- ADR-0023 (docs site — this selects its §4 container option), ADR-0021 (dockerization/pipeline),
  ADR-0018 §8 (compose + Caddy), ADR-0016 §D (why the dashboard CSP is stricter), ADR-0036 (license
  compliance), ADR-0014 (testing/CI gate)
