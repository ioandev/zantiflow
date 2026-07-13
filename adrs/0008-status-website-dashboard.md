# ADR-0008 — Status website: the account dashboard, read API, and live updates

- **Status:** Accepted
- **Implemented by:** [ADR-0016](0016-dashboard-page-and-pane-output.md) — the concrete dashboard (per the vendored design) + pane-output capture (a **separate on-demand channel**; ingest contract unchanged, v4)
- **Builds on:** [ADR-0001](0001-zellij-session-telemetry-architecture.md) (tree/ordering/activity), [ADR-0002](0002-configurable-telemetry-privacy-controls.md) (privacy), [ADR-0003](0003-multi-tenant-backend-and-token-auth.md) (accounts/machines/tokens), [ADR-0004](0004-google-auth-owner-sign-in.md) (owner auth), [ADR-0005](0005-attentions-detection-and-triggering.md) (attentions/staleness), [ADR-0006](0006-notifications-web-push-and-channels.md) (PWA/notifications), [ADR-0007](0007-chat-bot-notification-channels.md) (channel links)
- **Date:** 2026-07-10
- **Deciders:** project owner
- **Tags:** website, dashboard, read-api, sse, pwa, tier
- **Testing:** Playwright (dashboard, SSE live update, `<hidden>`) + integration (read API + MariaDB) — see [ADR-0014](0014-testing-strategy.md)
- **Wire contract:** plugin↔backend (v4) unchanged; formalizes the **read API** + a browser **SSE** stream

## Context

This is the user-facing piece referenced since ADR-0003 ("the website / read API / a later ADR"). A
logged-in owner needs to **see everything** for their account — machines → sessions → tabs → panes,
live, with attention states (needs-input, thinking, stopped/detached) — and to manage tokens
(ADR-0003), notification preferences (ADR-0006), and channel links (ADR-0007), all in one place.

ADR-0006 already introduced the **PWA shell** (for push + notification settings). This ADR **expands
that same PWA** into the full dashboard and defines the **read API** it consumes and **how live
updates reach the browser**.

## Decision Drivers

- **One cohesive PWA** — the settings/push surface (ADR-0006) and the status dashboard are the same
  app, so push/install already work.
- Show **live** per-account status across machines, **honoring privacy** (ADR-0002: hidden names
  render `<hidden>`; the site can never reveal what the plugin redacted).
- Reuse **owner auth** (ADR-0004 cookie session); every read is **tenant-scoped**.
- **Near-real-time** without per-client polling storms.
- **Tier-aware** UI (free vs pro). **Self-host** friendly (same app).

## Considered Options

- **Framework:** **Next.js (React)** *(chosen)* — matches `@zantiflow/oauth-react`, the commenttoday
  precedent, first-class PWA/routing; vs a plain React SPA or SvelteKit.
- **Live updates:** **SSE** (server-sent events) *(chosen)* — one-way live push over HTTP, rides the
  session cookie, auto-reconnects, cheap; vs WebSocket (bidirectional, unneeded — the browser only
  reads), vs short polling (wasteful at ~1s). **Polling fallback** where SSE is unavailable.
- **Retention** (resolves ADR-0003's open question): **latest state only — no history retained**
  *(chosen, per owner)*; the dashboard is a **live view** (no rolling activity-feed store, no per-pane
  timelines).

## Decision

### 1. The app

Extend the ADR-0006 PWA into a **Next.js** dashboard (`apps/web`), authenticated by the ADR-0004
`ztf_session` cookie (redirect + cookie login; `@zantiflow/oauth-react` popup only if ever needed).
Routes: **overview** (machines), **machine detail** (live sessions→tabs→panes tree), **tokens**
(ADR-0003), **notifications** (ADR-0006), **integrations** (channel linking, ADR-0007),
**account/tier**.

### 2. Read API (backend, `/api/v1`, owner-session-gated, tenant-scoped)

- `GET /machines` — machines: id, `displayName` (or `<hidden>`), `lastSeenAt`, online/stale (ADR-0005
  staleness), counts.
- `GET /machines/:machineId` — latest snapshot tree (v4 data: sessions→tabs→panes, privacy-honored) +
  current attentions.
- `GET /attentions` — the **currently-active** attentions across the account (no history).
- `DELETE /machines/:machineId` — forget a machine (foreshadowed in ADR-0003).
- `GET /stream` — **SSE**: account-scoped live push of snapshot/attention changes.
- Plus the already-specified surfaces: tokens (ADR-0003), notification prefs (ADR-0006), channel links
  + link-token mint (ADR-0007), `/auth/me` (ADR-0004).

### 3. Live updates (SSE)

`GET /api/v1/stream` — account-scoped via the session cookie; the backend emits an event when a
machine's snapshot or attentions change (driven by ingest). The browser uses `EventSource`
(auto-reconnect) and re-renders; **polling fallback** if SSE is blocked. Near-real-time (~1s) without
per-client polling.

### 4. What's displayed

Machines (online/stale), each expandable to sessions in ADR-0001 order (**current → other live →
stopped/detached**) → tabs → panes, with names (or `<hidden>`), per-pane last-activity (`Unknown`
until observed, ADR-0001), and **attention badges** (needs-input / thinking / stopped / detached).
**Only currently-active attentions are shown — there is no historical feed.** Plus the token /
notification / integration settings surfaces.

### 5. Privacy

The site renders exactly what the backend stored under the account's privacy config (ADR-0002) — it
**cannot reveal** what the plugin redacted; hidden names show `<hidden>`, machine names follow
real/alias/hidden.

### 6. Retention — none (live / latest only)

**No history is retained.** The backend stores only the **latest snapshot per machine** and each
pane's **latest output** (ADR-0016). Attentions are shown **as currently active** — episode timing is
transient (for firing triggers only, ADR-0005), not a stored history. No rolling activity feed, no
per-pane timelines. The dashboard is a **live view**. *(Resolves ADR-0003's retention question:
**none**.)*

### 7. Tier in the UI

Free: core live status, web-push settings, a limited option set. Pro: Discord/Telegram integration
UI, faster attention thresholds (ADR-0005), the full notification option set. Upsell surfaces where a
feature is gated.

### 8. PWA & deploy

Same installable PWA as ADR-0006 (manifest, service worker, install nudges, push) — dashboard +
settings in one app. Deployed alongside the backend; the web origin **proxies `/api/v1` → backend**
(the redirect-URI origin from ADR-0004). Self-host: the same app.

## Consequences

**Positive**
- Completes the product loop: see everything + manage tokens/notifications/integrations in **one PWA**.
- SSE delivers live status cheaply; reuses auth/privacy/tier; the push/install work from ADR-0006 is
  already there.
- Self-host friendly (one app).

**Negative / costs**
- SSE fan-out + backend event plumbing (emit on ingest/attention change) to build and scale.
- A full frontend app to build and maintain; tier-gating complexity; live-tree render perf with many
  machines/panes. *(No history store — latest state only — so no growth there.)*

**Neutral**
- Formalizes the read API referenced since ADR-0003 and **resolves its retention question** at
  **none — latest state only**. No plugin/wire-contract change.

## Open Questions / Risks

1. **SSE scaling** across multiple backend instances needs per-account pub/sub (e.g. Redis) — v1
   assumes single-backend; flag. **Decided:** no Redis — single backend; revisit with a non-Redis approach only if ever needed.
2. **History depth/retention** exact windows + storage cost; per-pane timelines deferred. **Decided:** **no history retained** (latest state only); per-pane timelines out of scope.
3. **Mobile PWA UX** for dense session trees — responsive/summarized views. **(decided: deferred to ADR-0019 (with the design).)**
4. Which attentions surface as **badges vs feed** — **resolved: badges only — no history feed (ADR-0019).**
5. **Rate-limiting** the read API and SSE connections per account. **Decided:** yes — per-account SSE connection cap + read-API rate limits.
6. Showing **other live sessions'** full trees vs summaries — deferred to ADR-0019. **(decided.)**

## References

- ADR-0001–0007 (this ADR consumes all of them)
- Server-Sent Events (`EventSource`); Next.js PWA
- Resolves ADR-0003's retention open question; consumes the ADR-0005 attention model and ADR-0006/0007
  settings surfaces
