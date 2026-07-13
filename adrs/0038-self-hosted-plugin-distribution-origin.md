# ADR-0038 — Self-hosted plugin distribution origin (`plugin-dist`): a stable-URL mirror of the latest `zantiflow.wasm` release

- **Status:** Accepted (implemented)
- **Date:** 2026-07-12
- **Deciders:** project owner
- **Tags:** plugin, distribution, mirror, wasm, docker, self-hosting, ops, security, integrity
- **Testing:** unit (`semver`, release-selection incl. the no-regression ratchet, refresh incl. checksum mismatch/absent) + supertest HTTP integration — externals mocked via an injected `GithubClient`; see [ADR-0014](0014-testing-strategy.md)

> **Retroactive ADR:** This decision was already implemented in the codebase before this ADR was written; it is recorded here after the fact to close a documentation gap — it was not written at the right time.

## Context

[ADR-0022](0022-plugin-publishing-and-user-docs.md) decided how the plugin is published: the compiled
**`zantiflow.wasm`** is attached to **versioned GitHub Releases** (CI-built on tag — see
`.github/workflows/plugin-release.yml`, which uploads `zantiflow.wasm` + `zantiflow.wasm.sha256`), and
users load it either by a **versioned direct release URL** or a local **`file:`** path. It explicitly
does **not** put the plugin on Docker Hub or npm, and [ADR-0021](0021-dockerization-and-deployment.md)
states "the plugin is a `.wasm` … **not containerized**".

That leaves two operational gaps ADR-0022's model does not cover:

1. **No stable "always current" URL.** A direct release URL is pinned to one version
   (`…/releases/download/v1.2.3/zantiflow.wasm`); to always run the latest a user must either track
   releases manually or use GitHub's `…/releases/latest/download/…`, whose "latest" is the
   **most-recently-published** release — which can **regress** (a patch cut on an older line, e.g.
   `v1.1.5` published after `v1.2.0`, becomes "latest").
2. **No own-domain origin.** Loading straight from GitHub couples availability, rate limits, TLS, and
   the served URL to `github.com` — a self-hoster (ADR-0021 §5) cannot put the plugin behind their own
   host/TLS/CDN alongside the rest of their stack.

A component now exists in the repo that closes both, and it is documented **nowhere** — not in
CLAUDE.md, not in ADR-0021's image list, not in ADR-0022, not in the ADR index, and not in
`deploy/docker-compose.example.yml`: **`apps/plugin-dist`** (`@zantiflow/plugin-dist`), a tiny Express 5
origin that mirrors the latest published `zantiflow.wasm` Release and serves it at a stable path. This
ADR records the decision behind it.

## Decision Drivers

- **Regression-free "latest".** Following `github/releases/latest` is unsafe (most-recent ≠ highest
  version); the served URL must never move *backwards*.
- **Own-domain, own-TLS distribution** so a self-hoster (and the hosted instance) can front the plugin
  with their own reverse proxy / CDN, on their own domain, decoupled from GitHub availability.
- **Integrity is a security requirement** (ADR-0022: a URL-loaded Zellij plugin runs untrusted WASM in
  the user's terminal) — mirrored bytes must be checksum-verified before they are served.
- **Fits the existing conventions** — ADR-0021 Docker packaging, ADR-0018 ops (`/healthz`·`/readyz`,
  structured logging, error envelope, config), ADR-0015 modular layout, ADR-0032-style in-process state.
- **Zero own secrets / minimal blast radius** — a read-only mirror of public artifacts.

## Considered Options

- **A. GitHub Releases direct URL / `file:` only (ADR-0022 status quo).** Simple, no service to run.
  But no stable "always current" URL and no own-domain origin — the two gaps above. *(Kept as the
  source of truth, but insufficient alone.)*
- **B. A dumb reverse-proxy/CDN in front of `…/releases/latest/download/zantiflow.wasm`.** Minimal
  code, but inherits GitHub's **most-recently-published** semantics (regression risk), passes GitHub's
  redirect + rate limits through per request, and has **no integrity gate**. Rejected.
- **C. Bake the `.wasm` into an image or commit it to the repo.** Couples the plugin's release cadence
  to a service image/commit, goes stale between releases, and re-containerizes the artifact ADR-0021
  deliberately left out of images. Rejected.
- **D. ✅ A tiny origin service (`plugin-dist`) that mirrors the *highest-SemVer* release into memory,
  verifies its checksum, and serves it at a stable path with a no-regression ratchet.** Chosen — it
  closes both gaps and honours the integrity requirement while keeping GitHub Releases the source of
  truth.

## Decision

Ship **`apps/plugin-dist`** (`@zantiflow/plugin-dist`, MIT — `apps/plugin-dist/package.json`): an
Express 5 + `helmet` + `zod` origin that **mirrors the latest published `zantiflow.wasm` GitHub Release
and serves it at `/zantiflow.wasm`**, intended to sit behind a reverse proxy so
`https://your-host/zantiflow.wasm` always resolves to the current build (`apps/plugin-dist/README.md`).

### 1. Highest-SemVer selection, not most-recent, with a no-regression ratchet

- On startup and every `POLL_INTERVAL_MS` (default `300000`, min `15000`), it lists the repo's Releases
  (`GET /repos/{repo}/releases?per_page=100`) and picks the **highest-SemVer** eligible (non-draft,
  non-prerelease unless `ALLOW_PRERELEASE`) release — `pickLatestRelease` in
  `apps/plugin-dist/src/github/releases.ts`, ordered by a dependency-free `compareSemVer`
  (`apps/plugin-dist/src/semver.ts`). A patch on an older line (`v1.1.5` published after `v1.2.0`) has a
  newer date but a lower version, so it never wins.
- A strict **ratchet** in `refreshWasm` (`apps/plugin-dist/src/wasm/service.ts`) additionally refuses to
  move to a version `<=` the one already served (`skip_regression` log), so a transient/partial release
  list — or a yanked top release — can never make the origin go backwards; a yanked top release keeps
  serving **from memory until the process restarts**.

### 2. In-memory-only mirror, checksum-verified before serving

- The winning release's `zantiflow.wasm` is downloaded over its **public `browser_download_url` with no
  `Authorization` header** — exactly how Zellij fetches it, which also sidesteps GitHub's
  cross-origin redirect-auth pitfall (`apps/plugin-dist/src/github/client.ts`). The optional
  `GITHUB_TOKEN` is sent **only** on the JSON list call, purely to raise the rate limit (60→5000/hr).
- The bytes are held **in memory only, never on disk/DB** — a single in-process `WasmStore` slot swapped
  atomically (`apps/plugin-dist/src/wasm/store.ts`), explicitly modelled on the backend's in-process
  `PaneOutputStore` ([ADR-0032](0032-pane-output-never-persisted.md)).
- **Integrity (reinforces ADR-0022):** if the release publishes a checksum (`<asset>.sha256`, or a
  `SHA256SUMS`/`checksums.txt` sums file — `findChecksum`/`parseChecksumText`), the mirrored bytes are
  verified before serving; a **mismatch is refused** and the last known-good artifact stays live
  (`verifyChecksum` → `mismatch` in `service.ts`). A missing/unparseable/unreachable checksum degrades
  to **`unverified`** — served, but flagged `verified: false` on `GET /version` (availability-vs-integrity
  policy: fail **closed** on a genuine disagreement, degrade **open** when no digest exists).

### 3. Serving surface

`wasmRouter` (`apps/plugin-dist/src/wasm/router.ts`) reads the store on every request (so a background
swap is picked up with no restart):

| Route | Behavior |
| --- | --- |
| `GET \| HEAD /zantiflow.wasm` | the binary — strong `ETag` (`"<sha256>"`), `Content-Type: application/wasm`, `Cache-Control: public, max-age=CACHE_MAX_AGE_SECONDS` (default 300), `X-Zantiflow-Plugin-Version`, `X-Content-Type-Options: nosniff`, `Last-Modified`, `Content-Disposition`; `If-None-Match` → **304**; **503 + `Retry-After: 10`** until the first release is mirrored |
| `GET /zantiflow.wasm.sha256` | the SHA-256 of exactly what's being served |
| `GET /version` | `{ version, sha256, size, verified, fetchedAt }` |
| `GET /healthz` · `GET /readyz` | ADR-0018 liveness / readiness — `/readyz` 503s until an artifact is loaded (`apps/plugin-dist/src/health/index.ts`) |

The asset path is configurable via `WASM_ASSET_NAME` (default `zantiflow.wasm`). `helmet` runs with
`contentSecurityPolicy: false` and `crossOriginResourcePolicy: cross-origin` because the payload is a
public, cross-origin-fetchable binary Zellij pulls directly (`apps/plugin-dist/src/http/app.ts`) — this
is what makes the stable URL usable as a direct-URL load target in ADR-0022's model.

### 4. Ops & packaging (per ADR-0021 / ADR-0018)

- A **multi-stage, non-root** `Dockerfile` (`apps/plugin-dist/Dockerfile`, `node:22-slim`, `pnpm deploy`
  prod slice, `USER app`, `EXPOSE 4500`, `HEALTHCHECK` → `/healthz`, `ARG APP_VERSION`/`GIT_SHA` for
  build identity) — the image `zantiflow/plugin-dist`, built to ADR-0021's conventions.
- Config is parsed + validated once, fail-fast, via `zod` (`apps/plugin-dist/src/config/index.ts`);
  **no secrets of its own** (only the optional rate-limit `GITHUB_TOKEN`).
- Structured JSON logging with built-in secret redaction, mirroring `apps/backend/src/log`
  ([ADR-0018](0018-engineering-and-operational-conventions.md) §6), and the standard
  `{ error: { code, message } }` envelope (`apps/plugin-dist/src/http/errors.ts`); clean
  `SIGTERM`/`SIGINT` shutdown (`apps/plugin-dist/src/index.ts`).
- **Relation to ADR-0022 (amends):** adds a **third loading model** on top of ADR-0022's versioned
  release URL and local `file:` — a **stable, self-hosted mirror URL** that always tracks the latest
  build. It does **not** replace GitHub Releases: that stays the source of truth and the CI publish
  target; `plugin-dist` mirrors *from* it and re-verifies its checksum.
- **Relation to ADR-0021 (amends):** adds a new image to the `zantiflow/*` family
  (`zantiflow/plugin-dist`). This does not contradict ADR-0021's "the plugin is not containerized" — the
  `.wasm` still isn't baked into an image; what's containerized is a *service that mirrors and serves*
  it. But ADR-0021's image list and `deploy/docker-compose.example.yml` do not yet mention it.

## Consequences

**Positive**
- A stable, own-domain URL (`https://your-host/zantiflow.wasm`) that is **always the current build and
  never regresses**, usable directly as ADR-0022's direct-URL load target and frontable by the operator's
  own TLS/CDN.
- Integrity is enforced at the mirror too (checksum-verified, mismatch refused), reinforcing ADR-0022's
  load-untrusted-WASM safeguard; strong `ETag`/`304` and `Cache-Control` make repeated fetches cheap.
- Small, dependency-light, no own secrets, in-memory only — minimal attack surface and ops burden; fits
  the existing Docker/ops conventions.

**Negative / costs**
- One more service (and image) to build, run, and keep pinned; each replica polls GitHub and holds its
  own in-memory copy (no shared cache) — acceptable for a read-only mirror, but not horizontally shared.
- A yanked top release keeps serving from memory until restart (a deliberate availability choice, but a
  surprise if you expect an immediate takedown).
- The served URL follows *latest*: pinning a specific version still requires the GitHub Releases URL (or
  a second, version-scoped deployment) — the ADR-0022 "pin an exact version" guidance still applies for
  users who want it.

**Neutral**
- GitHub Releases remains the single source of truth; `plugin-dist` is a cache/mirror in front of it.
- The README documents an **nginx** `proxy_pass` front, whereas ADR-0021 standardizes the stack on
  **Caddy** — the reverse proxy is the operator's choice, but the examples diverge (see Open Questions).

## Open Questions / Risks

1. **Default `GITHUB_REPO` is the pre-publish owner** — `ioandev/zantiflow`
   (`apps/plugin-dist/src/config/index.ts`, `.env.example`). Per the account migration this must flip to
   the publish account before release (aligns with the plugin-release workflow's repo).
2. **Not in the deploy example.** `deploy/docker-compose.example.yml` (ADR-0021) has no `plugin-dist`
   service and its reverse proxy is Caddy, not the nginx the README shows — decide whether to add it as
   an optional service and route `/zantiflow.wasm` there, and reconcile the proxy example.
3. **Not in ADR-0021's image list / CI publish matrix** — `zantiflow/plugin-dist` should be added to the
   Docker Hub build+publish set (multi-arch, SemVer, no `:latest` in prod) if it is to ship as an image.
4. **Single-backend in-memory model.** Like ADR-0032, this assumes one process per replica; multiple
   replicas mirror independently (each its own poll + copy). Fine for a stateless mirror; note it if a
   shared/edge cache is ever wanted.
5. **Checksum trust.** Verification is only as strong as the published `.sha256`/sums file on the same
   Release; the deferred **release signing** from ADR-0022 §OQ1 would harden this end-to-end.

## References

- ADR-0022 (plugin publishing via GitHub Releases + direct-URL/`file:` load; SHA-256 integrity) —
  **this amends it** (adds the stable-mirror URL model)
- ADR-0021 (Docker packaging conventions, `zantiflow/*` images, self-host compose) — **this amends it**
  (adds the `zantiflow/plugin-dist` image)
- ADR-0018 (`/healthz`·`/readyz`, structured logging + redaction, error envelope, config), ADR-0015
  (modular layout; the hand-rolled `semver` avoids the `semver` npm dep), ADR-0032 (in-process store
  precedent), ADR-0014 (test layers)
- Code: `apps/plugin-dist/README.md`, `apps/plugin-dist/Dockerfile`, `src/index.ts`,
  `src/config/index.ts`, `src/github/client.ts`, `src/github/releases.ts`, `src/semver.ts`,
  `src/wasm/service.ts`, `src/wasm/store.ts`, `src/wasm/router.ts`, `src/health/index.ts`,
  `src/log/index.ts`, `src/http/{app,errors,async}.ts`; tests `test/{app,releases,semver,service}.test.ts`
- `.github/workflows/plugin-release.yml` (the upstream Release this mirror follows)

## Testing

Per ADR-0014, the component lands with tests across two layers, externals mocked via an injected
`GithubClient` fake (no network):

- **Unit** — `test/semver.test.ts` (parse/compare, prerelease precedence), `test/releases.test.ts`
  (highest-SemVer-not-most-recent selection, draft/prerelease filtering, checksum-file discovery +
  parsing), `test/service.test.ts` (`refreshWasm`: mirror + verify, **no-regression ratchet**,
  no-op-on-unchanged, upgrade-on-higher, **refuse-on-checksum-mismatch**, `verified:false`-on-absent,
  keep-last-on-missing-asset).
- **Integration (supertest)** — `test/app.test.ts` (503 + `Retry-After` before ready, byte-exact serve
  with headers, `If-None-Match`→304, `HEAD`, `/zantiflow.wasm.sha256`, `/version`, `/readyz`, 404
  envelope).
