# ADR-0050 — Per-app justfiles as the standard dev-task entry point

- **Status:** Accepted (implemented)
- **Amends:** [ADR-0018](0018-engineering-and-operational-conventions.md) — adds a dev-workflow
  convention (per-app task runner) to the engineering conventions.
- **Relates to:** [ADR-0036](0036-apache-2-0-and-third-party-license-compliance.md) (introduced the
  root `Justfile` for `just license`); the bot `justfile`s (`apps/discord-bot`, `apps/telegram-bot`)
  predate this ADR un-recorded — this ADR retroactively records the convention they started.
- **Date:** 2026-07-22
- **Deciders:** project owner
- **Tags:** tooling, dev-experience, conventions
- **Testing:** none required — every recipe is a thin wrapper over a command already exercised by CI
  (`pnpm run …` scripts, `cargo …`); `just --list` in each app is the manual smoke. See
  [ADR-0014](0014-testing-strategy.md).
- **Wire contract:** unchanged (**v4**) — tooling only.

## Context

The repo already uses [`just`](https://github.com/casey/just) in three places: the root `Justfile`
(cross-cutting recipes — `just license` from ADR-0036, `just notify`) and a `justfile` in each
Python bot (venv `setup` / `run` / watchfiles `dev`). The remaining apps — `apps/backend`,
`apps/web`, `apps/plugin`, `apps/plugin-dist`, and `docs` — had no justfile; their canonical dev
commands lived scattered across `package.json` scripts, the plugin README's "Build & test" block,
and (worst) out-of-repo operator memory:

- The **web** app has a genuinely dangerous incantation: `next build` into the default `.next`
  while `next dev` is running corrupts the dev server, and the safe Playwright path
  (`NEXT_DIST_DIR=.next-e2e` + `E2E_PORT=3100`) is a two-command sequence recorded nowhere in-repo.
  The `test:e2e` npm script itself does the *unsafe* thing locally (builds into `.next`).
- The **backend** needs ecosystem context (dev MariaDB on `:3308` before `dev`; a
  Docker-compatible socket before the integration tests) that a bare `package.json` can't express.
- The **plugin** is driven by raw multi-flag cargo commands (wasm target, clippy on two targets)
  documented only in its README.

A polyglot monorepo (pnpm / cargo / venv) has no single native script runner, so "how do I run
*this* app's tasks" had three different answers depending on the ecosystem.

## Decision Drivers

- One uniform answer in any app directory: `just` lists that app's tasks.
- Encode machine-safety knowledge (the web `.next` clobber) in-repo, not in operator memory.
- Don't create a second source of truth for commands that already live in `package.json`/README.

## Considered Options

1. **Status quo** — per-ecosystem scripts only. Rejected: no uniform entry point; the unsafe web
   e2e path stays the documented one.
2. **All recipes in the root `Justfile`** — one file, but every recipe needs `cd`-juggling,
   the file becomes a monolith (against ADR-0015's spirit), and app tasks aren't discoverable
   from the app directory.
3. **A `justfile` in every app** *(chosen)* — root keeps only cross-cutting recipes.

## Decision

**Every workspace app ships a `justfile`** — `apps/*` and `docs` (a workspace app per ADR-0023).
The root `Justfile` keeps repo-wide, cross-cutting recipes only. Rules:

1. **Thin wrappers.** A recipe delegates to the canonical command (`pnpm run <script>`,
   `cargo <…>`); the command's definition stays in `package.json` / `Cargo.toml` / the venv. A
   justfile never becomes a second place a command is *defined* — only where it is *found*.
   Exception: a recipe may exist precisely to encode the **safe form** of a task (web `e2e` builds
   into `.next-e2e` on port 3100 — safe alongside the dev server, unlike the raw `test:e2e` script
   run locally).
2. **Self-documenting.** First recipe is `default: @just --list`; every recipe carries a doc
   comment (shown by `just --list`); the header comment states the app's key preconditions
   (backend: `.env` + dev DB; web: the `.next` clobber warning).
3. **Consistent core names** where the task exists: `dev`, `build`, `test`, `start`; app-specific
   extras keep kebab-case (`db-up`, `e2e-run`, `clippy`).
4. **New apps ship a justfile at scaffold time** — it is part of the app's skeleton, like its
   `package.json`.

Nothing is removed: `pnpm`/`cargo` invocations keep working unchanged.

## Consequences

- **Positive:** `just` in any app dir (or `just --list`) answers "what can I run here" uniformly
  across npm, cargo, and Python apps; the safe web-e2e sequence and the backend's DB preconditions
  are now recorded and runnable in-repo; onboarding no longer requires reading four READMEs.
- **Negative:** `just` becomes an (optional) dev-machine dependency — CI does **not** use it, so
  nothing breaks without it; two files can drift when an npm script is renamed (mitigated by
  recipes being one-line delegations, so drift fails loudly on first use).
- **Neutral:** the bots' pre-existing justfiles are unchanged and now convention-backed; the root
  `Justfile` is unchanged.

## Open Questions / Risks

- Recipe/script drift has no CI guard (a renamed npm script leaves a dangling recipe until someone
  runs it). Accepted: failures are immediate and self-explanatory (`pnpm ERR missing script`).

## References

- `just` — https://github.com/casey/just
- Root `Justfile` (ADR-0036), `apps/discord-bot/justfile`, `apps/telegram-bot/justfile` — the
  pre-existing instances this ADR generalizes.
