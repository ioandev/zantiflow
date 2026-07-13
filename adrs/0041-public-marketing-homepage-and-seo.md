# ADR-0041 — Public marketing homepage at `/` + SEO / social-card infrastructure

- **Status:** Accepted (implemented)
- **Relates to:** [ADR-0019](0019-ux-decisions-deferred.md) (presentation beyond the vendored dashboard is deferred — the marketing surface is built to sensible defaults + `HOMEPAGE.md`), [ADR-0004](0004-google-auth-owner-sign-in.md) (the sign-in CTA target), [ADR-0023](0023-documentation-site-starlight.md) (outbound docs links), [ADR-0021](0021-dockerization-and-deployment.md) (self-contained OG images for the standalone image)
- **Date:** 2026-07-12
- **Deciders:** project owner
- **Tags:** web, marketing, seo, open-graph, pwa, ui
- **Testing:** `apps/web/e2e/landing.spec.ts` (Playwright) — see [ADR-0014](0014-testing-strategy.md)

> **Retroactive ADR:** This decision was already implemented in the codebase before this ADR was written; it is recorded here after the fact to close a documentation gap — it was not written at the right time.

## Context

The zantiflow ADRs decide the **product**: the dashboard (ADR-0008/0016), Spotlight (ADR-0033),
notifications (ADR-0006), auth (ADR-0004), and so on. None of them decide what the **public root**
(`/`) of `apps/web` should be, nor how the site presents itself to search engines and social-media
crawlers. Yet the shipped app has a substantial answer to both: a full server-rendered marketing
landing page and a complete SEO / social-card layer.

There is a content spec, `HOMEPAGE.md`, that governs *what the page says and in what order* — it is a
marketing/content brief (analogous to `design/dashboard/` for the dashboard), explicitly **not** an
implementation ticket, and it defers presentation polish to ADR-0019. What was never recorded as a
decision is the engineering shape around it: that `/` is an anonymous-first, crawler-friendly
marketing page (not a redirect to login/dashboard), that signed-in users are *not* bounced off it,
and that the site generates its own branded Open Graph / Twitter images with no external fetch. This
ADR records that.

## Decision Drivers

- **Acquisition / SEO** — the real activation event is *installing the plugin*, and the site's job is
  to make a cold visitor (and a crawler) understand and want that; crawlers send no session cookie, so
  the pitch must be in the server-rendered HTML.
- **Shareability** — a link pasted into Slack / X / Discord should render a branded card, not a bare
  URL, and it must do so **offline and inside the standalone Docker image** (no external asset fetch).
- **Don't punish signed-in users** — a logged-in visitor should still be able to read the marketing
  page; the chrome should reflect their session rather than nag them to sign in.
- **Truthfulness** — telemetry is *approximate*, attention detection *best-effort*, privacy
  *redact-before-send*; the marketing copy must not overclaim (`HOMEPAGE.md` grounding rule).

## Considered Options

1. **Redirect `/` → `/dashboard` (or the login screen).** Simple, but throws away the acquisition
   surface entirely and gives crawlers nothing to index. Rejected.
2. **A minimal static splash** (logo + "sign in"). Better than a redirect but still no real pitch, no
   SEO story, no social card. Rejected.
3. **A full server-rendered marketing homepage + SEO/social infrastructure, built to `HOMEPAGE.md`.
   — CHOSEN.**

## Decision

**`/` is a server-rendered marketing landing page.** `app/page.tsx` is a server component that emits
the SEO metadata and renders `components/home/Homepage.tsx`, whose sections
(`Hero`, `ProblemStrip`, `HowItWorks`, `Features`, `Privacy`, `Pricing`, `FinalCta`, `HomeFooter`)
are server-rendered so crawlers (no cookie) receive the full pitch in the initial HTML.

**Signed-in visitors are not redirected away.** The `Homepage` client component looks up `getMe()` and
threads the session into `HomeNav` / `Hero` / `FinalCta` so the header and primary CTAs reflect a
logged-in user (an "Open dashboard" CTA + avatar instead of "Sign in with Google"), but the page stays
browsable at `/` — asserted by `e2e/landing.spec.ts`.

**Site-wide SEO/social metadata** lives in the root layout + page (`app/layout.tsx`, `app/page.tsx`):

- A title template `%s · zantiflow` (sub-pages set a short title; the homepage opts out with
  `title.absolute`), a marketing description, a `keywords` set, `applicationName`, the PWA `manifest`,
  and `appleWebApp` config.
- `metadataBase` derived from **`NEXT_PUBLIC_SITE_URL`** (read server-side at render time, so the
  public origin can change without a rebuild; falls back to localhost for dev) — needed so file-based
  OG/Twitter image URLs resolve to the absolute links crawlers require.
- Per-surface `openGraph` / `twitter` cards.

**Branded social cards are generated on-demand and are fully self-contained.**
`app/opengraph-image.tsx` and `app/twitter-image.tsx` render a shared 1200×630 PNG via
`lib/og.tsx` using `next/og` (satori) on the Node runtime, with the logo **inlined as a data URI** and
colours from the design system — **no external fetch**, so it works offline and inside the standalone
Docker image (ADR-0021).

**Outbound links are centralised** in `lib/links.ts` (docs on GitHub Pages, the GitHub repo, the
`deploy/` example, GitHub Sponsors), treating the plugin getting-started guide (ADR-0022/0023) as the
activation destination, and kept in sync with `docs/astro.config.mjs`.

**Marketing copy is grounded.** Per `HOMEPAGE.md`'s non-negotiable rule, every claim must be true per
the ADRs/docs — telemetry described as approximate, detection best-effort, privacy redact-before-send.

## Consequences

- **Positive:** the product is discoverable (indexable pitch) and shareable (branded cards that work
  offline / self-hosted); signed-in users are not bounced; the public origin is configurable at deploy
  time via one env var; the marketing surface has a written source of truth (`HOMEPAGE.md`).
- **Negative:** marketing copy is a maintenance surface that must be kept honest as behaviour changes
  (mitigated by the grounding rule + `HOMEPAGE.md`); presentation polish beyond the vendored dashboard
  is otherwise deferred (ADR-0019), so the page is built to sensible defaults, not a bespoke design.
- **Neutral:** the homepage is the anonymous entry point; the auth-gated app surfaces (`/dashboard`,
  `/spotlight`, `/tokens`, …) remain `robots: { index: false }` and carry their own short titles.

## Open Questions / Risks

- **Pre-publish account rename** — `lib/links.ts` hardcodes the docs, repo, and sponsors URLs to the
  `ioandev` GitHub account (the pre-migration owner). These (and the equivalents in
  `docs/astro.config.mjs`) must be updated to the publishing account before launch, or every outbound
  link 404s.
- **`NEXT_PUBLIC_SITE_URL` must be set in production** (`deploy/.env`); left unset, OG/Twitter image
  URLs resolve against `localhost` and crawlers reject them.
- Copy accuracy has no automated guard — the grounding rule is enforced by review, not by a test.

## References

- `apps/web/app/page.tsx`, `apps/web/components/home/*` — the server-rendered landing sections.
- `apps/web/components/home/Homepage.tsx` — session-aware, non-redirecting anon-first render.
- `apps/web/app/layout.tsx` — title template, keywords, `metadataBase` from `NEXT_PUBLIC_SITE_URL`.
- `apps/web/lib/og.tsx`, `apps/web/app/opengraph-image.tsx`, `apps/web/app/twitter-image.tsx` —
  self-contained `next/og` social cards.
- `apps/web/lib/links.ts` — centralised outbound links (pre-migration account, see risk).
- `HOMEPAGE.md` — the marketing/content spec + grounding rule; ADR-0019 (deferred UX), ADR-0023 (docs).
- `apps/web/e2e/landing.spec.ts` — anon CTA + signed-in-stays-on-page coverage.
