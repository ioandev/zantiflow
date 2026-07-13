# ADR-0039 — The web app takes no `@zantiflow/*` dependency: hand-mirror the protocol, pin with tests

- **Status:** Accepted (implemented)
- **Relates to:** [ADR-0015](0015-modular-code-organization.md) (the package-promotion rule this deliberately does *not* apply to the browser bundle), [ADR-0008](0008-status-website-dashboard.md) / [ADR-0016](0016-dashboard-page-and-pane-output.md) (the read-API shapes being mirrored), [ADR-0033](0033-spotlight-active-claude-album.md) (promotes the Claude-pane detector into `@zantiflow/protocol`; the web keeps a test-pinned copy)
- **Date:** 2026-07-12
- **Deciders:** project owner
- **Tags:** web, dashboard, packaging, bundle-size, protocol, wire-contract
- **Testing:** `apps/web/test/machineView.test.ts`, `apps/web/test/dashboard.test.tsx`, `apps/web/test/api.test.ts`, `apps/web/test/spotlight.test.ts` — see [ADR-0014](0014-testing-strategy.md)

> **Retroactive ADR:** This decision was already implemented in the codebase before this ADR was written; it is recorded here after the fact to close a documentation gap — it was not written at the right time.

## Context

The monorepo publishes shared `@zantiflow/*` packages, and ADR-0015 sets a **promotion rule**: code
reused across ≥2 apps, publishable, or with a stable versioned API should be extracted into a package
rather than duplicated. The wire-v4 snapshot types and the reliable Claude-pane detector are exactly
that kind of reusable protocol code — the backend consumes them from `@zantiflow/protocol` (ADR-0033
promoted the detector there for the Spotlight roster).

The obvious next step would be for `apps/web` (the Next.js PWA dashboard) to `import` those same
shapes and that same detector from `@zantiflow/protocol`, so the browser and the backend agree on the
contract by construction. That import was deliberately **not** taken.

`@zantiflow/protocol` is a CJS package that pulls in `zod` for runtime validation. The backend wants
that (it validates untrusted ingest payloads); the browser does not — the web only ever **reads** a
narrow, already-validated subset of the backend's read API and renders it. Importing the package would
ship `zod` + the CJS interop shims into the client bundle for zero runtime benefit, and would couple
the web build to the package build graph. The concrete evidence sits in
`apps/web/lib/machineView.ts`: *"the web can't depend on protocol — it's CJS+zod and would bloat the
browser bundle."*

## Decision Drivers

- **Client bundle weight** — nothing ships to the browser that the browser doesn't need at runtime;
  the web validates nothing (the backend already did).
- **Read-only, narrow surface** — the dashboard renders a strict subset of the read API, not the full
  ingest contract, so it needs a handful of shapes, not the whole schema module.
- **Build independence** — the web image should build without first building the TS package graph.
- **Correctness under duplication** — a hand-mirror risks silent drift from the canonical protocol,
  which must be actively mitigated.

## Considered Options

1. **`import` the shapes + detector from `@zantiflow/protocol`** — one source of truth, zero drift.
   Rejected: drags `zod` + CJS into the client bundle and couples the web build to the package graph
   for a read-only consumer that needs no validation.
2. **Extract a second, browser-only "slim types" package** (`@zantiflow/protocol-web` or similar).
   Rejected as over-packaging (ADR-0015 warns against it): the web needs a dozen interfaces and one
   ~40-line detector — a whole published package for that is more ceremony than it's worth, and it
   still has to be kept in sync with the canonical one.
3. **Hand-mirror the needed shapes + logic inside `apps/web/lib`, take no `@zantiflow/*` dep at all,
   and pin the mirror with tests. — CHOSEN.**

## Decision

`apps/web` carries **zero `@zantiflow/*` dependencies**. `apps/web/package.json` lists only `next`,
`react`, and `react-dom` (plus dev tooling); there are no workspace protocol/oauth imports in the app
source.

- **Read-API / wire-v4 shapes are hand-mirrored** in `apps/web/lib/types.ts` — `MachineSummary`,
  `MachineDetail`, `WireSnapshot`/`WireSession`/`WireTab`/`WirePane`, `AttentionView`,
  `SpotlightSession`, `TokenMeta`, `Me`, etc. It is intentionally a **subset** ("Kept minimal — the
  dashboard only reads") of the backend contract, not a full copy.
- **The Claude-pane detector is re-implemented** in `apps/web/lib/machineView.ts` (`isClaudePane`,
  `hasClaudeMarker`, `paneDisplayName`, and the `✳` sparkle / Braille-spinner marker constants). Its
  header comment records that the backend keeps a matching copy in `@zantiflow/protocol`'s `claude.ts`
  and that **"the two are pinned by their test suites"** — the web copy by
  `apps/web/test/machineView.test.ts` + `apps/web/test/dashboard.test.tsx`, the protocol copy by
  `packages/protocol/test/claude.test.ts` (per ADR-0033). Neither imports the other; they are kept in
  agreement by shared expectations, not a shared module.
- **The e2e fixtures preserve the independence** — `apps/web/e2e/fixtures.ts` imports the mirrored
  types via **relative** paths (`../lib/types`) rather than the `@/` alias, keeping the test corpus
  free of app-internal wiring and, transitively, of any package dependency.

## Consequences

- **Positive:** the client bundle carries no `zod`/CJS protocol code; the web builds independently of
  the TS package graph; the mirror is a deliberately small read-only surface, easy to audit.
- **Negative:** the protocol shapes and the Claude detector now exist in **two** places (web +
  `@zantiflow/protocol`), so a wire-contract change can drift if only one side is updated. This is a
  real cost, mitigated — not eliminated — by (a) parallel test suites on both copies, (b) cross-
  referencing code comments on both sides, and (c) the mirror being read-only and small.
- **Neutral:** this is a conscious, scoped exception to ADR-0015's promotion rule — packaging is the
  default *except* where shipping the package to the browser would cost more than the duplication.

## Open Questions / Risks

- **Drift risk** if the wire contract evolves (v4 → future) and only the backend/protocol copy is
  updated. Today's mitigation is the twin test suites + comments; a stronger future option is a
  build-time codegen step that emits browser-safe types from the canonical schema (no `zod` at
  runtime), which would restore a single source of truth without the bundle cost.
- Because the mirror is a subset, a newly-added read-API field is simply invisible to the dashboard
  until someone extends `lib/types.ts` — a quiet failure mode rather than a build error.

## References

- `apps/web/package.json` — dependency set (no `@zantiflow/*`).
- `apps/web/lib/types.ts` — the mirrored read-API / wire-v4 shapes.
- `apps/web/lib/machineView.ts` — the mirrored Claude-pane detector + the "pinned by their test
  suites" / "CJS+zod would bloat the browser bundle" rationale.
- `apps/web/e2e/fixtures.ts` — relative-import independence.
- ADR-0015 (modular code organization / promotion rule), ADR-0033 (protocol-side detector).
