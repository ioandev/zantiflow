# NOT IMPLEMENTED YET — ADR-by-ADR gap audit

Audit date: **2026-07-11**. Method: each ADR (0001–0023) read in full and checked against the actual
code in `apps/*`, `packages/*`, `deploy/`, `docs/`, and `.github/`. This lists only what is **missing,
partial, or not up to spec** — it is not a summary of what works. `file:line` references are given so
each item can be verified.

> Context: the build memory claims "all phases 0–10 complete, every ADR 0001–0021 implemented." That is
> broadly true for the **happy-path backend + plugin + web MVP**, but a systematic re-check found the
> gaps below. Two ADRs are fully clean (**0004, 0013, 0015**); the rest have at least one deviation.

## Status at a glance

| ADR | Title | Status |
|-----|-------|--------|
| 0001 | Telemetry architecture + layout | ⚠️ Partial |
| 0002 | Configurable privacy controls | ⚠️ Partial |
| 0003 | Multi-tenant backend + token auth | ⚠️ Partial |
| 0004 | Google owner sign-in | ✅ To spec |
| 0005 | Attentions detection + triggering | ⚠️ Partial (largest gaps) |
| 0006 | Notifications: Web Push + channels | ⚠️ Partial (largest gaps) |
| 0007 | Chat-bot channels | ⚠️ Partial |
| 0008 | Status website dashboard | ⚠️ Partial |
| 0009 | Durable notification delivery | ⚠️ Partial (minor) |
| 0010 | Bots in Python + token storage | ⚠️ Partial |
| 0011 | Tiers & monetization | ⚠️ Partial |
| 0012 | Plugin device pairing | ⚠️ Partial |
| 0013 | Paid subscriptions declined | ✅ Honored |
| 0014 | Testing strategy | ⚠️ Partial (2 of 4 layers missing) |
| 0015 | Modular code organization | ✅ To spec |
| 0016 | Dashboard page + pane-output | ⚠️ Partial |
| 0017 | Secret scrubbing + adaptive rendering | ⚠️ Partial |
| 0018 | Engineering & ops conventions | ⚠️ Partial |
| 0019 | UX deferred | N/A (one interim-default gap) |
| 0020 | Automated promo codes | ⚠️ Partial (minor) |
| 0021 | Dockerization & deployment | ⚠️ Partial |
| 0022 | Plugin publishing & user docs | ⚠️ Partial |
| 0023 | Documentation site | ⚠️ Partial |

## Biggest cross-cutting gaps (fix these first)

1. **No Playwright / E2E test layer exists anywhere.** ADR-0014 mandates it and ADRs 0005, 0006, 0008,
   0011, 0016, 0017, 0020 each name required Playwright coverage. There is no `@playwright/test` dep, no
   `playwright.config`, no e2e spec — `apps/web/test/` holds only `ansi.test.tsx` + `paircode.test.ts`.
2. **No BDD layer exists anywhere.** ADR-0014 names it as one of four required layers; ADRs 0005, 0017,
   0020 name specific BDD scenarios. Zero `.feature` files; no `pytest-bdd` / `cucumber-rs` / `@cucumber`.
3. **Per-account notification preferences (when/what/where/how) were never built.** The
   `NotificationSettings` Prisma model exists but is never read or written; no prefs router/UI; delivery
   fans out purely on `tier` + `eligibleChannels`. Blocks ADR-0005 §5/§7 and ADR-0006 §6/§7.
4. **Per-pane derived "last updated" / activity never built end-to-end.** The plugin computes and sends
   `contentFingerprint`, but the backend never diffs fingerprints and the UI never renders per-pane
   "updated Ns ago" / `quiet Xm` / `Unknown`. Blocks the headline behavior of ADRs 0001, 0008, 0016, 0017.
5. **No release / publish / deploy CI automation.** No Docker Hub multi-arch push (0021), no GitHub
   Release build of `zantiflow.wasm` + SHA-256 checksums (0022), no GitHub Pages deploy for the docs site
   (0023). CI builds/tests but ships nothing.
6. **Dashboard diverges from the canonical v2 design** (`design/dashboard/zantiflow-status-v2.dc.html`):
   no dark/light theme toggle, no machine-detail route/IA, no typed/per-node attention badges, no privacy
   or stale badges, no per-pane activity. Blocks ADR-0008 §4 and ADR-0016 §A.

---

## ADR-0001 — Telemetry architecture + monorepo layout — ⚠️ Partial

- **Backend never derives per-pane "last updated" (§4/§6 headline behavior).** The plugin sends
  `contentFingerprint` (`apps/plugin/src/model.rs:62`, `apps/plugin/src/snapshot.rs:69`), but
  `storeSnapshot` just replaces the whole snapshot blob without diffing fingerprints across ticks
  (`apps/backend/src/ingest/service.ts:23-38`); no `fingerprint`/`lastUpdated`/activity logic exists in
  `apps/backend/src`. The read API returns only machine-level `lastSeenAt`
  (`apps/backend/src/machines/service.ts:39-41`) and the tree shows only machine "last seen"
  (`apps/web/components/MachineTree.tsx:16-36`) — never per-pane "updated Ns ago" nor the `Unknown` marker.
  The plugin half is done; the backend + UI half is not.

## ADR-0002 — Configurable privacy controls (wire v2) — ⚠️ Partial

- ~~**`RunCommands` is not least-privilege.** §4/§8 require requesting it **only** when `machine_name`
  resolves to `real`, so alias/hidden users never see that prompt. The plugin requests all four
  permissions unconditionally in `load()`, `RunCommands` included, regardless of mode.~~
  **✅ RESOLVED (2026-07-11) by [ADR-0024](adrs/0024-opt-in-hostname-lookup.md):** the real hostname
  and its `RunCommands` permission are now opt-in (`hostname` flag, default OFF) and requested lazily
  via a two-phase handshake gated on `config::wants_hostname()`; `load()` requests only the base three
  permissions (`apps/plugin/src/plugin.rs`), and a `RunCommands` denial no longer disables telemetry.
- **Invalid/absent `full` resolves opposite to the §2 table.** ADR-0002 §2 says absent-or-invalid `full`
  → treated as **`true`**; the code fails it closed to **`false`** (`apps/plugin/src/config.rs:116-122`).
  This matches ADR-0018 §3's "fail-closed for privacy keys," so the two ADRs conflict — pick one and make
  the code + one ADR agree.

## ADR-0003 — Multi-tenant backend + token auth — ⚠️ Partial

- **Plugin does not refuse plaintext `http://` `server_url` (§6 / OQ6).** The decision was to refuse
  non-https except localhost. The plugin merely warns and then **keeps and uses** the bad URL
  (`apps/plugin/src/config.rs:159-169` clones it; `apps/plugin/src/net.rs:17-19` builds the POST from it
  unconditionally; no re-check in `send_snapshot`, `apps/plugin/src/plugin.rs:321-336`). A misconfigured
  `server_url="http://evil.example"` still ships telemetry in cleartext.
- *Everything else in ADR-0003 is to spec* (atomic ≤10-active token cap via `SELECT … FOR UPDATE`,
  SHA-256 + `lookupPrefix`, shown-once, per-token expiry/`infinite`, write-only plane isolation,
  cross-account machine-hijack guard, per-token ingest rate limit).

## ADR-0004 — Google owner sign-in — ✅ To spec

- No gaps. (Note: `OAuthProfile.emailVerified` is captured but not persisted on `Account` —
  `packages/oauth/src/google.ts:102` vs `apps/backend/src/auth/accounts.ts:20-23`. The ADR's OQ1 itself
  defers this, so it is not counted as a gap, but it remains a loose thread.)

## ADR-0005 — Attentions: detection + triggering — ⚠️ Partial (largest gaps)

- **`session.stopped` is entirely unimplemented — both required paths.** Plugin does not emit it when
  sessions move to the resurrectable list (`apps/plugin/src/snapshot.rs:95-105`;
  `apps/plugin/src/attentions.rs` only builds `detached` + `needs_input`). Backend has no
  staleness/grace inference (~30–60 s → raise stop); `Machine.lastSeenAt` is written
  (`apps/backend/src/ingest/service.ts:20-21`) but never checked. A dead `session.stopped` text template
  sits unused at `apps/backend/src/notifications/service.ts:17-18`.
- **Config-defined pattern attentions are missing (§1/§7).** No generic `{ id, pattern, scope, watch_cmd? }`
  module and no config surface to enable/disable attentions or set per-attention params —
  `apps/plugin/src/config.rs:22-36` has zero attention configuration. Only the two hardcoded built-ins exist.
- **`claude.needs-input` output-silence heuristic missing; prompt-dwell has no dwell/timing/config (§3).**
  `apps/plugin/src/snapshot.rs:50-57` + `apps/plugin/src/attentions.rs:14-23` implement only "last
  non-blank line ends with `?`", firing immediately — no silence detection, no "unchanged for ≥15 s"
  dwell, and a hardcoded `?` pattern.
- **No per-account backend policy and no `action` concept (§5/§7).** Thresholds are hardcoded by tier
  (`apps/backend/src/attentions/policy.ts:17-24`), cooldown is a constant 300 s, there is no
  account-configurable override and no `action` = `notify`/`display` field. Everything that fires routes
  to notify unconditionally.
- **Plugin flap-suppression debounce + out-of-cycle transition send + `state:"cleared"` emit are absent
  (§4, "may"/best-effort).** Attentions are sent only on the fixed 1 s tick
  (`apps/plugin/src/plugin.rs:487-501`); clearing happens only via backend absence-reconcile
  (`apps/backend/src/attentions/service.ts:74-81`). Lower severity.
- *(Correctly present: wire-v4 `attentions` array, `session.detached` via `connected_clients==0`, the
  backend episode engine with tier-gated threshold + cooldown, fired→notification wiring. `claude.thinking`
  is correctly NOT emitted, though dead `thinking` branches linger harmlessly in `policy.ts:19` /
  `notifications/service.ts:15-16`.)*

## ADR-0006 — Notifications: Web Push + channels — ⚠️ Partial (largest gaps)

- **Pre-permission modal missing (§3).** `apps/web/components/EnableNotifications.tsx:57-61` is a bare
  button that calls `Notification.requestPermission()` directly (`:33`) with no value-explaining modal
  first. Denied handling only relabels the button "Notifications blocked" (`:59`) with no
  re-enable-in-settings instructions.
- **PWA install incentivization entirely missing (§4).** No `beforeinstallprompt` capture, no "Install
  zantiflow" button, no installed/standalone detection, no iOS "Add to Home Screen" instructional modal,
  and no nudge when an iOS user tries to enable notifications. The ADR calls install **required on iOS** —
  this is a core gap.
- **Per-account notification preferences (when/what/where/how) missing (§6/§7).** The
  `NotificationSettings` model (`apps/backend/prisma/schema.prisma:120-123`) is never read/written; no
  prefs router is mounted (`apps/backend/src/http/router.ts:30-45`); `createForFired`
  (`apps/backend/src/notifications/service.ts:34-72`) fans out purely on `tier` + `eligibleChannels` — no
  per-type enable, quiet hours/DND, frequency caps/digest, or per-type channel routing. §7 pipeline step 1
  ("load account prefs; filter … routing + quiet hours + frequency caps") is unimplemented.

## ADR-0007 — Chat-bot notification channels — ⚠️ Partial

- **Bot-side `deliveryId` dedup is absent (§2).** `handle_deliver` DMs and acks on every `deliver` with
  no seen-set (`packages/notify-protocol/src/zantiflow_notify/handlers.py:17-27`), while the backend
  re-sends still-pending rows after `REDELIVER_AFTER_MS = 30_000`
  (`apps/backend/src/delivery/dispatcher.ts:11,89-121`). A lost/late ack → **duplicate DM**. The required
  "unit (message dedup)" test does not exist.
- **Discord `/link` slash command not implemented (§3.2/§7).** `apps/discord-bot/bot.py:37-51` matches a
  plain DM text prefix `"/link "` instead of registering a real slash command; `DISCORD_APP_ID` /
  `DISCORD_GUILD_ID` are never read (`bot.py:74-78`). No community-guild invite anywhere.
- **Website never surfaces the linking affordances (§3.2).** No Discord community-server invite and no
  Telegram deep link `https://t.me/<bot>?start=<token>`; the endpoint returns only `command: /link <token>`
  (`apps/backend/src/integrations/router.ts:24`) and the page renders that string for both platforms
  (`apps/web/app/integrations/page.tsx:75-82`). (The Telegram bot *does* handle `?start=<token>` at
  `apps/telegram-bot/bot.py:31-34`, but the UI never generates the deep link.)
- **Confirmation DM + `accountLabel` missing (§3.3/§3.4).** On `link_result` both bots only log
  (`apps/discord-bot/bot.py:65-66`, `apps/telegram-bot/bot.py:64-65`); the backend never sets
  `accountLabel` (`apps/backend/src/bots/hub.ts:92`). The user who was promised "a confirmation shortly"
  never gets one; friendly errors (invalid token / DMs-disabled) are only logged.

## ADR-0008 — Status website dashboard — ⚠️ Partial

- **Attention badges are neither typed nor node-placed (§4).** Only an aggregate machine-level count
  `⚠ N` is shown (`apps/web/components/MachineTree.tsx:30-34`); the dashboard buckets attentions purely by
  `machineId` (`apps/web/app/dashboard/page.tsx:19-28`) and never uses each attention's `targetKey`
  (`sid:tabId:paneId`) to badge the specific session/tab/pane, nor renders the attention *type*
  (needs-input / stopped / detached).
- **`GET /machines` omits `online/stale` and `counts` (§2).** `listMachines` returns only
  `id/displayName/firstSeenAt/lastSeenAt` (`apps/backend/src/machines/service.ts:6-21`) — no staleness
  flag, no session/pane counts.
- **Significant divergence from the canonical v2 design.** v2 shows inline pane-output previews and a
  dark/light theme toggle (`design/dashboard/zantiflow-status-v2.dc.html:197-238,610`); the build is a
  plain unstyled tree with a click-to-open drawer and no theming.
- **Playwright layer missing** (Testing line: "Playwright — dashboard, SSE live update, `<hidden>`").

## ADR-0009 — Durable notification delivery — ⚠️ Partial (minor)

- **`SELECT … FOR UPDATE SKIP LOCKED` not implemented.** The dispatcher claims pending rows with a plain
  `findMany` (`apps/backend/src/delivery/dispatcher.ts:26-30,95-104`), so two backend instances would
  double-dispatch. Safe only single-instance.
- **Exponential backoff not implemented (Open-Q 1).** A failed web-push row is retried on the very next
  10 s sweep with no attempt-based delay (`dispatcher.ts:63-77`); bots use a fixed 30 s window. The
  `MAX_ATTEMPTS=5` cap is honored but the backoff curve is not.
- *Minor:* the orphan-`Notification` delete deletes all notifications past cutoff rather than strictly
  orphaned ones (`notifications/service.ts:89-91`) — functionally equivalent given aligned timestamps.

## ADR-0010 — Bots in Python + token storage — ⚠️ Partial

- **`protocolVersion` negotiation not enforced (Open-Q 4).** The `hello` handler checks only the service
  secret and ignores `msg.version` (`apps/backend/src/bots/hub.ts:53-70`); an incompatible-major bot is
  accepted.
- **No codegen — Python types are hand-maintained (§2 / Open-Q 2).** `models.py` is a hand-written mirror
  of `botws.ts` (`packages/notify-protocol/src/zantiflow_notify/models.py:1-4`); `jsonschema.ts` derives
  schema *from* the Zod TS rather than generating both sides from a canonical schema — exactly the drift
  the ADR meant to eliminate.
- **Required tests missing** (Testing line "pytest unit — WS models, `/link`, dedup): `test_models.py`
  covers models, but there is no `/link` handler test and no dedup test.
- **Package naming deviation (§2).** No package is literally named `@zantiflow/notify-protocol`; the TS
  types live in `@zantiflow/protocol` and the Python package is `zantiflow-notify-protocol`. Substance
  present, name differs.
- *Minor:* tooling is `pip`, not `uv` (Open-Q 3) — both Dockerfiles `pip install`.

## ADR-0011 — Tiers & monetization — ⚠️ Partial

- **GitHub Sponsors donation is entirely absent (§2).** No site Sponsors link
  (`apps/web/app/page.tsx:26-43`), no repo Sponsor button / `.github/FUNDING.yml`, and no "donations don't
  grant PRO" copy anywhere. (The on-site link *placement* is UX-deferred by ADR-0019 D3, but the repo
  Sponsor button and the donation messaging are not deferred and are simply missing.)
- **Playwright test (redeem code) missing** (Testing line). Only `promo.integration.test.ts` exists.
- *(Tier model + promo engine are fully implemented and genuinely consumed for gating — `tiers/service.ts`,
  `ingest/router.ts:54`, `attentions/policy.ts:18-19`, `notifications/service.ts:27`.)*

## ADR-0012 — Plugin device pairing — ⚠️ Partial

- **No `PairingSession` expiry cron / cleanup.** The Consequences list an "expiry cron"; the scheduler
  (`apps/backend/src/index.ts:47-63`) sweeps only notifications/tiers/promo. Expired rows are lazily marked
  `expired` on poll (`apps/backend/src/pairing/service.ts:78-82`) but **never deleted** (no
  `pairingSession.delete*` anywhere) — rows accumulate unbounded.
- **The `denied` state is unreachable — no deny action exists (§3).** Denial is modeled and handled on the
  read/plugin side (`schema.prisma:178`, `pairing/service.ts:77`, `plugin.rs:305`), but no endpoint or UI
  ever sets `status='denied'` — the router exposes only `/start`, `/poll`, `/approve`
  (`pairing/router.ts:34-68`); the web page only approves. An owner cannot deny.
- **The approval page does not show the `machineHint` (§3).** The plugin sends a hint (`plugin.rs:230`) and
  the backend stores it (`pairing/service.ts:33`), but `/pair` approves the typed code with no preview and
  there is no lookup-by-code endpoint to fetch the hint (`apps/web/app/pair/page.tsx:28-46`). The owner
  approves blind.

## ADR-0013 — Paid subscriptions declined — ✅ Honored

- No gaps. No `stripe|polar|checkout|billing` anywhere; PRO is granted solely via promo `redeem` +
  lapsed by the free sweep.

## ADR-0014 — Testing strategy — ⚠️ Partial (2 of 4 layers missing)

- **BDD layer (1 of 4 required) is absent.** Zero `.feature` files repo-wide; no `pytest-bdd` /
  `cucumber-rs` / `@cucumber` in any manifest; TS tests are plain `it(...)` cases, not given/when/then.
- **Playwright (E2E) layer entirely missing.** No `@playwright/test`, no config, no spec. `apps/web/test/`
  has only `ansi.test.tsx` + `paircode.test.ts`.
- **Real-Zellij smoke check is manual-only, not automated.** Exists as a written checklist
  (`apps/plugin/README.md:45`); no CI job loads the `.wasm` in Zellij (within the ADR's "or manually," but
  no automated validation of the mock-vs-reality assumptions).
- *(Present: unit layer, integration layer with real MariaDB via testcontainers, and the `HostPort`
  ports-&-adapters seam.)*

## ADR-0015 — Modular code organization — ✅ To spec

- No gaps. No monolith files (largest backend module 121 lines; `plugin.rs` at 574 lines is the single
  FFI adapter with all pure logic split out). Feature subfolders throughout; promotion rule followed
  (`@zantiflow/protocol`, `notify-protocol`, `oauth*` are packages); co-located tests present.

## ADR-0016 — Dashboard page + pane-output — ⚠️ Partial

- **Dark/light theme toggle is missing (§A/§2).** `apps/web/app/globals.css:11` is `color-scheme: dark`
  only — no light variables, no `data-theme`, no `prefers-color-scheme`, no persisted toggle. The canonical
  design implements it (`design/dashboard/zantiflow-status-v2.dc.html:34-35,610-612`).
- **Dashboard not built to the v2 information architecture.** v2 is a Machines-list → click → detail
  (`/m/:machineId`); the build renders every machine inline on one page
  (`apps/web/app/dashboard/page.tsx:124-128`) with no `/m/[machineId]` route.
- **Machine-card elements missing vs design + §A:** no privacy badges (real/alias/hidden, `full`/
  `restricted`), no live/stale badge, no counts (`sessions · tabs · panes`), no `first seen`
  (`apps/web/components/MachineTree.tsx:27-38` shows only name + attention badge + "id · last seen").
- **Per-pane activity missing (§A):** no `Xs ago` / `quiet Xm` / `Unknown`
  (`apps/web/components/MachineTree.tsx:57-64` renders only name/command/focused/exited).
- **Purge-on-`pane_output`-disable not implemented (§B4).** Forget-machine purges
  (`apps/backend/src/machines/service.ts:52`), but disabling `pane_output` sends no signal to the backend
  (it is plugin-local config), so stored `PaneOutput` persists and the drawer keeps serving stale content.
- **Playwright tests (dashboard / drawer / SSE / theme) absent** (Testing line).
- *(Correctly built: `pane_output` default OFF + privacy-gated + separate ~5 s poll + last ≤50 lines
  ANSI-preserved on-demand; read API `GET …/panes/:paneId/output`; XSS-safe ANSI renderer.)*

## ADR-0017 — Secret scrubbing + adaptive rendering — ⚠️ Partial

- **Custom user scrub patterns not wired end-to-end (§3).** `Scrubber::new` accepts `user_patterns`
  (`apps/plugin/src/scrub.rs:38`) but the plugin constructs `Scrubber::new(&[])`
  (`apps/plugin/src/plugin.rs:366`) and `config.rs` parses no scrub-pattern setting — the capability is
  unreachable.
- **`pane_output_scrub = off` opt-out not implemented (§3).** No such key is parsed
  (`apps/plugin/src/config.rs`); scrubbing is unconditional. Safe-by-default, but the decided flag is absent.
- **Adaptive rendering incomplete — not all 5 states disclosed.** Present: `output not shared`
  (`apps/web/components/PaneOutputDrawer.tsx:65-67`), masked spans (`«redacted»`), redacted name →
  `<hidden>`. **Missing:** machine `stale`/offline disclosure (no stale badge/dim/warning color —
  `MachineTree.tsx:35-37` shows plain "last seen"), "no change observed yet" / `Unknown` per-pane (not
  rendered at all), and the dead-session "no tab/pane detail" disclosure.
- **BDD (token masked before send) + Playwright (masked spans / output-not-shared) absent** (Testing line).

## ADR-0018 — Engineering & operational conventions — ⚠️ Partial

- **Secret rotation not implemented (§4).** The verifier must accept a list of `TOKEN_SECRET`s (current +
  previous) for overlapping rotation. Config declares a single `TOKEN_SECRET`
  (`apps/backend/src/config/index.ts:12,39`) and `verifyToken`/`verifySession` take exactly one secret
  (`apps/backend/src/auth/tokens.ts:21,59`; `apps/backend/src/auth/session.ts:52`). Keys cannot rotate
  without a forced mass-logout.
- **Owner-session TTL diverges from the §11 retention table.** The table says 30 d; the code defaults
  `SESSION_TTL_DAYS` to 14 (`apps/backend/src/config/index.ts:14`, comment "shortened per
  security-audit"). Deliberate, but it contradicts the ADR table as written — reconcile one.
- **Plugin config handling is partial (§3).** Unknown keys are silently ignored with **no warning**
  (`apps/plugin/src/config.rs:112-190`); several documented keys are never parsed — `pane_output_scrub`,
  attention enable/params, and `pairing` keys — and the scrubber is built with empty patterns
  (`apps/plugin/src/plugin.rs:366`).
- **Graceful shutdown does not drain SSE (§10).** Shutdown clears intervals and calls `server.close`
  (`apps/backend/src/index.ts:69-77`), but there is no close-all for open SSE streams (`SseBus` has none —
  `apps/backend/src/sse/bus.ts`) and the SSE route holds a 25 s-heartbeat long-lived connection
  (`apps/backend/src/sse/router.ts:35`). `server.close()` can hang; SSE is not drained.

## ADR-0019 — UX decisions deferred — N/A (one interim-default gap)

- The deferral itself is honored; interim surfaces (integrations, pairing, promo, notification opt-in)
  exist. **But D8 empty/loading/error states are entirely absent even as "sensible defaults."** The
  Next.js app has no `error.tsx`, `loading.tsx`, `not-found.tsx`, or `global-error.tsx` in any route under
  `apps/web/app/`, and no toast/empty-state component. §3 says build these to functional defaults so
  nothing is blocked — they were never built.

## ADR-0020 — Automated promo codes — ⚠️ Partial (minor)

- **BDD (redeem → PRO for a month) + Playwright (homepage shows code, redeem flow) tests absent** (Testing
  line). Only `promo.integration.test.ts` exists.
- *Minor:* a re-redeem returns a distinct `409 already_redeemed` "You have already redeemed this code"
  (`apps/backend/src/promo/service.ts:81-82`), deviating from the "generic failure messages" rule
  (§3 / ADR-0011 §2). Low risk (own-account state).
- *(Otherwise functionally complete: 2-week cron, CSRNG `ZTF-XXXXXXXX`, +30 d grant capped at now+60 d,
  public `GET /promo/current`, owner `POST /promo/redeem` at 5/hr.)*

## ADR-0021 — Dockerization & deployment — ⚠️ Partial

- **No Docker Hub publishing (§2).** CI's only `docker` job runs plain single-arch
  `docker build -t zantiflow/backend:ci` with no `buildx --platform`, no push, no SemVer/`:latest` tags
  (`.github/workflows/ci.yml:115-127`). The referenced "separate release workflow" (comment at `:112-114`)
  does not exist.
- **Compose smoke test missing** (Testing line requires `docker compose up` reaching healthy +
  `/healthz`·`/readyz` green). CI builds the four images but never runs compose or checks health.
- **Bot images are single-stage, not multi-stage (§1).** `apps/discord-bot/Dockerfile` /
  `apps/telegram-bot/Dockerfile` each have a single `FROM python:3.12-slim AS runtime` — no build stage.
  (They are non-root via `USER app`, so that requirement holds.)
- **Bot dependency versions not pinned (§2).** `discord.py>=2.4` / `aiogram>=3.13` are open ranges;
  the ADR stresses pinning/reproducibility.
- *(To spec: backend/web multi-stage non-root images with `HEALTHCHECK` + migrate-on-start; compose uses
  official pinned `mariadb:11.4` not host-exposed, Caddy the sole 80/443 publisher with security headers +
  strict CSP; all three `deploy/*.example` files present.)*

## ADR-0022 — Plugin publishing & user docs — ⚠️ Partial

- **No GitHub Release automation for the plugin `.wasm` (§1).** No release workflow exists; the `rust` CI
  job runs only fmt/clippy/test and never builds the `wasm32-wasip1` artifact
  (`.github/workflows/ci.yml:70-82`); no `gh release` / `softprops/action-gh-release` / `sha256sum`
  tooling anywhere in `.github/`.
- **Testing line unmet:** none of release build, SHA-256 checksum publish/verify, or docs link-check exist.
- *Minor:* artifact-name mismatch — the ADR names `zantiflow.wasm` but the Cargo binary is
  `zantiflow_plugin` → `zantiflow_plugin.wasm` (`apps/plugin/Cargo.toml`), with no rename step (no release
  job to do it).
- *(To spec: the user guide exists at `docs/plugin-getting-started.md` and is migrated into Starlight at
  `docs/src/content/docs/plugin/getting-started.mdx`.)*

## ADR-0023 — Documentation site (Starlight) — ⚠️ Partial

- **No GitHub Pages deploy workflow (§4).** `astro.config.mjs` is configured for Pages
  (`site`/`base: '/zantiflow'`) but there is no `actions/deploy-pages` / `upload-pages-artifact` / Pages
  workflow in `.github/workflows/` — the site is built but never deployed.
- **No link-check in CI** (Testing line requires `astro build` + link-check + Pagefind). `astro build`
  rides `pnpm -r build` and Pagefind is produced, but no link-check step exists.
- *(To spec: Starlight/Astro scaffolded as a workspace package; all required IA pages exist — overview,
  plugin/getting-started, backend, dashboard, bots, privacy, contributing, "what ADRs are" (`adrs.mdx`,
  which links rather than duplicates), donations; local Pagefind search built.)*
