# ADR-0040 — Web-tier testing: pure-logic units (no jsdom) + Playwright against a network-mocked backend

- **Status:** Accepted (implemented)
- **Implements / specialises:** [ADR-0014](0014-testing-strategy.md) — the four-layer strategy, applied to `apps/web`, with one deliberate deviation (no real MariaDB here)
- **Relates to:** [ADR-0015](0015-modular-code-organization.md) (why the view logic is extracted into pure modules), [ADR-0008](0008-status-website-dashboard.md) (the SSE stream these tests must exercise)
- **Date:** 2026-07-12
- **Deciders:** project owner
- **Tags:** web, testing, playwright, vitest, mocking, sse

> **Retroactive ADR:** This decision was already implemented in the codebase before this ADR was written; it is recorded here after the fact to close a documentation gap — it was not written at the right time.

## Context

ADR-0014 sets the repo-wide testing strategy: four layers (unit / BDD / integration / Playwright),
externals mocked behind ports, **MariaDB real via testcontainers**, "test at every step". That ADR is
written from the backend's point of view — its "externals" are Zellij, Google, web-push, and the
chat bots, and its database is real.

For `apps/web`, the picture inverts. The web tier's single "external" is **the backend itself**. The
web app is mostly view logic over the read API plus one always-open **SSE** live stream. Standing up
the real backend + MariaDB + Google OAuth just to render the dashboard in a test would be heavy,
slow, and largely **duplicative** — the backend already owns real-MariaDB integration tests for that
contract (ADR-0014). It also collides with a practical constraint on the dev machine: `next build`
into the default `.next` while `next dev` is running corrupts the running dev server, and a PWA
service worker that has claimed the page will swallow mocked network calls.

So the web needed a testing approach of its own that ADR-0014 does not spell out: fast, hermetic,
dependency-free, exercising the *real* Next frontend (including SSE, which `supertest` cannot hold
open), without a DB or Google and without disturbing the developer's live servers.

## Decision Drivers

- **Speed + determinism + hermeticity** — web tests should need no DB, no Google, no network.
- **Exercise the real frontend** — including the SSE stream and the full server-render → hydrate path,
  not just isolated functions.
- **No duplicate coverage** — the web↔backend *contract* is the backend's job to integration-test;
  the web tests own the web's own behaviour.
- **Don't disrupt the running dev environment** — a concurrent `next dev` and a PWA service worker
  must not be collateral damage.

## Considered Options

1. **Real backend + MariaDB (testcontainers) behind the web e2e**, mirroring ADR-0014's default.
   Rejected: heavy and duplicative for a read-only consumer; re-tests a contract the backend already
   covers; still needs Google mocked.
2. **In-page request mocking with MSW / a mock service worker.** Rejected here: the app ships its own
   PWA service worker, and a second SW muddies exactly the layer under test (and the app's real SW has
   to be *blocked*, not competed with — see below).
3. **Two-part web-native approach — pure-logic units in a Node vitest env + Playwright driving the
   real frontend with the backend mocked at the browser network layer. — CHOSEN.**

## Decision

### 1. Unit / component layer — pure logic, Node env, no jsdom

`apps/web/vitest.config.ts` runs with **`environment: 'node'`** (no jsdom). Components are exercised
by server-rendering them to a string with `renderToStaticMarkup` and asserting on the HTML
(`apps/web/test/dashboard.test.tsx`), and the app's **view logic is extracted into pure, React-free,
node-safe modules** so it unit-tests directly: `lib/machineView.ts` (sort / Claude filter / marker),
`lib/spotlight.ts` (album reducer), `lib/format.ts`, `lib/attn.ts`, `lib/ansi.tsx`. This is a
concrete reason those modules are pure (ADR-0015): each has a co-located unit test
(`test/machineView.test.ts`, `test/spotlight.test.ts`, `test/format.test.ts`, `test/attn.test.ts`,
`test/ansi.test.tsx`), and `lib/api.ts` is tested by stubbing `fetch` (`test/api.test.ts`) rather than
a running server.

### 2. E2E layer — Playwright drives the real frontend, backend mocked at the network layer

`apps/web/e2e` uses Playwright against the **real** Next app but mocks the entire same-origin
`/api/v1/**` backend at the **browser's network layer**: `e2e/mock.ts` installs a `page.route`
handler that fulfils requests *before they leave the page*, so the Next `/api/v1` → backend rewrite
is bypassed entirely — **no backend, DB, or Google**. A mutable `MockState` (`e2e/fixtures.ts`) is
read fresh on every call so a spec can mutate it mid-run to drive live updates, and the **SSE stream
is served as a canned `text/event-stream` body** with a short `retry:` so EventSource reconnects and
re-delivers — exercising the very live-refresh path `supertest` can't.

The Playwright config (`playwright.config.ts`) pins the operational decisions:

- **Runs against a production build** (`next start` on a dedicated port, default **3100**), because
  that is what ships and it's deterministic; `test:e2e` runs `next build` first, and an already-running
  server on the port is reused.
- **Isolated build output** — `next.config.mjs` honours `NEXT_DIST_DIR` (default `.next`), so the e2e
  build can target `.next-e2e` and **never clobber a concurrent `next dev`'s `.next`**.
- **Service workers are blocked** (`use.serviceWorkers: 'block'`) — the app's real `/sw.js` calls
  `clients.claim()` and has a `fetch` handler, which would otherwise swallow the mocked fetches and
  leave the UI stuck on "Loading…". No spec here exercises the SW; PWA behaviour is out of scope for
  this layer.

## Consequences

- **Positive:** web tests are fast, hermetic, and need no DB/Google/network; they still drive the real
  Next frontend end-to-end, including SSE and the full render path; they don't disturb a running dev
  server; specs can script live updates by mutating `MockState`.
- **Negative:** the backend is **mocked**, so a genuine web↔backend contract mismatch is not caught at
  this layer — coverage of that leans on the mirrored types being kept in sync (see the web
  no-`@zantiflow`-dependency ADR) and on the backend's own integration tests. The prod-build
  requirement also means `next build` must run before e2e (a slower first pass).
- **Neutral:** this is a scoped **specialisation of ADR-0014** for the web tier — it keeps the
  four-layer spirit and the "test every feature" rule, but drops the "real MariaDB" default precisely
  because the web has no database and its DB-bearing external is tested elsewhere.

## Open Questions / Risks

- **Mock ↔ real-backend drift** — the `page.route` handler encodes the read API's shapes/status codes;
  if the backend changes them, the mock can lie. Mitigated by keeping the mock aligned with the
  mirrored `lib/types.ts` and by backend integration tests, but there is no automated contract check
  spanning the two tiers.
- **The PWA service worker is untested by e2e** (deliberately blocked). Any offline/caching regression
  in `public/sw.js` would need its own coverage.

## References

- `apps/web/vitest.config.ts` — Node env, `@` alias, JSX automatic runtime.
- `apps/web/test/*` — `renderToStaticMarkup` component tests + pure-module unit tests.
- `apps/web/playwright.config.ts` — prod build, port 3100, `serviceWorkers: 'block'`, reuse-existing.
- `apps/web/e2e/mock.ts` + `e2e/fixtures.ts` — network-layer backend mock + mutable state + canned SSE.
- `apps/web/next.config.mjs` — `NEXT_DIST_DIR` build-output isolation.
- ADR-0014 (testing strategy), ADR-0015 (pure-module extraction).
