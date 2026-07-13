# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⛔ HARD RULE — NEVER restart Zellij on this machine

**Never restart, reload, kill, or stop Zellij on this machine — NEVER, at any cost.** The user is
actively using Zellij here; terminating or restarting it would destroy their live sessions and work.

- **Do NOT run** anything that stops/restarts/reloads the Zellij server or its sessions — e.g.
  `zellij kill-session`, `zellij kill-all-sessions`, `zellij delete-session`, `zellij delete-all-sessions`,
  `killall zellij`, `pkill zellij`, `kill <zellij pid>`, or any `systemctl`/service action on Zellij.
- This holds **even while testing the plugin or running the real-Zellij smoke check (ADR-0014)** — use
  only a separate, explicitly-sanctioned throwaway session/instance; never touch the running server.
- If a task appears to require restarting Zellij, **STOP and ask the user to do it themselves.** Do not
  work around this rule.

## ⛔ HARD RULE — every task is anchored to an ADR

**ADRs (`adrs/`) are the authoritative design *and* the primary work product of this repo. No task is
complete without engaging them.** This is a hard rule, not a preference — treat the ADR trail as part
of the deliverable, never as optional follow-up.

- **Read first.** Before writing code, changing behavior, or answering a design question, find and read
  the ADR(s) that govern it (index: `adrs/README.md`; summaries under "Source of truth" below). If you
  cannot identify a governing ADR, **say so before proceeding** — do not guess.
- **Decide → record.** Any new or changed decision, behavior, wire/API contract, default, convention,
  or dependency MUST land as an ADR **in the same task**. If the work introduces or alters a decision
  and you have not written or updated an ADR, the task is **unfinished**.
- **Never rewrite an Accepted ADR** to change its decision — add a **new** ADR (next `NNNN`, one
  decision per ADR) and a **forward-pointer** on the superseded one (see ADR-0001 → ADR-0002). Then
  update the **`adrs/README.md` index** and the ADR summary list in this file.
- **Exceptions must be justified, not assumed.** If you genuinely believe a task needs no ADR (a typo
  fix, a mechanical chore, a pure test run), **STOP and state why** before skipping. The default is
  that a task touches, updates, or creates an ADR — the burden is on skipping, not on writing one.

## Project

**zantiflow** is a planned polyglot monorepo: a **Zellij plugin** (Rust → WASM) that pushes a
per-second snapshot of all terminal sessions → tabs → panes to an **Express backend** (Node/TS),
which prints the tree to its console.

**Current state: mostly decisions + research, plus the first shipped code** — the OSS auth packages
under `packages/` (`@zantiflow/oauth`, `-express`, `-react`). The plugin and backend/website apps are
**not** scaffolded yet. See "Tooling" for what builds/tests today.

## Source of truth (read these before designing or coding)

- **`adrs/`** — Architecture Decision Records; the authoritative design.
  - **ADR-0001** — the core architecture *and* the monorepo tooling/layout decision.
  - **ADR-0002** — user-configurable privacy/redaction controls; evolves the wire contract to v2.
  - **ADR-0003** — multi-tenant, token-authenticated backend (accounts + machines; write-only ingest
    tokens, ≤10/account, per-token expiry or infinite); adds plugin `token` / `server_url` config.
    **Evolves the wire contract to v3 — always use v3.**
  - **ADR-0004** — Google Sign-In for account owners via the `@zantiflow/oauth*` packages; HMAC
    signed-cookie session (`ztf_session`) that gates the token-management API.
  - **ADR-0005** — *attentions*: pluggable plugin-side state detectors (claude-needs-input/thinking,
    session stopped/detached; hybrid built-in modules + config patterns). **Plugin detects; backend
    enforces** tier-aware thresholds (5 min free / 1 min pro) + trigger frequency. **Wire contract →
    v4.** Feeds notifications (ADR-0006) and the status website (ADR-0008).
  - **ADR-0006** — *notifications*: delivers ADR-0005 triggers. Free = browser **Web Push** via an
    installable **PWA** (custom pre-permission popup + button; install nudged, **required on iOS**);
    pro = **Discord + Telegram** bot DMs (account linked by a website `/link` token; bot↔backend over
    WebSocket — bots in ADR-0007). Tiered per-account prefs for when/what/where/how. No
    wire-contract change. WhatsApp was dropped in favor of Telegram.
  - **ADR-0007** — *chat-bot channels*: the Discord + Telegram bots — separate services, each holding
    an **outbound WebSocket to the backend** (no public bot ingress); account linking via a one-time,
    hashed, website-minted `/link` token; `ChannelLink`/`LinkToken` model; internal
    `@zantiflow/notify-protocol` package. Self-hosters run their own bots.
  - **ADR-0008** — *status website*: the account dashboard (Next.js PWA extending ADR-0006) showing
    machines → sessions → tabs → panes live with attention badges; the tenant-scoped **read API** + an
    **SSE** live stream; retention = latest snapshot + bounded attention history (tier-gated). Resolves
    ADR-0003's retention question.
  - **ADR-0009** — *durable notifications*: backend datastore = **MariaDB**; each notification delivery
    is a row (**one per channel**), **acked** on success, **replayed** after a bot/backend restart
    (nothing missed; idempotent via `deliveryId`), pruned by a **cron** (default 6h, configurable).
    Amends ADR-0006/0007; resolves ADR-0003's datastore question.
  - **ADR-0010** — the Discord + Telegram bots are **Python** (`discord.py` / `aiogram` +
    `websockets`), so the backend↔bot protocol is a **language-neutral versioned schema** (TS types
    backend-side, Python models bot-side), not a shared TS package. Ingest `Token` + `LinkToken` live
    in MariaDB. Amends ADR-0007. **(Repo is now polyglot: Rust plugin + TS backend/web/packages + Python bots.)**
  - **ADR-0011** — *tiers/monetization*: `tier` (free|pro) + `tierExpiresAt`, fed by **promo codes**;
    **GitHub Sponsors** donations (support only). **Paid subscriptions (Stripe/Polar) declined — ADR-0013.**
  - **ADR-0013** — *declined*: no paid PRO subscriptions (Stripe/Polar/MoR) for the foreseeable future.
  - **ADR-0014** — *testing strategy*: **ports & adapters** for mockability (plugin `HostPort` wraps
    `zellij-tile` FFI); four layers — **unit / BDD / integration / Playwright**; externals mocked,
    **MariaDB real** (testcontainers); a real-Zellij smoke check validates the verify-at-build items.
    **Every feature lands with tests** (each ADR has a Testing line).
  - **ADR-0015** — *modular code organization*: **small, single-responsibility modules in feature
    subfolders**; extract reusable code into **packages** (`@zantiflow/*` npm / Rust crates / Python
    packages) per a promotion rule (reused ≥2 apps, publishable, or stable versioned API); narrow
    interfaces + co-located tests. **No monolith files.**
  - **ADR-0016** — *dashboard + pane-output*: build the dashboard to the vendored design
    (`design/dashboard/`, **v2 canonical**); adds **pane-output "last 50 lines"** — an **opt-in
    (`pane_output`, default OFF), privacy-gated** capture sent **on-demand via a separate ~5 s poll**
    (content otherwise never leaves the machine); ingest contract **unchanged (v4)**; read API `GET …/panes/:id/output`; dark/light theme.
  - **ADR-0017** — *secret scrubbing + adaptive rendering*: the plugin **masks secrets before send**
    (on by default when `pane_output` is on; extendable patterns; best-effort, no wire-contract change).
    The dashboard **renders adaptively** to available content (output-not-shared / masked / `<hidden>` /
    stale / dead) and always discloses *why*.
  - **ADR-0018** — *engineering & ops conventions* (cross-cutting): API/error/versioning conventions,
    plugin config precedence, env/secrets, **Prisma** migrations, structured logging + `/healthz`·`/readyz`,
    **UTC** time, **docker-compose** deploy (web proxies `/api/v1`, CORS locked), rate-limit shape,
    resilience, and a **consolidated data-retention table**. Check it for any "how do we…" default.
  - **ADR-0019** — *UX deferred*: presentation beyond the vendored dashboard design is **deliberately
    deferred** (D1–D9: settings/integrations/account/pairing **page designs**, notification digest,
    dense-tree layout, onboarding copy, empty/error states, detailed a11y/i18n). Behavior is decided
    elsewhere; **build to sensible defaults** until designs land. Home for all "later UX ADR" refs.
  - **ADR-0020** — *automated promo codes* (**no admin**): a cron mints a **CSRNG** code **every 2 weeks**
    (valid 1 month, grants **1 month PRO**), shown on the **public homepage** (`GET /api/v1/promo/current`);
    logged-in redeem via `POST …/promo/redeem` (strict rate-limit), `tierExpiresAt` capped ~60 d.
    Resolves the admin/promo gap — no admin plane.
  - **ADR-0021** — *dockerization & deployment*: multi-stage **non-root** images (`zantiflow/backend`,
    `-web`, Python bots) → **Docker Hub** (SemVer/multi-arch/pinned); official **mariadb** (not
    host-exposed); **Caddy** = TLS + security headers/CSP; secrets via `.env`. Example in **`deploy/`**
    (`docker-compose.example.yml`, `.env.example`, `Caddyfile.example`). Plugin `.wasm` isn't containerized.
  - **ADR-0022** — *plugin publishing & user docs*: `zantiflow.wasm` on **GitHub Releases** (SemVer,
    **SHA-256** checksums, pinned `zellij-tile`; not Docker Hub/npm); load by direct URL or `file:`, pair
    (ADR-0012) or paste a token, configure via KDL. User guide: **`docs/plugin-getting-started.md`**.
  - **ADR-0023** — *docs site*: **Starlight (Astro)** in `docs/` (a workspace app) — plugin/backend/
    dashboard, **privacy**, **contributing**, a **"what ADRs are"** page, **donations**; local Pagefind
    search; static → GitHub Pages. ADRs stay source of truth (docs **link**, don't duplicate). Refines ADR-0022.
  - **ADR-0012** — *device pairing*: the plugin gets its ingest token by showing a code the owner
    approves on the website (RFC-8628 style), then polls + stores it in `/data` — no secret in a layout
    file. Manual token still supported. Resolves ADR-0003's plaintext-secret question.
  - **ADR-0024** — *opt-in hostname* (amends ADR-0002): the real hostname + its `RunCommands`
    permission are **OFF by default** behind a new plugin `hostname` flag; sent only when
    `hostname=on` **and** `machine=real` (`config::wants_hostname()`). `RunCommands` is requested
    **lazily** (two-phase handshake) so alias/hidden/default users are never prompted for it, and
    denying it degrades to a hidden machine name **without** disabling telemetry. Default machine
    name is now `<hidden>`.
  - **ADR-0025** — *re-adopt `claude.thinking`* (partly supersedes ADR-0005): the plugin emits a
    `claude.thinking` attention when a `claude` pane's **visible tail** (~15 lines) shows BOTH a
    `Gerund…` spinner (`Swooping…`) and a status anchor (`esc to interrupt` / `still thinking with
    <effort> effort`), so prose gerunds don't false-trigger it (not the brittle TUI parsing ADR-0005
    rejected). **The two signals are on *different lines*** — the gerund on the spinner line, `esc to
    interrupt` on the footer bar below the input box — so the detector matches them *across* the tail,
    not on one line (a same-line match missed the real layout and showed nothing). An explicit prompt
    still wins (needs-input takes precedence); scan is local-only, only the `type` leaves, **wire
    contract unchanged (v4)**. The dashboard renders a **distinct "thinking" indicator**, excluded from
    the "needs attention" count.
  - **ADR-0027** — *machine-level `claude.idle`* (partly supersedes ADR-0005; amends ADR-0026): a new
    **backend-derived, machine-scoped** attention that fires when **every `claude` pane on a machine**
    has produced no output for longer than the tier threshold (**1 min pro / 5 min free**). It is the
    **first attention computed server-side** (implements ADR-0005 §8) because "all sessions idle" is
    cross-session and no single per-session plugin instance can see it. Because ADR-0026 stops an idle
    machine's ingests, it fires from a **~20 s backend sweep** (`sweepMachineAttentions`) over
    liveness-touched, **non-stale** `Snapshot`+`PaneActivity` state — **not** at ingest. Reuses the
    episode engine (self-timed: `thresholdSeconds('claude.idle')=0` + 300 s cooldown + clear-on-resume)
    and the existing notification/SSE plumbing; text is "All Claude sessions are idle". Target is
    `{ machineId }` (targetKey `::`); wire contract **unchanged (v4)**.
  - **ADR-0028** — *drop `session.detached`, add `machine.offline`* (partly supersedes ADR-0005; amends
    ADR-0027): `session.detached` (a Zellij session with no attached client) is **normal usage, not an
    alert** — the backend now **filters it out of ingest**. In its place, **`machine.offline`** — a
    backend-derived, machine-scoped attention that fires **"A machine went offline"** when a machine
    stops reporting past `STALE_AFTER_MS` (60 s; a real disconnect because ADR-0026's ~5 s control-poll
    keeps a live machine fresh). Computed by the shared **`sweepMachineAttentions`** (both machine-level
    attentions emitted in **one** `processAttentions` call, since both use targetKey `::`); self-timed
    (`thresholdSeconds=0`) with a **24 h cooldown** so it fires **once per disconnect**, clears on
    reconnect, bounded to a **15-min lookback**. Excluded from the "needs attention" count. Wire
    **unchanged (v4)**.
  - **ADR-0029** — *opt-in long-poll control channel* (amends ADR-0026/0016): a plugin
    `control_long_poll` flag (**OFF by default**) that asks the backend to **hold** each control poll
    (additive `waitMs` on the control request) until a **pane-output request** or **manual refresh**
    wakes it — cutting that latency from up to ~5 s to **≈1 s** while sending *fewer* requests. A true
    server push is impossible from a plugin (`web_request` is single-buffered fire-and-forget, no
    socket — FINDINGS §5), so this is **HTTP long-polling**: backend in-process wake registry
    (`control/waiters.ts`, signalled by `registerRequest`/`bumpRefresh`, 25 s clamp) + plugin-side
    **watchdog** (`control_poll_due`) that re-issues a silently-dropped hold. The **fixed ~5 s poll
    stays the default and fallback**; enabling it is **gated on the real-Zellij smoke** (does the host
    hold a long `web_request`? unverified). Ingest wire **unchanged (v4)**.
  - **ADR-0030** — *ephemeral pane output* (amends ADR-0016/0018; **storage superseded by ADR-0032**):
    fixes the backend serving a **stale cached** pane capture. `readOutput` gates on the **request
    lifecycle** (returns `pending` until a **new** capture for the current request arrives — never a
    previous one); `registerRequest` **deletes the prior capture** (so a re-open, or a plugin that
    stopped sharing, never falls back to old content); a prune sweep (every 10 s,
    `PANE_OUTPUT_RETENTION_SEC=120`) makes stored output **ephemeral** so scrubbed content doesn't
    linger between views. The dashboard drawer is a **one-shot fetch** holding its lines in component
    state (stops polling once shown). Wire **unchanged (v4)**.
  - **ADR-0032** — *pane output is never persisted* (partly supersedes ADR-0030; amends ADR-0016/0018):
    captured pane content now lives **only in an in-process `PaneOutputStore`** (`apps/backend/src/output/store.ts`)
    and is **never written to the DB** — the **`PaneOutput` table is dropped** (migration
    `20260712010000_drop_pane_output`). Only the request lifecycle (`OutputRequest` — which pane,
    pending/fulfilled, **no terminal content**) stays in MariaDB. The whole ADR-0030 lifecycle
    (fresh-on-open, drop-on-re-request, ~2 min prune by server-receipt time, purge-on-forget via
    `store.deleteMachine`) is unchanged, now against memory; `submitOutput` is last-write-wins (no more
    unique-constraint race). Joins presence/waiters/auto-refresh as **in-process, single-backend** state.
    Makes the "never stored" / "content otherwise never leaves your machine" promise literally true.
    Wire **unchanged (v4)**.
  - **ADR-0031** — *long-poll is the default* (amends ADR-0029): flips the plugin `control_long_poll`
    default **OFF → ON** so pane-output/refresh latency is **≈1 s** (not up to ~5 s) out of the box;
    drawer pending poll tightened 2 s → 1 s. Safe because long-poll **self-degrades** — if the host
    won't hold the `web_request` it becomes a ~1 s poll (still faster than the 5 s fixed poll); only a
    host that *silently drops* held requests regresses (→ ~35 s watchdog, visible on reload). Set
    `control_long_poll off` for the ADR-0026 fixed poll. **Takes effect after a plugin `.wasm` rebuild +
    reload.** Wire **unchanged (v4)**.
- **`FINDINGS.md`** — verified Zellij plugin API reference (events, structs, permissions, config,
  hostname). **Read it before writing any plugin code**; it records exact type/field names, source
  URLs, and the things that are easy to get wrong.
- **`packages/`** — shared, publishable npm packages. Live now: `@zantiflow/oauth` / `-express` /
  `-react` (framework-agnostic Google/Apple OAuth; copied + rescoped from `@commenttoday/*`, MIT).
  Only Google is wired into the backend. See ADR-0004.
- **`plans/`** — implementation plans. **`plans/execution-plan.md`** is the phased build plan (Phases
  0–10) with the Prisma schema, protocol/API contracts, concrete defaults, and per-phase tests —
  **start here to implement.**
- **`design/`** — vendored UI design mockups (dc-runtime React export). `design/dashboard/zantiflow-status-v2.dc.html`
  is the **canonical dashboard design** the website must build to (ADR-0016).
- **`deploy/`** — example deployment (ADR-0021): `docker-compose.example.yml`, `.env.example`,
  `Caddyfile.example` (TLS + security headers/CSP).
- **`docs/`** — the **Starlight (Astro)** documentation site (ADR-0023): plugin / backend / dashboard,
  **privacy**, **contributing**, "what ADRs are", donations. Content under `docs/src/content/docs/`; the
  plugin getting-started guide (ADR-0022) lives here. *(Currently just `plugin-getting-started.md` until
  Starlight is scaffolded.)*
- `README.md` is currently just a placeholder.

## Architecture (the big picture)

Rust `zellij-tile` WASM plugin **→** authenticated `POST /api/v1/ingest` via Zellij's `web_request`
(`Authorization: Bearer <token>`, to a configurable `server_url`) **→** multi-tenant Express backend
that persists the latest `sessions → tabs → panes` snapshot per account/machine. (An indented
console render survives only as an optional dev/debug view; the read API + website are ADR-0008.)

- The whole tree comes from the plugin's `SessionUpdate` event; sessions render **current → other
  live → resurrectable/dead**.
- Per-pane "last updated" is **derived**, not given (see gotchas); a pane with no observed update yet
  renders `Unknown`.
- Redaction happens **in the plugin, before send**; the backend only displays.

## Repo conventions

- **ADRs** (mechanics for the HARD RULE at the top of this file — engaging an ADR is **mandatory for
  every task**): MADR-lite format, filename `NNNN-kebab-title.md`, numbered from `0001`. The template
  and index are in `adrs/README.md`. **One decision = one ADR.** An Accepted ADR is not rewritten — to
  change a decision, add a new ADR and add a forward-pointer to the old one (see how ADR-0001 points
  to ADR-0002). Keep the `adrs/README.md` index up to date.
- **Plans** live under `plans/`.
- **License:** this project's default license is **Apache-2.0** — new code, apps, and packages ship
  under it unless stated otherwise. (Exception: the vendored `@zantiflow/oauth*` packages under
  `packages/` retain their upstream **MIT** license — see ADR-0004.)
- **Code organization (ADR-0015):** prioritise **module-based code** — small, single-responsibility
  modules in **feature/domain subfolders** (`src/<domain>/…`), never monolith files. **Extract reusable
  functionality into packages** (`@zantiflow/*` npm, Rust crates/modules, Python packages) when it's
  reused across ≥2 apps, publishable, or has a stable versioned API — otherwise keep it a subfolder
  module (don't over-package). Narrow interfaces (ports & adapters) with **co-located tests**.

## Load-bearing constraints (easy to get wrong — details in FINDINGS.md)

- **No Zellij event signals "new stdout."** Per-pane activity must be derived by polling
  `get_pane_scrollback` and diffing (requires the `ReadPaneContents` permission). It's approximate
  and O(panes) per tick.
- **The real machine hostname is exposed nowhere** — the only reliable path is
  `run_command(["hostname"])` + `RunCommandResult`, gated by the `RunCommands` permission. `alias`
  and `hidden` machine-name modes need no extra permission (ADR-0002).
- **Pin `zellij-tile` to an exact version.** Its `Event`/`EventType`/`PermissionType` enums are
  `#[non_exhaustive]` and still evolving; re-verify field/enum names against the pinned tag.
- **Wire contract is v4** (snapshot: `machineId` + `attentions` + tree + privacy). **Pane output is NOT in
  the ingest contract** — it's a **separate on-demand channel** (ADR-0016): the site registers a request →
  the plugin's **~5 s poll** `GET /output/pending` → `POST /output` returns ≤50 **ANSI-colored** lines, only
  if `pane_output` is ON (default OFF; content otherwise never leaves the machine — and on the backend it is
  held **in memory only, never written to the DB**, ADR-0032). v4 added a top-level `attentions` array (plugin-detected
  states — ADR-0005); the backend enforces thresholds/frequency. v3 added a top-level `machineId`
  (plugin-generated, persisted in `/data`);
  ingest is authenticated with `Authorization: Bearer <token>` (account/token are **not** in the
  body). From v2: session/tab/pane `name` and pane `command` are **nullable** (`null` = redacted →
  backend renders `<hidden>`, distinct from `Unknown` = "no update seen yet"); activity-tracking
  identity is `sid + tabId + paneId` (sessions have no native id, so the plugin synthesizes a stable
  `sid`).
- **Two auth planes (ADR-0003).** Ingest **tokens are write-only** — they can push snapshots but
  cannot read data or manage the account. Reading/managing needs owner auth (Google, ADR-0004).
  Tokens: ≤10 active per account, each with an expiry or infinite; stored hashed; shown once.
- **Plugin has `token` (required to send) and `server_url` (defaults to hosted; overridable for
  self-hosting, must be https).** The token is a plaintext secret in the plugin config — prefer CLI
  `--configuration` over a shared layout file.
- **Privacy precedence (Model A):** master `full` (default on) is the baseline; explicit per-field
  settings override it. Invalid field values fail **closed** (redact) and warn.
- **Timers are one-shot** (`set_timeout` re-armed on each `Timer`), and `web_request` is
  fire-and-forget (response arrives async via `WebRequestResult`).
- Live config changes arrive via `Event::PluginConfigurationChanged` (no permission needed); the
  `Reconfigure` permission is unrelated (it mutates *global* Zellij config).

## Tooling

- **pnpm workspace is live** — root `package.json` + `pnpm-workspace.yaml` (globs `packages/*` +
  `apps/*`). `pnpm install`, then `pnpm -r build` (tsc) and `pnpm -r test` (vitest, 51 passing) work
  for `packages/*`. Single package: `pnpm --filter @zantiflow/oauth test`. Note: vitest pulls in
  esbuild, whose native build is approved via `allowBuilds` in `pnpm-workspace.yaml`.
- **Still to scaffold** (per ADR-0001 §8): `apps/backend` (Node + TS + Express), `apps/plugin`
  (Rust → `wasm32-wasip1`, Cargo workspace), `apps/web` (Next.js PWA), `apps/{discord,telegram}-bot`
  (Python). No Nx/Turborepo/Bazel initially.
- **Testing (ADR-0014):** four layers — **unit / BDD / integration / Playwright** — built test-first
  behind mockable ports. Externals mocked (Zellij host via `HostPort`, Google, web-push,
  Discord/Telegram); **MariaDB is real** (testcontainers). `cargo test` (plugin) · `vitest` +
  `supertest` + `@playwright/test` (TS) · `pytest` + `pytest-bdd` (bots). Every feature lands with tests.

### CI parity — run these locally before pushing (they gate the pipelines)

The GitHub Actions (`.github/workflows/{ci,tests,docker-publish,plugin-release}.yml`) fail the build on
any of the checks below. **After touching TS/JS or Rust, run the matching checks and make them green
before committing/pushing** — CI is not the place to discover a formatting/lint miss.

- **TS/JS (any change under `apps/*` or `packages/*`):**
  - `pnpm lint` — ESLint (`eslint .`). Flat config is `eslint.config.mjs`; the Next app pulls in
    `@next/eslint-plugin-next` (scoped to `apps/web/**`). An `eslint-disable` for an **unregistered**
    rule is a *hard error* ("Definition for rule … was not found"), not a no-op.
  - `pnpm format:check` — Prettier (`prettier --check .`). Fix with `pnpm format`. Prettier owns
    formatting; ESLint does not (`eslint-config-prettier` disables stylistic rules).
  - `pnpm -r build` (tsc) and `pnpm -r test` (vitest).
- **Rust (`apps/plugin`):** `cargo fmt --all --check` · `cargo clippy --all-targets --all-features -- -D warnings`
  · `cargo test --all`. `rust-toolchain.toml` must declare `components = ["rustfmt", "clippy"]` — the
  pin **overrides** any workflow-installed stable components, so without this the pinned toolchain has
  no `cargo-fmt`/`cargo-clippy` and CI dies before formatting is even checked.
- **Python (bots, once scaffolded):** `ruff check` · `pytest`.
- **Toolchain versions (keep CI green, avoid deprecation warns):** Node floor is **≥22.13** (pnpm@11.10
  needs `node:sqlite`; also set in root `engines` + the `test` matrix `[22, 24]`) — node 20 is EOL and
  cannot even run the toolchain. GitHub Actions must be **node24 majors**: `actions/checkout@v7`,
  `actions/setup-node@v6`, `pnpm/action-setup@v6`.
