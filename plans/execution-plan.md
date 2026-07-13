# zantiflow — Execution Plan

The sequenced, buildable plan that turns the 23 ADRs into working software. Each **phase** is
independently testable and builds on the previous; the **MVP loop** (plugin → ingest → dashboard) is
working by Phase 4. ADRs are the source of truth — this plan references them by number and adds the
concrete artifacts (schema, contracts, defaults) needed to build without re-deriving decisions.

> **Hard rule (CLAUDE.md):** never restart/kill/reload Zellij on this machine. Plugin testing uses a
> **separate throwaway Zellij session** only.

## Guiding invariants (do not violate)
- **Two auth planes, never conflated:** ingest tokens are **write-only** (`Authorization: Bearer ztf_…`, hashed at rest); owner sessions are `ztf_session` HMAC cookies (Google) gating read/management. (ADR-0003/0004)
- **Every query scoped by `accountId`** at the data layer (not just the route). IDOR is the top bug class. (ADR-0003)
- **Redact + scrub in the plugin, before send.** The backend never receives raw secrets or pane content. Privacy **fails closed**. (ADR-0002/0017)
- **Snapshot wire contract is v4**; ignore unknown fields; reject unknown-newer with `400`. Token/account never in the body. (ADR-0018 §2)
- **Pane output is a separate on-demand channel** (5 s poll), OFF by default, sent only on website request. (ADR-0016)
- **Tier enforced server-side**; **history retention = none** (latest-only). (ADR-0005/0008)
- **Test at every step** (unit / BDD / integration / Playwright) behind mockable ports; **MariaDB real** (testcontainers). (ADR-0014)
- **Module-first** — small modules in feature subfolders; extract reusable code to packages. (ADR-0015)

## Target monorepo layout
```
zantiflow/
├── apps/
│   ├── plugin/            # Rust → wasm32-wasip1 (zellij-tile)         [Phase 3,5,7]
│   ├── backend/           # Node/TS/Express + Prisma + MariaDB          [Phase 1,2,5,6,7,8]
│   ├── web/               # Next.js PWA dashboard                        [Phase 4,6,7,8]
│   ├── discord-bot/       # Python (discord.py)                          [Phase 9]
│   └── telegram-bot/      # Python (aiogram)                             [Phase 9]
├── packages/
│   ├── oauth, oauth-express, oauth-react     # exist — harden in Phase 0
│   ├── protocol/          # TS types + JSON Schema (wire v4, output, bot-WS, SSE) [Phase 0]
│   └── notify-protocol/   # internal bot↔backend schema + Python codegen  [Phase 9]
├── docs/                  # Starlight (Astro)                            [Phase 10]
├── deploy/                # compose + Caddyfile + .env (examples exist)  [Phase 10]
├── adrs/  FINDINGS.md  CLAUDE.md  plans/
```
Add `apps/*` and `docs` to `pnpm-workspace.yaml` as each is scaffolded. Root `tsconfig.base.json`,
ESLint/Prettier, `.editorconfig`.

---

## Phase 0 — Foundation & shared contracts
**Goal:** shared types + the OAuth security fix, all green.
- Root: `tsconfig.base.json`, ESLint/Prettier, GitHub Actions skeleton (build+test matrix: node, rust, python).
- `packages/protocol`: the **wire v4**, **output-channel**, **SSE**, and **bot-WS** message **types** + a **JSON Schema** source of truth (Appendix B). Zod (or JSON-Schema + `ajv`) validators for the backend boundary.
- `packages/oauth`: **implement the ADR-0004 hardening (release-blocker):** JWKS verify (`jose`, pinned), validate `aud==clientId`/`iss`/`exp`, capture `email_verified`, and **refuse to derive a profile from a browser-transited id_token**. Keep the 51 existing tests green + add hardening tests.
- **Tests:** protocol round-trip/validation; oauth hardening (valid/forged/expired/wrong-aud).
- **Done-when:** `pnpm -r build && pnpm -r test` green; `@zantiflow/protocol` importable.

## Phase 1 — Backend skeleton + DB + auth
**Goal:** sign in with Google; sessions gate the API.
- `apps/backend` module layout (Appendix D): `http`(app/router/errors), `config`(env), `log`(structured, redacting), `db`(Prisma client), `ratelimit`(token-bucket, trusted-proxy), health `/healthz`·`/readyz`, error envelope `{error:{code,message}}`.
- **Prisma + MariaDB** (Appendix A): schema, initial migration; entrypoint runs `prisma migrate deploy`.
- **Auth** (`auth/`): mount `@zantiflow/oauth-express` GoogleProvider; `signState/verifyState` = HMAC(`TOKEN_SECRET`, `typ:'state'`, 10-min); `onLogin` → upsert Account by `(provider, sub)`, `setSession` (`ztf_session`, `{accountId, epoch}`, 14-day, HttpOnly/SameSite=Lax/Secure); session middleware (**DB re-check + `epoch === account.sessionEpoch`**); `/auth/me`, `/auth/logout`, `/auth/logout-all` (bump epoch); **validate `redirect` = same-site relative**.
- **Tests:** integration (testcontainers MariaDB): mocked-Google login → `ztf_session` → `/auth/me`; management route 401 without session; logout-all invalidates. Unit: HMAC verify (timing-safe), redirect validation.
- **Done-when:** login (mocked Google) issues a session; gated routes 401 without it.

## Phase 2 — Tokens + ingest + read API (backend core loop)
**Goal:** a token ingests a snapshot; the owner reads it; cross-tenant blocked.
- **Tokens** (`tokens/`): mint (`ztf_`+CSRNG, store SHA-256 + `lookupPrefix`, show once), list (metadata only), revoke (DELETE); **≤10 active enforced atomically**. **Device pairing** (`pairing/`): `POST /pair/start` (mint `PairingSession`, `userCode`+`sessionId`), `POST /pair/poll` (RFC-8628 states), verify page action (owner-auth) → mints an ingest token bound to the pairing; rate-limit code entry.
- **Ingest** (`ingest/`): `POST /api/v1/ingest` — verify Bearer token (constant-time, expiry/revocation server-side), **validate wire v4** (Appendix B; bounded depth/lengths), upsert Machine (`accountId`,`machineId`,`displayName`), **store latest Snapshot** (replace), update `lastSeenAt`/`token.lastUsedAt`. Write-only plane — no read/manage reachable.
- **Read API** (`machines/`, `sse/`): `GET /machines`, `GET /machines/:id`, `GET /attentions` (current), `DELETE /machines/:id`; **`GET /stream` SSE** (account-scoped, emits on that account's ingest/attention change). All tenant-scoped; `Cache-Control: no-store`.
- **Rate limits** (Appendix C): ingest per token/machine; auth/login; read/SSE per account.
- **Tests:** integration — ingest→snapshot; **IDOR: account B cannot read/forget A's machine**; ≤10 cap (incl. concurrency); expired/revoked token → 401; SSE emits only caller's data. BDD.
- **Done-when:** end-to-end backend loop verified (ingest → store → tenant-scoped read).

## Phase 3 — Plugin MVP + real-Zellij smoke check
**Goal:** the plugin pairs and POSTs v4 snapshots from a real (throwaway) Zellij session.
- `apps/plugin` (Rust, module layout Appendix D): **`HostPort` trait** wrapping ALL `zellij-tile` FFI (`get_pane_scrollback`, `web_request`, events, timers, `/data`) + a **fake** for tests.
- `config` (KDL keys, precedence, fail-closed on invalid privacy — ADR-0002/0018); `snapshot` (build v4 from `SessionUpdate`; ordering current→live→resurrectable); `privacy` (Model A); `fingerprint`+`sid` (salted hash persisted in `/cache`); `machineId` (`/data`); `pairing` (render `userCode`, poll); `net` (`web_request` POST v4, Bearer; https-only `server_url`); `request_permission` for the 3–4 grants.
- Timer loop: `set_timeout(1.0)` re-armed; POST each tick; read `WebRequestResult`.
- **Real-Zellij smoke check (ADR-0014 §6)** in a **separate throwaway session**: confirm `get_pane_scrollback` signature/permission, `web_request` works, `PluginConfigurationChanged` fires, `/data`/`/cache` writable, enum/struct shapes on the **pinned `zellij-tile` tag**. Record results in FINDINGS if they differ.
- **Tests:** unit via fake `HostPort` (snapshot build, privacy resolution, ordering, fingerprint); contract test (mock-Zellij harness → Phase-2 test backend; asserts v4 on the wire).
- **Done-when:** plugin pairs against the backend and its snapshots appear via the read API. **MVP loop closed.**

## Phase 4 — Web dashboard MVP (Next.js PWA)
**Goal:** sign in → see your live sessions.
- `apps/web`: Next.js (`output: 'standalone'`), PWA shell (manifest, service worker); proxy `/api/v1` → backend; login (redirect+cookie), `/auth/me`, logout; **dashboard** — machines list (cards: live/stale, privacy badges, attention count, counts, first/last seen) → machine detail (session→tab→pane tree, ordering, `<hidden>`/`Unknown`); **live via `EventSource`** (SSE) + polling fallback; **safe rendering** (escape all names/`command`; no `dangerouslySetInnerHTML` — ADR-0016 §D); theme toggle; tokens page (create/list/revoke, ≤10).
- **Tests:** Playwright — mocked-Google login → dashboard renders seeded machines → SSE live update → `<hidden>` shown; token CRUD; a11y baseline.
- **Done-when:** a signed-in user sees their live machines/sessions/tabs/panes updating.

## Phase 5 — Attentions (plugin detect + backend enforce)
**Goal:** a silent Claude pane → "needs attention" → a fired trigger.
- **Plugin** (`attentions/`): built-in `claude.needs-input` (**output-silence ≥ threshold OR last non-blank line ends `?` unchanged ≥15 s**, gated to `watch_cmd=claude`), `session.detached` (`connected_clients==0`), `session.stopped` (moved to resurrectable); config-pattern attentions; **ReDoS-capped** patterns (Appendix C); local debounce; emit in v4 `attentions[]`.
- **Backend** (`attentions/`): episodes per target (first-active, cooldown, last-fired); **tier-gated thresholds (5 min free / 1 min pro)**; **staleness** grace (30–60 s) → `session.stopped`; expose **current** attentions (no history); fire triggers (`notify`/`display`).
- **Web:** attention badges on machines/panes.
- **Tests:** BDD (silence→active; ≥threshold+outside-cooldown→trigger; staleness→stopped); unit (heuristics, ReDoS caps); server-side tier enforcement (client can't unlock pro).
- **Done-when:** the badge appears and a trigger fires per the thresholds.

## Phase 6 — Notifications + Web Push
**Goal:** a fired trigger → a browser push (free tier).
- **Backend** (`notifications/`, `delivery/`): `NotificationSettings` (tiered prefs: which types, quiet hours, per-type routing); **notifier** (filter by tier/routing/quiet-hours; compose text **honoring privacy** — no leaked names/content); `Notification` + one `NotificationDelivery` **row per channel**; **dispatcher** (claim via `SELECT … FOR UPDATE SKIP LOCKED`, retry ~5×/backoff, `delivered`/`failed`/`expired`), **idempotent `deliveryId`**, **replay pending on restart**, **cron prune** (default 6 h). **Web Push** (`web-push`, VAPID; prune 404/410); `PushSubscription` per device.
- **Web:** **pre-permission modal + button** (gesture → `requestPermission` → subscribe); **install nudges** (Android `beforeinstallprompt`; iOS "Add to Home Screen" modal — required for iOS push); notification settings page (defaults, ADR-0019); service worker (`push`, `notificationclick`).
- **Tests:** BDD (trigger→delivery rows; **restart→replay**); Playwright (permission popup grant/deny, install nudge, settings); web-push mocked.
- **Done-when:** an attention trigger delivers a web-push notification.

## Phase 7 — Pane output (on-demand channel)
**Goal:** click a pane (output on) → last 50 colored, scrubbed lines in ~5 s.
- **Plugin** (`output/`, `scrub/`): **~5 s poll** `GET /output/pending`; for each request capture last ≤50 lines (`get_pane_scrollback`), **scrub** (ANSI-aware ruleset, Appendix C), **preserve ANSI**, `POST /output`. `pane_output` **OFF** by default; docs state on-request-only.
- **Backend** (`output/`): `OutputRequest` lifecycle (register/pending/fulfilled/expired TTL), `GET /output/pending` + `POST /output` (token-authed), `POST /machines/:id/panes/:paneId/output/request` + `GET …/output` (owner-authed) → `{lines,capturedAt}`/`{pending}`/`{shared:false}`; store latest; **purge on disable/forget**.
- **Web:** pane-output drawer — request → spinner → poll (or SSE) → **render ANSI safely** (allowlist SGR, strip OSC/other, escape markup); "output not shared" / masked states.
- **Tests:** unit (scrub hits/misses, ANSI-aware, ReDoS); BDD (request→delivered); **Playwright XSS test** (crafted output/command name does not execute); colored render; masked.
- **Done-when:** the drawer shows scrubbed colored output ~5 s after click; off → "output not shared".

## Phase 8 — Tiers, promo automation, homepage
**Goal:** redeem the homepage code → PRO for a month.
- **Backend** (`tiers/`, `promo/`): effective-tier resolution + lapse→free job; **promo cron every 2 weeks** (CSRNG `ZTF-…`, `durationDays 30`, `expiresAt +30 d`, `perAccountLimit 1`); `GET /promo/current` (public); `POST /promo/redeem` (owner, **strict rate-limit**, extend `tierExpiresAt` **capped `now+60 d`**, generic errors).
- **Web:** public **homepage** shows the current code; redeem field; account/tier page (defaults).
- **Tests:** unit (gen/redeem/cap/tier resolution); Playwright (homepage code visible; redeem→pro; capped).
- **Done-when:** self-serve PRO works; no admin needed.

## Phase 9 — Bots (Discord + Telegram, Python)
**Goal:** a pro user links Telegram/Discord and receives DMs; restart-safe.
- `packages/notify-protocol`: JSON-Schema → **Python (pydantic)** codegen + TS types; `protocolVersion`.
- **Backend:** `/internal/bots` **WS server** (per-bot `serviceSecret`); link-token mint (integrations page); `ChannelLink` (unique `(platform, platformUserId)`); route **pro** deliveries to the bot (idempotent `deliveryId`), queue while offline + flush on reconnect; `unlink_notice` → stale.
- `apps/discord-bot` (discord.py) + `apps/telegram-bot` (aiogram): outbound WS (`hello`+reconnect); `/link <token>` (Telegram `?start=`); `deliver`→DM→`delivery_result`; DM-privacy handling.
- **Web:** integrations page — Connect Discord/Telegram (mint token, show `/link` code / Telegram deep-link; linked/stale/reconnect).
- **Tests:** pytest (WS models, `/link`, dedup, reconnect); integration (backend↔fake-bot WS: link/deliver/ack/**replay**); Playwright (link flow, mocked).
- **Done-when:** pro chat delivery works and survives a bot restart.

## Phase 10 — Docs, Dockerfiles, CI/CD, security hardening
**Goal:** `docker compose up` yields a working stack; everything publishable; docs live.
- **Dockerfiles** per app (multi-stage, **non-root**, `HEALTHCHECK`, pinned base); backend entrypoint runs migrations; wire `deploy/` compose to real images; Caddy security headers/CSP (from `Caddyfile.example`).
- **CI/CD:** build+test all (cargo/vitest/pytest/Playwright); **image build+push → Docker Hub** (SemVer, multi-arch); **plugin release** (`zantiflow.wasm` + `.sha256` on GitHub Releases); **package publish** (Verdaccio → npm when ready, incl. the oauth hardening as the gate).
- **docs/** Starlight: scaffold (add to workspace), **migrate** `plugin-getting-started.md` → `src/content/docs/plugin/getting-started.mdx`, write sections (plugin/backend/dashboard/**privacy**/contributing/**what-ADRs-are**/donations); Pagefind; GitHub Pages deploy.
- **Hardening pass:** rate-limit numbers, `no-store`, trusted-proxy, secrets via env, image scan (Trivy); **re-run the `security-audit` skill against the code**; confirm all 7 audit findings implemented (safe render, JWKS, redirect-validation, sessionEpoch, headers/CSP, token-cap atomicity, secret-rotation).
- **Done-when:** compose stack healthy; CI green; docs build; images/plugin/packages publishable.

## Phase 11 — Minimise plugin update cadence (ADR-0026)
**Goal:** the plugin stops POSTing every second — it sends **only on change** (coalesced ~30 s idle / ~15 s watched), keepalives ~30 s while an attention is active, and learns "a dashboard is watching" from an always-on 5 s control poll. Notifications still fire within the ~2 min budget; ingest wire stays **v4**.
- **Protocol** (`packages/protocol/`): add `ControlRequest { machineId, liveSids[] }` + `ControlResponse { pendingOutput[], viewers{active,until?}, refreshSeq }` (new `control.ts` or extend `output.ts`) + JSON Schema; keep `OutputDelivery` unchanged.
- **Plugin** (`plugin.rs`, `snapshot.rs`, `net.rs`/`control.rs`): decouple a **wall-tick** counter from `capturedAtTick`/send-count (today `self.tick` increments inside `send_snapshot` and paces the poll); rewrite the `Event::Timer` arm into the **send FSM** — compute `dirty` vs a stored last-**sent** salient hash (tree + per-pane `contentFingerprint` + active-attention set, **excluding `capturedAtTick`**), pick mode from `viewers.active`, apply floors (30 s idle / 15 s watched) + ~2 s onset/structural bypass + ~30 s attention keepalive + cold-start (load, unwatched→watched) + `refreshSeq` force-send; unwatched-idle → send nothing. Replace `poll_output` with an **always-on `control_tick`** (`POST /control` with `machineId`+`liveSids`; parse `viewers`/`refreshSeq`/`pendingOutput`; act on `pendingOutput` only when `pane_output` on); add a `"control"` `WebRequestResult` kind.
- **Backend** (`control/`, `presence/`, edits to `sse/ machines/ http/`): new **`POST /api/v1/control`** (token plane) — verify machine ownership, **touch** `Machine.lastSeenAt` + `Snapshot.receivedAt` + `PaneActivity.updatedAt` for each `liveSid`, return `{pendingOutput,viewers,refreshSeq}` (share `pendingRequests` from `output/service.ts`). New in-process `presence/service.ts` (`lastViewerSeenAt` + per-machine `refreshSeq` + `isWatching(accountId)=countFor>0 || now-lastViewerSeenAt<45 s`). `sse/router.ts` bumps presence on subscribe + 25 s heartbeat; `machines/router.ts` bumps on `GET /`+`GET /:id` and adds `POST /:id/refresh` (rate-limited ≥5 s) → bump `refreshSeq` (+ optional fallback view-request route); mount control router in `http/router.ts`. **No read-logic change** (the 60 s filter stays and works via the control touch) and **no new sweeps** in `index.ts`; `schema.prisma` unchanged (presence + `refreshSeq` in-process, matching single-backend SSE).
- **Web** (`apps/web/`): machine-detail SSE open = presence for free; refresh button → `POST /machines/:id/refresh` (spinner ≤ one poll); when SSE is unavailable, POST the ~15 s fallback view-request.
- **Tests:** unit (plugin `dirty` excludes `capturedAtTick`; coalesce floors; watched/unwatched FSM; onset bypass; keepalive · backend control-touch + `isWatching` TTL/count); BDD (**idle unwatched → 0 ingest POSTs** over minutes, only 5 s polls; silent Claude pane ≥ threshold, no viewer → fires within threshold+keepalive; watched → updates within ~15 s; closed session ages out; quiet-live session stays visible); integration/real-MariaDB (`/control` stamps `lastSeenAt` + touches slices; 5-min-quiet session still reads; IDOR on `/control`+`/refresh`; control channel contract); Playwright (live under watched cadence; refresh; SSE + polling-fallback presence).
- **Done-when:** an idle unwatched machine sends no ingest POSTs (only the 5 s control poll), a silent Claude pane still fires a notification within ~2 min, and an open dashboard shows fresh data within ~15 s (or ≤5 s after the refresh button).

---

## Appendix A — Prisma schema (MariaDB)
```prisma
// provider = mysql (MariaDB). All PII/tenant rows scoped by accountId.
model Account {
  id            String   @id @default(cuid())
  oauthProvider String
  oauthId       String
  email         String?  @db.VarChar(320)
  name          String
  avatarUrl     String?  @db.VarChar(512)
  tier          String   @default("free")     // free | pro
  tierExpiresAt DateTime?
  sessionEpoch  Int      @default(0)           // bump = log-out-everywhere
  deletedAt     DateTime?
  createdAt     DateTime @default(now())
  @@unique([oauthProvider, oauthId])
}
model Token {                                   // ingest tokens (write-only)
  id           String   @id @default(cuid())
  accountId    String
  lookupPrefix String   @unique
  secretHash   String                           // SHA-256 of full secret
  label        String?
  expiresAt    DateTime?                         // null = infinite
  lastUsedAt   DateTime?
  revokedAt    DateTime?
  createdAt    DateTime @default(now())
  @@index([accountId])
}
model Machine {
  id          String   @id                       // plugin-generated machineId
  accountId   String
  displayName String?                            // may be <hidden>
  firstSeenAt DateTime @default(now())
  lastSeenAt  DateTime @default(now())
  @@index([accountId])
}
model Snapshot {                                 // latest only, per machine
  machineId     String   @id
  accountId     String
  version       Int
  capturedAtTick Int
  data          Json                             // machine + privacy + sessions tree
  receivedAt    DateTime @default(now())
  @@index([accountId])
}
model Attention {                                // current only (no history)
  id         String   @id @default(cuid())
  accountId  String
  machineId  String
  type       String
  targetKey  String                              // sid:tabId:paneId
  state      String                              // active | cleared
  activeSince DateTime
  lastFiredAt DateTime?
  updatedAt  DateTime @updatedAt
  @@unique([machineId, targetKey, type])
  @@index([accountId])
}
model PaneOutput {                               // latest only, on request
  id         String   @id @default(cuid())
  accountId  String
  machineId  String
  paneKey    String                              // sid:tabId:paneId
  lines      Json                                // ANSI-colored, scrubbed
  capturedAt DateTime
  @@unique([machineId, paneKey])
  @@index([accountId])
}
model OutputRequest {
  id         String   @id @default(cuid())
  accountId  String
  machineId  String
  paneKey    String
  status     String   @default("pending")        // pending | fulfilled | expired
  requestedAt DateTime @default(now())
  @@index([machineId, status])
}
model PushSubscription {
  id        String   @id @default(cuid())
  accountId String
  endpoint  String   @db.VarChar(512)
  p256dh    String
  auth      String
  createdAt DateTime @default(now())
  @@index([accountId])
}
model NotificationSettings { accountId String @id  config Json }
model Notification {
  id        String   @id @default(cuid())
  accountId String
  source    Json                                 // {type, target}
  text      String   @db.Text
  createdAt DateTime @default(now())
  @@index([accountId])
}
model NotificationDelivery {
  id          String   @id @default(cuid())
  notificationId String
  accountId   String
  channel     String                             // webpush | discord | telegram
  recipientRef String
  status      String   @default("pending")        // pending|delivered|failed|expired
  attempts    Int      @default(0)
  deliveryId  String   @unique                     // idempotency
  dispatchedAt DateTime?
  ackedAt     DateTime?
  lastError   String?
  createdAt   DateTime @default(now())
  @@index([channel, status])
  @@index([status, createdAt])
}
model ChannelLink {
  id             String  @id @default(cuid())
  accountId      String
  platform       String                           // discord | telegram
  platformUserId String
  platformUsername String?
  status         String  @default("active")        // active | stale | revoked
  linkedAt       DateTime @default(now())
  @@unique([platform, platformUserId])
  @@index([accountId, platform])
}
model LinkToken {
  tokenHash String   @id
  accountId String
  platform  String
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime @default(now())
}
model PairingSession {
  id           String   @id                        // sessionId (unguessable)
  userCodeHash String   @unique
  status       String   @default("pending")         // pending|approved|consumed|expired|denied
  accountId    String?
  issuedTokenId String?
  machineHint  String?
  createdAt    DateTime @default(now())
  expiresAt    DateTime
  lastPolledAt DateTime?
}
model PromoCode {
  code         String   @id                        // ZTF-XXXXXXXX (CSRNG)
  grantsTier   String   @default("pro")
  durationDays Int      @default(30)
  maxRedemptions Int?                               // null = unlimited
  perAccountLimit Int   @default(1)
  expiresAt    DateTime
  createdBy    String   @default("auto")
  createdAt    DateTime @default(now())
}
model PromoRedemption {
  id        String   @id @default(cuid())
  code      String
  accountId String
  redeemedAt DateTime @default(now())
  @@unique([code, accountId])
}
```

## Appendix B — Protocol & API contracts
**Wire contract v4 (ingest body)** — `POST /api/v1/ingest`, `Authorization: Bearer ztf_…`:
```jsonc
{ "version": 4, "machineId": "m-…", "capturedAtTick": 42,
  "privacy": { "full": true, "machine": "alias", "sessionNames": "send", "tabNames": "send", "paneNames": "hidden" },
  "machine": { "source": "alias", "name": "red-laptop" },
  "attentions": [ { "type": "claude.needs-input", "target": {"sessionSid":"s…","tabId":0,"paneId":1}, "state": "active", "since": 40 } ],
  "sessions": [ { "sid":"s…","name":"main","isCurrent":true,"state":"live","diedSecondsAgo":null,
    "tabs":[ {"tabId":0,"name":"editor","position":0,"active":true,
      "panes":[ {"id":1,"name":null,"command":null,"isFocused":true,"exited":false,"contentFingerprint":"a1b2"} ] } ] } ] }
```
Backend: validate `version` in `[MIN..4]`, ignore unknown fields, reject unknown-newer → `400`; bound array lengths + nesting.

**Output channel (separate; ADR-0016):**
- plugin `GET /api/v1/output/pending` → `{ requests:[{machineId,sessionSid?,tabId?,paneId}] }`
- plugin `POST /api/v1/output` → `{ machineId, paneId, lines:string[]≤50 (ANSI), capturedAt }`
- web `POST /api/v1/machines/:machineId/panes/:paneId/output/request` → `202`
- web `GET  /api/v1/machines/:machineId/panes/:paneId/output` → `{lines,capturedAt}` | `{pending:true}` | `{shared:false}`

**Read/management API** (owner session): `GET /machines`, `GET /machines/:id`, `GET /attentions`, `DELETE /machines/:id`, `GET /stream` (SSE `machine.update`/`attention.update`), `GET|POST|DELETE /tokens`, `GET /auth/me`, `POST /auth/logout|logout-all`, `POST /pair/*`, `GET /promo/current` (public), `POST /promo/redeem`, notification prefs, channel-link mint.

**Bot↔backend WS (`/internal/bots`; ADR-0007/0010):** bot→ `hello{platform,serviceSecret,version}` · `link_request{platform,platformUserId,platformUsername?,token}` · `delivery_result{deliveryId,status,error?}` · `unlink_notice{platform,platformUserId,reason}`; backend→ `hello_ack{ok}` · `deliver{deliveryId,platformUserId,text}` · `link_result{token,ok,accountLabel?,error?}`.

## Appendix C — Concrete defaults
- **Rate limits (token-bucket, `429`+`Retry-After`):** ingest ~2/s burst 10 per (token); auth/login 10/min per IP; read-API 60/min + **SSE ≤5 concurrent** per account; **promo redeem 5/hour** per account; pair-code entry 5/10min.
- **Scrub ruleset (starter; ADR-0017, ANSI-aware, anchored/bounded):** `ztf_[A-Za-z0-9]{20,}`, `gh[pousr]_[A-Za-z0-9]{20,}`, `xox[baprs]-[A-Za-z0-9-]+`, `sk_live_[A-Za-z0-9]+`, `sk-[A-Za-z0-9]{20,}`, `AKIA[0-9A-Z]{16}`, `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+` (JWT), `-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END`, `(?i)(password|secret|token|api[_-]?key)\s*[:=]\s*\S+`, `[a-z]+://[^:@\s]+:[^@\s]+@` (conn-string creds). Mask → `«redacted»`. User patterns appended. Scanned-bytes cap (last ~16 KB).
- **Env:** see `deploy/.env.example`. Plugin config keys: `token|pairing`, `server_url`, `full`, `machine_name`, `session_names`, `tab_names`, `pane_names`, `pane_output`, `pane_output_scrub`, attention params.
- **Timings:** ingest **change-driven (ADR-0026)** — coalesced ~30 s idle / ~15 s watched, ~2 s onset/structural bypass, ~30 s keepalive while an attention is active, unwatched-idle → nothing; control/output poll ~5 s (always-on; touches liveness); **presence TTL 45 s**; **refresh min-gap 5 s**; attention thresholds 5 min free / 1 min pro; staleness/read-filter 60 s; session 14 d; notif retention 6 h; pairing/link tokens ~10 min; promo 2-week gen / 30-day validity / 60-day cap.

## Appendix D — Module taxonomy (ADR-0015)
- **backend/src:** `http auth tokens pairing machines ingest output attentions notifications delivery channels promo tiers sse db ratelimit config log`.
- **plugin/src:** `host`(HostPort) `config privacy snapshot fingerprint attentions pairing output scrub net`.
- **web/src:** `app`(routes) `components` `lib/api` `lib/sse` `lib/push` `features/{machines,panes,tokens,notifications,integrations,promo}` + safe `ansi` renderer.
- **bots:** shared `notify-protocol` (WS client + models); each bot: `ws link deliver platform`.

---

## Deferred / out of scope (build to sensible defaults; ADR-0019)
Settings/integrations/account/pairing **page visual design**; notification digest/grouping; dense-tree responsive layout; onboarding copy; detailed a11y/i18n; metrics stack; Redis/horizontal scaling; release signing; Homebrew/AUR. **Bots (Phase 9) are the pro-chat track** — web-push works without them.

## Definition of done (whole)
`docker compose up` → sign in with Google → pair a plugin from a real Zellij → live dashboard →
attention fires → web-push notification → click a pane → scrubbed colored output → redeem the homepage
promo → PRO → (pro) link a bot → DM. All four test layers green; the 7 security-audit findings
implemented; docs site builds; images/plugin/packages publishable.
