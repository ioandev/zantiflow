# ADR-0036 — Apache-2.0 licensing & automated third-party license-compliance manifests

- **Status:** Accepted (implemented)
- **Followed up by:** [ADR-0046](0046-ci-license-manifest-drift-guard.md) — resolves this ADR's Open
  Question/Risk 2 (CI drift guard) and completes its Risks 1 (stray `MIT` fields) & 3 (account rename)
- **Corrects:** [ADR-0022](0022-plugin-publishing-and-user-docs.md) §1 — its "Source is **MIT/OSS** (`apps/plugin`)" line is stale; the plugin (and the whole repo) is **Apache-2.0**
- **Builds on:** [ADR-0004](0004-google-auth-owner-sign-in.md) (open-sources the `@zantiflow/*` packages; upstream `@commenttoday/*` is MIT → attribution), [ADR-0021](0021-dockerization-and-deployment.md) (images bundle content), [ADR-0011](0011-tiers-and-monetization.md)/[ADR-0013](0013-paid-subscriptions-declined.md) (Apache-2.0 offers no moat — a deliberate choice)
- **Date:** 2026-07-12
- **Deciders:** project owner
- **Tags:** licensing, compliance, legal, oss

> **Retroactive ADR:** This decision was already implemented in the codebase before this ADR was written; it is recorded here after the fact to close a documentation gap — it was not written at the right time.

## Context

zantiflow is going open source (ADR-0004 already published the `@zantiflow/oauth*` package family for
that reason). An OSS project of this shape carries two distinct licensing obligations that had been
implemented in the tree but never captured in an ADR:

1. **A license for zantiflow's own code.** The repo is a polyglot monorepo — a Rust/WASM plugin, a
   TS/Express backend, a Next.js web app, shared npm packages, and two Python bots — and needs one
   consistent, unambiguous license across all of it.
2. **Third-party attribution.** The dependency tree spans **three ecosystems** (npm, Cargo, PyPI) and
   is large — the generated root manifest currently reproduces **973 third-party packages** (`npm: 808 ·
   Cargo: 135 · PyPI: 30`, per the head of `/repos/zantiflow/LICENSES`). Nearly every one is permissive
   and imposes the same minimal obligation: **retain its copyright + license notice** when
   redistributing. Apache-2.0 §4(d) further requires that any distribution carry a readable `NOTICE`.
   Doing this by hand across three package managers is infeasible and goes stale immediately.

Two other agents surfaced this gap while scoped to unrelated work and correctly left it for a
repo-wide owner — this ADR is that record. It also **corrects a now-inaccurate statement in ADR-0022**,
which still reads "Source is **MIT/OSS** (`apps/plugin`)" (`adrs/0022-plugin-publishing-and-user-docs.md`
line 24). The plugin's `apps/plugin/Cargo.toml` declares `license = "Apache-2.0"`; the repo is
Apache-2.0 throughout. (ADRs are immutable once Accepted, so ADR-0022 is not rewritten — this ADR
supersedes that clause.)

## Decision Drivers

- **Permissive, with a patent grant.** The project wants unrestricted commercial/hosted use with no
  copyleft strings, but also an **explicit patent license** — which MIT lacks and Apache-2.0 grants.
- **One license, whole polyglot repo.** Rust, TS, and Python code should not diverge on license; a
  single choice keeps redistribution rules simple for forkers and self-hosters (ADR-0021).
- **Attribution must be automatic and reproducible.** A manifest maintained by hand rots on the next
  `pnpm install`; it must be regenerable from the actual dependency lockstate with no manual curation.
- **No new tooling to install.** Reuse what the repo already has (`pnpm licenses`, `cargo metadata`,
  each bot venv's Python stdlib) rather than adding a fourth license scanner as a dependency.
- **Fail-closed compliance signalling.** Anything that is *not* clearly permissive (GPL/AGPL, unknown
  strings) must be surfaced automatically on every run — the same fail-closed posture as the privacy
  model (CLAUDE.md), so a copyleft dependency can never slip in unnoticed.
- **Notices must ship inside every artifact**, not just live in the repo — an image or a `.wasm`
  handed to a user must carry the attributions with it (ADR-0021 bundles content).

## Considered Options

**Project license**
1. **Apache-2.0** *(chosen)* — permissive, explicit patent grant, industry-standard `NOTICE`
   attribution mechanism; consistent across all languages.
2. **MIT** — what ADR-0022 §1 and ADR-0004 originally stated for the plugin / packages; simpler but
   **no patent grant**. Superseded by the Apache-2.0 choice; the "MIT" text in those ADRs is now stale.
3. **A copyleft license (GPL/MPL)** — rejected: would restrict the hosted service and forks, contrary
   to the "no moat, anyone may fork/re-host" stance recorded in ADR-0011/0013.

**Third-party attribution tooling**
1. **A single custom deterministic generator over existing tooling** *(chosen)* —
   `scripts/generate-licenses.mjs` (+ `scripts/licenses-python.py`) drives `pnpm licenses`,
   `cargo metadata`, and each venv's `importlib.metadata`, unifies them into one manifest format, and
   adds compliance classification. Nothing extra to install; missing ecosystems degrade to a warning.
2. **Per-ecosystem tools wired together** (`license-checker` + `cargo-about` + `pip-licenses`) —
   rejected: three more dependencies, three output formats to reconcile, and no unified copyleft
   flagging.
3. **Manual `LICENSES` file** — rejected: unmaintainable across 973 packages and three lockfiles;
   stale on the first dependency bump.

**Where the notices ship**
1. **Image root + release assets + docs** *(chosen)* — bundled into every Docker image, attached to
   the plugin's GitHub Release, and summarised in the docs site.
2. **Docs-only** — rejected: a distributed image/`.wasm` would then ship without its attributions,
   violating the permissive/Apache notice-retention obligation.

## Decision

### 1. zantiflow is licensed Apache-2.0, repo-wide

- The full Apache-2.0 text lives at `/repos/zantiflow/LICENSE`; `/repos/zantiflow/NOTICE` carries the
  Apache §4(d) attribution ("zantiflow — Copyright 2026 Ioan Biticu … credit the zantiflow project and
  its source repository").
- The choice is declared everywhere: root `package.json` (`"license": "Apache-2.0"`), the plugin
  (`apps/plugin/Cargo.toml` → `license = "Apache-2.0"`), all four shared packages
  (`packages/{oauth,oauth-express,oauth-react,protocol}/package.json`), and the root `README.md`
  ("The same license applies to the `@zantiflow/*` packages"). Each package also ships its own
  `LICENSE` + `NOTICE`.
- **This corrects ADR-0022 §1** ("MIT/OSS") and the "MIT" framing in ADR-0004 (which copied the
  packages from the **MIT-licensed** `@commenttoday/*` originals — same author, so relicensing the
  copy to Apache-2.0 is the author's to make; the upstream MIT origin is acknowledged via `NOTICE`).

### 2. Automated third-party manifests via `scripts/generate-licenses.mjs`

A single Node script (with a `scripts/licenses-python.py` helper) generates the third-party attribution
manifest for a chosen **scope**:

- **Scopes** (`--scope` / `--out`): `all` (whole monorepo → `LICENSES`), `web`
  (`@zantiflow/web`'s npm tree → `apps/web/LICENSES`), `plugin` (the Cargo closure compiled into the
  `.wasm` → `apps/plugin/LICENSES`). Unknown scopes exit non-zero.
- **Collectors:** npm via `pnpm licenses list --json` (filtered to `@zantiflow/web` for `web` scope;
  first-party `@zantiflow/*` excluded); Cargo via `cargo metadata --filter-platform wasm32-wasip1`,
  walking only the **normal (non-dev/non-build) dependency closure** from the workspace members — i.e.
  exactly what links into the shipped `.wasm`; PyPI via the Python helper run under each bot's
  `.venv` interpreter (`importlib.metadata`, deduped across both bots). Each entry records ecosystem,
  name, version, SPDX id, author, homepage, and the bundled license text (read from the package's
  `LICENSE`/`NOTICE`/`COPYING` files).
- **Resilience:** a missing ecosystem (no Cargo, no venv) **degrades to a warning and is skipped**
  rather than failing the run; the script **refuses to overwrite with an empty file** (exits 1 if it
  found nothing). Output is **deterministic** (sorted, no timestamps) so re-running only produces a
  diff when the dependency set actually changed.
- **Compliance classification (fail-closed):** every package is sorted into a category —
  *Permissive / Attribution (CC-BY, OFL) / Weak copyleft (MPL, EPL, CDDL) / LGPL / Strong copyleft
  (GPL, AGPL) / Needs review (unrecognised)* — via SPDX-expression parsing (`AND` = max severity,
  `OR`/`/` = least restrictive). Anything not recognised as clearly permissive is **flagged for
  review**. The manifest opens with a **"LICENSE COMPLIANCE OVERVIEW"**: a category rollup, a verdict
  line (`⚠ ATTENTION: N package(s) carry a strong-copyleft or unrecognised license` vs `✓ No
  strong-copyleft (GPL/AGPL) or unrecognised licenses detected`), and a per-category list of every
  non-permissive package. (Today: 0 strong-copyleft, 2 LGPL, 6 weak, 1 attribution — see the head of
  `/repos/zantiflow/LICENSES`.)

### 3. Committed manifests + a one-command recipe

The generated manifests are **committed to the repo** (`git ls-files` tracks `LICENSES`,
`apps/web/LICENSES`, `apps/plugin/LICENSES`) and regenerated with a single Justfile recipe:

```
# Justfile
license:
    node scripts/generate-licenses.mjs --scope all    --out LICENSES
    node scripts/generate-licenses.mjs --scope web     --out apps/web/LICENSES
    node scripts/generate-licenses.mjs --scope plugin  --out apps/plugin/LICENSES
```

Each manifest's header states it is a `GENERATED FILE — do not edit by hand. Regenerate with
`just license`` and reproduces zantiflow's own-license note (Apache-2.0, pointing at `./LICENSE` and
`./NOTICE`).

### 4. Notices ship inside every distribution artifact

- **Docker images (ADR-0021):** each `apps/*/Dockerfile` copies the notices into the image root —
  `apps/backend/Dockerfile`, `apps/discord-bot/Dockerfile`, `apps/telegram-bot/Dockerfile` do
  `COPY LICENSE NOTICE LICENSES …`; `apps/web/Dockerfile` copies the web-scoped manifest
  (`COPY … LICENSE NOTICE apps/web/LICENSES ./`). `.dockerignore` deliberately does **not** exclude
  these files (it strips `*.wasm`, `design`, `.env`, venvs, etc. — not `LICENSE*`/`NOTICE`), so the
  attributions ride along in every published image. This is the concrete realisation of ADR-0021's
  "images bundle content."
- **Plugin GitHub Release (ADR-0022):** `.github/workflows/plugin-release.yml` regenerates the
  **plugin-scoped** manifest fresh at release time
  (`node scripts/generate-licenses.mjs --scope plugin --out zantiflow.wasm.LICENSES`) and attaches
  `zantiflow.wasm`, its `.sha256`, `zantiflow.wasm.LICENSES`, plus `LICENSE` and `NOTICE` to the
  Release — so the `.wasm` never ships without its Cargo-closure attributions.

### 5. User-facing documentation

`docs/src/content/docs/licensing.mdx` (the Starlight docs site, ADR-0023) explains the model to users:
what zantiflow itself is under (Apache-2.0, patent grant), the permissive-majority dependency picture,
the compliance-overview flagging, the specific non-permissive packages that "need care" (LGPL:
`mariadb`, `@img/sharp-libvips`; MPL-2.0: `lightningcss`, `web-push`, `certifi`, `colored`,
`option-ext`; CC-BY-4.0: `caniuse-lite`; CC0-1.0: `mdn-data`), the explicit "no GPL / AGPL / BSL /
SSPL anywhere" assurance, and where the notices ship. It ties back to ADR-0011/0013 (Apache-2.0
offers no moat — an intentional choice; PRO is promo-code-gated, not a protected product).

## Consequences

**Positive**
- One permissive, patent-granting license across the whole polyglot repo; simple, consistent
  redistribution rules for forkers and self-hosters.
- Attribution is **regenerable from lockstate** with no manual curation and no extra dependency; a
  dependency bump is a `just license` away from a correct, deterministic manifest.
- Copyleft/unknown licenses are **surfaced automatically, fail-closed**, on every generation — a GPL
  or AGPL dependency cannot slip in silently.
- Every shipped artifact (image, `.wasm`) carries its notices, satisfying the permissive/Apache
  retention obligation at the point of distribution.

**Negative / costs**
- The committed manifests can **drift** if a contributor bumps dependencies and forgets `just license`
  — there is no automated guard for the root/web manifests (see Risks).
- Three large generated files live in the tree (root `LICENSES` ≈ 2.1 MB / ~36.8k lines; `apps/web`
  ≈ 408 KB; `apps/plugin` ≈ 760 KB), which show up in diffs on dependency changes.
- The generator's classifier is a heuristic; a genuinely novel SPDX string lands in "Needs review" and
  requires a human call.

**Neutral**
- Reuses existing tooling (`pnpm`/`cargo`/venv); implements the notice-bundling side of ADR-0021 and
  the release-asset side of ADR-0022; documented in ADR-0023's docs site.

## Open Questions / Risks

1. **Stray `MIT` license fields.** `apps/backend/package.json` and `apps/plugin-dist/package.json`
   still declare `"license": "MIT"`, inconsistent with the repo-wide Apache-2.0 decision. These are
   `private` apps (not published to npm), so the impact is cosmetic, but they should be reconciled to
   `Apache-2.0`.
2. **No drift check in CI.** The plugin manifest is regenerated **fresh** in `plugin-release.yml`
   (so the *shipped* artifact can never be stale), but the committed root/web `LICENSES` have no
   `just license && git diff --exit-code` guard in `ci.yml`/`tests.yml` — a stale committed manifest
   would not fail a build. Adding such a guard is the obvious follow-up.
3. **Pre-publish account rename is half-applied.** The attribution files use the new handle
   (`NOTICE`, `README.md`, `docs/.../licensing.mdx`, the package `NOTICE`s → `github.com/ioandev`),
   but many URLs still point at the old **`ioandev`** account: the three `@zantiflow/*`
   package.json `repository`/`homepage`/`bugs` fields, `apps/web/lib/links.ts` (`GITHUB_URL`,
   `sponsors`), `apps/plugin-dist` (README, config default, `.env.example`), and several docs pages
   (`plugin-getting-started.md`, `troubleshooting.mdx`, `astro.config.mjs`, `index.mdx`, `adrs.mdx`) —
   as well as ADR-0022 itself. This must be unified to `ioandev` (or the final org) **before OSS
   publish**, or the published attribution and the published source URLs will disagree.
4. **ADR-0022's "MIT/OSS" clause remains in its text.** ADRs are immutable once Accepted; this ADR
   supersedes that statement rather than editing it. A forward-pointer could be added to ADR-0022's
   index entry.
5. **Release signing** beyond the SHA-256 checksum (cosign/minisign) is still deferred (ADR-0022 OQ1)
   — orthogonal to attribution, but part of the same "trust the distributed artifact" story.

## Testing / verification

There is no dedicated test suite for licensing, but the design carries its own guardrails:

- **Fresh-at-release generation** — `plugin-release.yml` regenerates `zantiflow.wasm.LICENSES` from
  the exact released crates on every Release, so the artifact's attribution can't go stale.
- **Fail-closed generator** — `scripts/generate-licenses.mjs` exits `1` rather than writing an empty
  manifest, and flags every strong-copyleft/unrecognised package in the compliance overview on each
  run.
- **Deterministic output** — sorted, timestamp-free, so a `git diff` is meaningful and a drift check
  is trivial to add.
- **Gap:** no CI job currently regenerates the committed root/web manifests and asserts no diff
  (Risk 2).

## References

- Own license & attribution: `/repos/zantiflow/LICENSE`, `/repos/zantiflow/NOTICE`,
  `README.md`; per-package `packages/*/LICENSE` + `NOTICE`
- Generator: `scripts/generate-licenses.mjs`, `scripts/licenses-python.py`; recipe: `Justfile`
  (`license`)
- Generated manifests: `LICENSES`, `apps/web/LICENSES`, `apps/plugin/LICENSES`
- Artifact bundling: `apps/backend/Dockerfile`, `apps/web/Dockerfile`,
  `apps/discord-bot/Dockerfile`, `apps/telegram-bot/Dockerfile`, `.dockerignore`;
  `.github/workflows/plugin-release.yml`
- License declarations: root `package.json`, `apps/plugin/Cargo.toml`, `packages/*/package.json`
- User docs: `docs/src/content/docs/licensing.mdx`
- ADR-0022 (plugin publishing — the "MIT/OSS" clause this ADR corrects), ADR-0021 (images bundle
  content), ADR-0004 (OSS packages, MIT upstream), ADR-0011/0013 (no moat), ADR-0023 (docs site)
