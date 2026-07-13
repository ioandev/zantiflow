# ADR-0015 — Modular code organization: small modules in subfolders, extract reusable ones into packages

- **Status:** Accepted
- **Cross-cuts:** every ADR (all code follows this)
- **Relates to:** [ADR-0001](0001-zellij-session-telemetry-architecture.md) §8 (monorepo layout), [ADR-0004](0004-google-auth-owner-sign-in.md) / [ADR-0010](0010-bots-in-python-and-token-storage.md) (packages), [ADR-0014](0014-testing-strategy.md) (ports & adapters)
- **Date:** 2026-07-10
- **Deciders:** project owner
- **Tags:** architecture, modularity, packages, code-organization, monorepo

## Context

The codebase must **prioritise module-based code** — small, single-responsibility units organised in
**subfolders**, with genuinely reusable functionality **extracted into packages** (npm `@zantiflow/*`,
Rust crates/modules, Python packages). We've already done this with the `@zantiflow/oauth*` family and
the notify-protocol schema; this ADR makes it the standing rule for **all** code, and pairs naturally
with the ports-and-adapters testability requirement (ADR-0014).

## Decision Drivers

- **Testability** — small modules with narrow interfaces are directly mockable (ADR-0014).
- **Reuse** across apps (backend / web / bots) without copy-paste.
- **Clear boundaries** — easier review, parallel work, and ownership.
- Some modules are worth shipping as **OSS npm packages** (the auth family).

## Decision

### 1. Module-first, in subfolders

Every app is composed of **small, single-responsibility modules in feature/domain subfolders** — never
monolithic files or god-modules. Example backend shape (mirrors commenttoday's `backend/src/<domain>/`):
`src/{auth,tokens,machines,ingest,attentions,notifications,delivery,channels,pairing,promo,tiers,db,http}/…`,
each a self-contained module with its own types, logic, and **co-located tests**.

### 2. Extract reusable functionality into packages

Cross-app or reusable code becomes a **workspace package**:

- **TS:** `@zantiflow/*` under `packages/` — `oauth`, `oauth-express`, `oauth-react`, the **wire-contract
  types**, the **notify-protocol** schema/types. Published to Verdaccio → npm when ready (ADR-0004).
- **Rust (plugin):** split into **crates/modules** — the `HostPort` (ADR-0014), each attention as a
  module, privacy, protocol types.
- **Python (bots):** shared logic (WS client, `/link` handling, protocol models) as a package/module
  imported by both bots — even if unpublished.

### 3. Subfolder vs package — the promotion rule

Default to a **subfolder module**. **Promote to a package** only when it is (a) reused across **≥2
apps**, (b) independently **publishable / OSS**, or (c) has a **stable public API worth versioning**.
Do **not** over-package prematurely.

### 4. Interfaces & tests

Each module exposes a **narrow interface** (dependencies flow through ports, ADR-0014) and **owns its
tests** (co-located). This is what makes the four-layer testing strategy tractable.

## Consequences

**Positive**
- Testable, reusable, reviewable; parallel work; clear ownership; some modules ship as OSS packages.

**Negative / costs**
- More files/boundaries; risk of over-fragmentation or premature packaging — bounded by the promotion
  rule (§3); published packages carry cross-package versioning overhead.

**Neutral**
- Formalises what ADR-0001 §8, ADR-0004, and ADR-0010 already started; no behavioural change.

## Open Questions / Risks

1. The exact per-app module taxonomy — settled at scaffold time (execution plan). **(decided.)**
2. When to publish a package vs keep it workspace-internal — per the promotion rule (§3), case by case. **(decided.)**

## References

- ADR-0001 §8 (monorepo layout), ADR-0004 / ADR-0010 (packages), ADR-0014 (ports & adapters)
