# @zantiflow/plugin-dist

A tiny Express origin that **mirrors the latest published `zantiflow.wasm`** GitHub Release and serves
it at **`/zantiflow.wasm`**. Put nginx in front of it so `https://your-host/zantiflow.wasm` always
resolves to the current plugin build (the direct-URL load model of [ADR-0022](../../adrs/0022-plugin-publishing-and-user-docs.md)).

## What it does

- On startup, and every `POLL_INTERVAL_MS`, it lists the repo's Releases and picks the
  **highest-SemVer** full release — **not** the most recently published one. So a patch cut on an older
  line (e.g. `v1.1.5` published after `v1.2.0`) never causes a **regression**: `v1.2.0` keeps serving.
  A strict ratchet backs this up — it **never moves to a lower version** than the one it is already
  serving (a yanked top release keeps serving from memory until the process restarts).
- It downloads that release's `zantiflow.wasm` over its public download URL (exactly how Zellij fetches
  it), holds it **in memory only** (never on disk/DB), and serves it with a strong `ETag`,
  `Content-Type: application/wasm`, and conditional-GET (`304`) support.
- **Integrity (ADR-0022):** if the release publishes a checksum (`zantiflow.wasm.sha256` or a
  `SHA256SUMS`/`checksums.txt`), the bytes are verified before being served; a **mismatch is refused**
  and the last known-good artifact stays live. Absent/unparseable checksums serve but are flagged
  `verified: false` on `GET /version`.

## Routes

| Route | Purpose |
| --- | --- |
| `GET \| HEAD /zantiflow.wasm` | the plugin binary (503 until the first release is mirrored) |
| `GET /zantiflow.wasm.sha256` | the SHA-256 of exactly what's being served |
| `GET /version` | `{ version, sha256, size, verified, fetchedAt }` |
| `GET /healthz` | liveness |
| `GET /readyz` | readiness — 503 until an artifact is loaded |

## Configure

All optional; see [`src/config/index.ts`](src/config/index.ts) and [`.env.example`](.env.example).
Key ones: `PORT` (default `4500`), `GITHUB_REPO` (default `ioandev/zantiflow`),
`GITHUB_TOKEN` (optional, raises the API rate limit), `WASM_ASSET_NAME` (default `zantiflow.wasm`),
`POLL_INTERVAL_MS` (default `300000`), `CACHE_MAX_AGE_SECONDS` (default `300`),
`ALLOW_PRERELEASE` (default `false`).

## Run

```sh
pnpm --filter @zantiflow/plugin-dist dev     # tsx watch (loads .env if present)
pnpm --filter @zantiflow/plugin-dist build && pnpm --filter @zantiflow/plugin-dist start
pnpm --filter @zantiflow/plugin-dist test    # vitest
```

Docker (build context = repo root):

```sh
docker build -f apps/plugin-dist/Dockerfile -t zantiflow/plugin-dist .
docker run -p 4500:4500 -e GITHUB_REPO=ioandev/zantiflow zantiflow/plugin-dist
```

## nginx

```nginx
location = /zantiflow.wasm {
    proxy_pass http://127.0.0.1:4500;
    proxy_set_header Host $host;
}
location = /zantiflow.wasm.sha256 {
    proxy_pass http://127.0.0.1:4500;
    proxy_set_header Host $host;
}
```
