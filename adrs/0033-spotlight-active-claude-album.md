# ADR-0033 — Spotlight: a PRO-only live album of active Claude sessions

- **Status:** Accepted
- **Amends:** [ADR-0016](0016-dashboard-page-and-pane-output.md) — adds a second read surface alongside the
  dashboard, reusing its pane-output channel and the tier-gated auto-refresh loop. Presentation was
  deferred by [ADR-0019](0019-ux-decisions-deferred.md); this is a net-new page built to sensible defaults.
- **Date:** 2026-07-12
- **Deciders:** project owner
- **Tags:** web, backend, dashboard, pane-output, tiers
- **Testing:** shared detector — `packages/protocol/test/claude.test.ts` (mirrors `machineView.test.ts`).
  Web — `apps/web/test/spotlight.test.ts` (album reducer: add / complete-on-vanish / preserve last frame
  / clear / count) and a `getSpotlight` case in `api.test.ts`. Backend —
  `apps/backend/test/spotlight.integration.test.ts` (testcontainers MariaDB): PRO `200` with active-only
  filtering (excludes exited/non-Claude panes, resurrectable sessions, stale machines), non-PRO
  `403 requires_pro`, `401` without a session, and cross-tenant isolation. See
  [ADR-0014](0014-testing-strategy.md).
- **Wire contract:** unchanged (**v4**). No plugin/ingest change — Spotlight is composed from existing
  owner-plane reads.

## Context

Owners running Claude across many machines/panes want one focused, live view of **every active Claude
session at once** — not the whole machine tree — flipped through like an album of photos, each showing
that Claude's live-updating terminal output. This is a natural PRO perk built entirely on capabilities
that already exist: the account-scoped machine reads, the SSE live stream (ADR-0008), and the on-demand
pane-output channel with its tier-gated auto-refresh loop (ADR-0016).

"Active" is not a stored concept — the backend derives it. The owner chose the **lifecycle** meaning:
a pane is active while it is *running*, not only while it is "thinking".

## Decision

1. **`/spotlight` page (web) — PRO-only.** A client page that fetches a roster, subscribes to the SSE
   stream, and renders a carousel (‹/›, ←/→ keys, position counter, dot strip) of one "photo" per active
   Claude session. Header shows `Spotlight (N)` (active count); with zero active it explains the view
   only works while Claude sessions are running. The nav link is shown only to PRO accounts.

2. **`GET /api/v1/spotlight` — the first hard PRO gate.** Owner-session-gated **and** PRO-gated: a new
   `requirePro` middleware returns a distinct **`403 requires_pro`** (not the generic `forbidden`) so the
   client can show an upgrade prompt. Everywhere else tier only *modulates* behaviour; this route PRO
   fully gates. It returns `{ activeCount, sessions[] }` — one entry per active Claude pane across **all**
   the account's machines, keyed by `machineId:sid:tabId:paneId`. The endpoint marks viewer presence
   (ADR-0026), so an open Spotlight keeps idle-but-running Claudes reporting instead of aging out.

3. **"Active" = running (not exited).** A pane in a **live** session that is `!exited` and is detected as
   Claude. It becomes **completed** when it exits, its session dies, or its machine goes offline — all of
   which surface as "was in the roster, now absent". The **backend is stateless** (returns only the
   currently-active roster); the client tracks completed entries by **diffing successive rosters**
   (`reconcileAlbum`), keeping them (greyed) until the owner clicks **"Clear sessions that completed"**.
   New Claude sessions appear on their own as the ~1 s SSE pings drive a throttled roster refetch.

4. **Stream only the on-screen photo.** The album mounts only the current photo, so exactly **one**
   session streams output at a time via the shared pane-output loop (extracted into
   `usePaneOutputStream`, now used by both the drawer and Spotlight). Flipping away freezes that photo's
   last frame (persisted to page state via an `onFrame` callback) so re-visiting — or a completed
   session — shows the last thing it printed. Since Spotlight is PRO, the loop never hits the FREE pause.

5. **Reliable Claude detection, shared for the backend.** The roster must use the **pane-NAME marker**
   (`✳` idle / Braille spinner thinking), not the command (often `null`). That detector is promoted to
   `@zantiflow/protocol` (`claude.ts`: `isClaudePane`, `hasClaudeMarker`, `isThinkingMarker`) for the
   backend. The **web keeps its own copy** in `lib/machineView` — it deliberately carries **no
   `@zantiflow/*` dependency** (protocol is CJS + zod and would bloat the browser bundle) — and the two
   copies are pinned together by their mirrored test suites.

## Consequences

**Positive**
- A focused, live, cross-machine view of everything Claude is doing, with real streaming output — reusing
  the dashboard's data flow, the pane-output channel, and the ANSI renderer (no new plugin/wire work).
- True PRO enforcement: non-PRO get `403` even calling the API directly, not just a hidden link.
- Efficient: one live output stream at a time (album), roster refetch throttled to ~1 s regardless of how
  many machines ping.

**Negative / costs**
- The Claude detector now has two copies (protocol for the backend, `machineView` for the web) kept in
  sync by tests, rather than one shared module — the price of the web's zero-dependency bundle policy.
- An idle-but-running Claude relies on presence keeping its machine reporting; if Spotlight is closed and
  the machine idles (ADR-0026), its next open may take a few seconds to repopulate that session.

**Neutral**
- No wire/schema change. "Completed" is a client-only notion; the backend stays stateless.

## References

- [ADR-0016](0016-dashboard-page-and-pane-output.md) — dashboard + the pane-output channel this reuses.
- [ADR-0008](0008-status-website-and-read-api.md) — the tenant-scoped read API + SSE live stream.
- [ADR-0011](0011-tiers-and-monetization.md) — tiers; Spotlight is the first hard PRO gate.
- [ADR-0015](0015-modular-code-organization.md) — the package-promotion rule behind the shared detector.
- [ADR-0025](0025-claude-thinking-attention.md) — the `✳`/Braille marker split the detection keys on.
