# ADR-0023 — Documentation site: Starlight (Astro) in `docs/`

- **Status:** Accepted
- **Amended by:** [ADR-0048](0048-docs-site-containerized-deploy.md) — §4's hosting is resolved: docs ship as the `zantiflow/docs` container served at `docs.<domain>`, **not** GitHub Pages
- **Refines:** [ADR-0022](0022-plugin-publishing-and-user-docs.md) — the `docs/` folder becomes a **Starlight site**; the plugin getting-started guide becomes a content page in it
- **Builds on:** [ADR-0015](0015-modular-code-organization.md) (monorepo), [ADR-0021](0021-dockerization-and-deployment.md) (deploy), the whole ADR corpus
- **Date:** 2026-07-11
- **Deciders:** project owner
- **Tags:** docs, starlight, astro, contributing, privacy
- **Testing:** CI `astro build` + link-check + Pagefind index build — see [ADR-0014](0014-testing-strategy.md)

## Context

Docs are scattered — the ADRs (decision record), `FINDINGS.md`, the plugin guide (ADR-0022), the
`deploy/` examples. We want **one polished documentation website** for users *and* contributors, with
search and clear navigation. This ADR decides to build it with **Starlight** (Astro's documentation
framework) in a monorepo folder called **`docs/`**.

## Decision

### 1. Framework & location

**Starlight (Astro)** in **`docs/`** — a monorepo **workspace package** (Node/TS; added to
`pnpm-workspace.yaml`). Starlight gives sidebar nav, **built-in local search (Pagefind, no external
service)**, dark/light, MDX, and versioning support out of the box. Content lives under
`docs/src/content/docs/…`.

### 2. Information architecture (sections)

- **Intro** — what zantiflow is; the plugin → backend → dashboard/notifications loop.
- **Plugin** — **getting started** (the ADR-0022 guide migrates to
  `docs/src/content/docs/plugin/getting-started.mdx`), install, **configure** (the KDL key catalog),
  privacy defaults, troubleshooting.
- **Backend** — architecture, **self-hosting** (links `deploy/`, ADR-0021), API + wire-contract overview.
- **Dashboard (web)** — using it, notifications, pane output, integrations.
- **Privacy** — the full model (ADR-0002/0016/0017): what is/isn't sent, redaction, **`pane_output`
  opt-in + scrubbing**, **retention = latest-only/none**, "what leaves your machine." *(Explicitly
  called out — it's a headline promise.)*
- **Contributing** — dev setup, **monorepo layout** (ADR-0015), **testing** (ADR-0014), the PR flow,
  code of conduct.
- **ADRs — what they are & how we use them** — explains the **MADR-lite** convention, that
  **`adrs/` is the source of truth**, and how decisions are recorded/amended/superseded; links the
  canonical index.
- **Donations** — **GitHub Sponsors** + **promo codes** (ADR-0011/0020); no paid billing (ADR-0013).
- **Deploy / self-host** — docker-compose (ADR-0021).
- **FAQ / anything else** worth documenting.

### 3. ADRs vs docs (no duplication)

The **`adrs/` corpus stays the source of truth** — the decision record. The Starlight site is
**prose for humans**: it **explains and links** decisions; it does **not** replace or fork them. Where
a docs page overlaps an ADR, it **links** rather than copies (drift-avoidance).

### 4. Build & deploy

`astro build` → a **static site**. Default hosting: **GitHub Pages** (free, OSS-friendly); the hosted
instance may also serve it at `docs.<domain>` (static behind Caddy, or a `zantiflow/docs` image per
ADR-0021). Search is **Pagefind** (local, no SaaS). CI builds + link-checks on PRs.

> **Superseded by [ADR-0048](0048-docs-site-containerized-deploy.md):** the project ships docs as the
> **`zantiflow/docs` container** (the option named above), built by the standard pipeline and served at
> `docs.zantiflow.com` behind Caddy — **not** GitHub Pages. See Open Question 1 below (now resolved).

### 5. Consolidation

Existing scattered docs move in: the plugin guide becomes a Starlight page; `FINDINGS.md` and the ADRs
are **linked**, not duplicated. Docs **track releases** (config keys, wire-contract version).

## Consequences

**Positive**
- A single, searchable docs home for users and contributors; the **privacy**, **contributing**, and
  **"what ADRs are"** pages the project needs; static + free hosting.

**Negative / costs**
- Another workspace app to build/deploy; docs must be **kept in sync** with ADRs/releases (mitigated by
  linking to ADRs, not copying).

**Neutral**
- Refines ADR-0022's `docs/` (now a Starlight app); the getting-started guide migrates into it.

## Open Questions / Risks

1. **Hosting** — **resolved by [ADR-0048](0048-docs-site-containerized-deploy.md): the `zantiflow/docs`
   container**, served at `docs.zantiflow.com` behind Caddy (not GitHub Pages).
2. **Versioned docs** (per plugin release) via Starlight's versioning — **deferred** until releases warrant it.
3. **Auto-generate an ADR index page** from `adrs/` — nice-to-have; for now the page **links** the
   canonical `adrs/README.md`. **(decided: link, not generate, for now.)**

## References

- ADR-0022 (plugin docs — refined here), ADR-0015 (monorepo), ADR-0021 (deploy), ADR-0002/0016/0017
  (privacy), ADR-0011/0013/0020 (donations/tiers), the `adrs/` index
