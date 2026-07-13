# ADR-0014 — Testing strategy: mockable ports, four layers, test at every step

- **Status:** Accepted
- **Cross-cuts:** every ADR (all components are built test-first against this)
- **Date:** 2026-07-10
- **Deciders:** project owner
- **Tags:** testing, bdd, playwright, integration, mocking, ci

## Context

zantiflow is polyglot — Rust plugin, TS backend/web/packages, Python bots — talking to external
systems we do **not** want in most tests: the **Zellij host API**, **Google OAuth**, the **Web Push
service**, and **Discord/Telegram**. We want **four kinds of tests** at every step: **unit**,
**behavioral (BDD)**, **integration**, and **Playwright (E2E)**. Externals are **mocked**; **MariaDB
is real**.

## Decision Drivers

- **Testability by construction** — external boundaries must be swappable for fakes.
- **Fast feedback** (unit/BDD) + **realistic confidence** (integration on a real DB, E2E on the real UI).
- **Determinism** — no live third-party calls in CI.
- **Test at every step** — no feature lands without tests at its relevant layers.

## Decision

### 1. Ports & adapters (the enabling requirement)

Every external boundary sits **behind an interface**, real in prod, fake in tests:

- **Plugin:** a **`HostPort`** trait wraps *all* `zellij-tile` FFI (`get_pane_scrollback`,
  `web_request`, event subscription, timers, `/data` I/O). Plugin logic is tested by injecting a fake
  host — **no live Zellij needed**.
- **Backend:** the **DB**, **OAuth token endpoint**, **web-push sender**, and **bot-WS** are each
  behind an interface.
- **Bots:** the platform SDK and the backend-WS client are behind interfaces.

### 2. The four layers (scope per package/app)

- **Unit** — isolated, all I/O mocked. Plugin heuristics/redaction/fingerprint/ordering; backend
  token-hash/HMAC-session/tier/notifier-routing/delivery-state-machine; package logic; bot message
  handling.
- **Behavioral (BDD, given/when/then)** — component-level observable behavior as **living spec**.
  e.g. *"Given a `claude` pane silent ≥ threshold → `needs-input` goes active"*, *"Given an attention
  past threshold + outside cooldown → a trigger fires and N delivery rows are created"*, *"Given a bot
  restart → pending deliveries replay"*, *"Given a promo redeemed → tier=pro until expiry"*.
- **Integration** — real wiring, **real MariaDB (testcontainers)**, external SaaS mocked, real WS.
  Ingest→snapshot; auth 401/200; management API gated by session; notifier→deliveries→dispatcher;
  backend↔fake-bot link/deliver/ack/replay; **wire-contract v4** contract test driven by the
  mock-Zellij harness.
- **Playwright (E2E)** — the PWA against a **seeded test backend with mocked externals**: Google
  login → `/auth/me` → logout; token CRUD + ≤10 cap; the **pre-permission popup + button** (grant &
  deny); PWA install nudges (Android + iOS copy); device-pairing (enter code → approve); promo
  redemption; dashboard render + attention badges + **SSE live update** + `<hidden>` privacy rendering;
  Discord/Telegram link UI.

### 3. Mock boundaries

**Mocked:** Zellij host (fake `HostPort` / mock-Zellij harness), Google (the `@zantiflow/oauth`
`tokenUrl` override — as commenttoday does), web-push service, Discord/Telegram. **Real:** **MariaDB**
via testcontainers (integration) — faked/in-memory only in unit.

### 4. Tooling (sensible defaults)

- **Rust plugin:** `cargo test` + `rstest` + `insta` (snapshots) + `cucumber-rs` (BDD).
- **TS backend/web/packages:** `vitest` (unit + BDD via given/when/then; `@cucumber/cucumber` where a
  feature file reads better) + `supertest`/`undici` (API) + `testcontainers` (MariaDB) + `@playwright/test`.
- **Python bots:** `pytest` + `pytest-asyncio` + `pytest-bdd` + `respx` (HTTP mocks).
- **CI:** one `docker-compose` test env (backend + MariaDB + mocked bots/push); GitHub Actions matrix
  runs every suite on PR.

### 5. Fixtures / harnesses to build

- A **mock-Zellij harness** that feeds the plugin fake events + pane content and captures its
  `web_request` output (powers plugin unit + the v4 contract test).
- A **seeded-DB** helper (accounts, machines, tokens, snapshots, attentions).
- Mock **OAuth**, **push**, and a **fake bot** WS client.

### 6. Real-Zellij smoke check (home of the "verify-at-build" items)

Because everything else mocks Zellij, one **smoke test loads the actual `.wasm` in a pinned Zellij**
and confirms the FINDINGS assumptions the mocks encode: `get_pane_scrollback` signature/permission,
`web_request` availability, `PluginConfigurationChanged` firing, `/data` writability, and the
struct/enum shapes. This is the single place that validates mock-vs-reality; run it in CI (or manually
on a pinned tag).

### 7. Coverage & policy (sensible defaults)

- **No hard global coverage gate** initially; coverage is **reported** (c8 / `cargo-tarpaulin` /
  `coverage.py`), not failing.
- **Every** new module / endpoint / attention / channel / migration lands **with tests**.
- **Critical paths must have behavioral coverage:** auth + sessions, token issuance/validation,
  **privacy redaction**, tier gating, and **delivery durability/replay**.
- **Mutation testing** deferred (future).

## Consequences

**Positive**
- Testability shapes the code (DI/ports) — a cleaner architecture as a side effect.
- BDD scenarios double as executable spec; fast unit + realistic integration + real-UI E2E.
- Deterministic CI (no live third parties); the smoke check keeps mocks honest.

**Negative / costs**
- The `HostPort` (and other interfaces) is upfront design work.
- Real-DB integration needs Docker in CI; polyglot means three test stacks to maintain.

## Open Questions / Risks

1. BDD tool per language (`cucumber-rs`/`pytest-bdd`/`@cucumber/cucumber` vs lightweight given/when/then
   helpers) — pick per package; default to the lightweight option unless a feature file is clearer. **(decided.)**
2. A coverage **gate** threshold — introduce later once suites stabilize. **(decided: no gate now.)**
3. Playwright against fully-mocked vs partially-real backend — default: seeded test backend, mocked
&  **(decided.)**

## References

- All ADRs (each carries a **Testing** line pointing here); FINDINGS.md (the smoke-check assumptions)
- vitest · Playwright · pytest-bdd · cucumber-rs · testcontainers
