---
description: Pick up the next unit of work from the zantiflow execution plan and implement it end-to-end — read the ADRs/FINDINGS behind it, build to the guiding invariants, verify against the phase's per-phase tests and "Done-when", then close out.
argument-hint: [Phase N | deliverable | feature]
---

# Execute a zantiflow build task

Take one unit of work from **`plans/execution-plan.md`** from selected → in-progress → done by actually implementing it. The plan's **phase** is the spec; the **ADRs** are the source of truth behind it, and **`FINDINGS.md`** is the source of truth for any plugin code. The plan's **Appendices** (A schema · B protocol/API contracts · C concrete defaults · D module taxonomy) are the concrete artifacts — build to them, don't re-derive.

## 1. Select the work

- The unit of work is a **phase** (Phase 0–10) or a **right-sized deliverable/slice within a phase** (one sitting). Phases are large — decompose into the plan's bullet deliverables and take one coherent slice.
- If arguments name a phase (`Phase 3`), a deliverable (`the ingest handler`, `device pairing`, `SSE stream`), or a feature — locate it in the plan and scope to it.
- If no arguments: pick the **next unfinished deliverable in the earliest incomplete phase**. Phases build strictly on the previous — **do not start a phase whose prerequisites aren't green** (e.g. no Phase 5 attentions before Phase 2's backend loop verifies). The **MVP loop closes at Phase 4** (plugin → ingest → dashboard).
- State clearly which phase + slice you selected before touching code.

## 2. Track it

- Use the harness task tools: `TaskCreate` the slice, break it into the plan's deliverables as steps, set `in_progress` when you start and `completed` as each lands. This is the only progress tracker — **ignore any external board.**

## 3. Read before you write a single line of code

Do these in order — the plan and ADRs were written so a fresh session starts without re-deriving decisions, so actually use them:

1. **The phase section in `plans/execution-plan.md`** — its Goal, every deliverable, the per-phase **Tests**, and the **Done-when** line. Plus the **Appendices** it leans on (A Prisma schema, B wire-v4/output/read/bot-WS contracts, C rate-limits/scrub-ruleset/timings, D module taxonomy).
2. **The ADRs the phase references** — the authoritative design (privacy Model A, two auth planes, retention=none, tier-server-side, etc.). If the plan and an ADR disagree, the ADR wins — flag it.
3. **`FINDINGS.md` — before ANY plugin code.** It records exact `zellij-tile` event/struct/permission names, the derived-activity gotcha, and what's easy to get wrong. Verify against the **pinned `zellij-tile` tag** — never code the plugin from memory.
4. **The "Guiding invariants (do not violate)"** block at the top of the plan — read it every time.
5. **Existing code in the area** you're about to touch (`packages/*` today; neighboring `apps/*` modules as they exist). Read enough that your code is indistinguishable from what's there. Module-first (Appendix D) — small modules in feature subfolders, never monoliths.

If the slice is too vague to derive acceptance criteria from, or the plan contradicts an ADR, **stop and ask** — don't guess, don't silently diverge.

## 4. Implement

- Work the deliverables in **dependency order**; implement exactly the slice — **no drive-by refactors, no features pulled forward from later phases.**
- **Enforce the guiding invariants** (they are not optional):
  - **Two auth planes, never conflated** — ingest tokens write-only + hashed; `ztf_session` HMAC gates read/manage.
  - **Every query scoped by `accountId`** at the data layer, not just the route. IDOR is the top bug class.
  - **Redact + scrub in the plugin, before send.** Privacy **fails closed**. The backend never receives raw secrets or pane content.
  - **Wire contract v4** — validate at the boundary (Appendix B): ignore unknown fields, reject unknown-newer `400`, bound depth/lengths. Token/account never in the body.
  - **Pane output** is the separate on-demand channel (5 s poll), **OFF by default**, sent only on website request.
  - **Tier enforced server-side**; **retention = none** (latest-only). UI-only enforcement of any of these is a bug.
- **Build test-first behind mockable ports** (ADR-0014): plugin behind `HostPort` (+ fake); externals mocked (Google, web-push, Discord/Telegram); **MariaDB real via testcontainers**.
- **Never restart/kill/reload Zellij** (CLAUDE.md hard rule). Any real-Zellij smoke check (ADR-0014 §6) runs in a **separate throwaway session only**.
- No TODOs left behind — implement it or flag it.

## 5. Verify

- `pnpm -r build && pnpm -r test` green for touched TS; `cargo test` (plugin) / `pytest` (bots) as applicable.
- Write and run the phase's **per-phase tests** across the relevant layers: unit · BDD (`vitest`/`pytest-bdd`) · integration (`supertest` + testcontainers MariaDB) · Playwright. Cover the security cases the phase names (IDOR, ≤10-token cap incl. concurrency, expired/revoked→401, ReDoS caps, XSS-safe render, server-side tier).
- **Exercise the change for real** — use the `verify` / `run` skill and drive the affected flow (login → dashboard, ingest → read, request → scrubbed output), not just typecheck. Plugin slices: the real-Zellij smoke check in a throwaway session.
- Walk the phase's **Done-when** criteria one by one and confirm each. If one fails, the slice is not done.
- Security-touching work: keep the **7 security-audit findings** (safe render, JWKS, redirect-validation, sessionEpoch, headers/CSP, token-cap atomicity, secret-rotation) in view; run the `security-audit` skill on the diff for anything on the auth/ingest/output/tenant paths.

## 6. Close out

- All Done-when verified → mark the harness task `completed`; note where the phase now stands.
- Report to the user: what shipped, how it was verified (which tests + the real run), and anything flagged.
- **Blocked or incomplete?** Leave the task `in_progress`, record exactly where things stand and what's blocking, and tell the user. Never claim a slice is done when it isn't.
- If the work surfaced a **new decision** (something the ADRs don't settle), don't diverge silently — write a new ADR (MADR-lite, next `NNNN`, update `adrs/README.md`) or flag it for one, per the repo's "one decision = one ADR" rule.
- Don't commit or push unless the user asked; if they do, branch off `develop`/`main` per repo convention.

## What NOT to do

- Don't start a phase whose prerequisites aren't green, and don't pull features forward from later phases.
- Don't contradict the ADRs or the plan's guiding invariants silently — flag conflicts and raise an ADR.
- Don't write plugin code from training-data memory — read `FINDINGS.md` and verify against the pinned `zellij-tile` tag first.
- **Don't restart/kill/reload Zellij — ever.** Smoke-test only in a separate throwaway session.
- Don't weaken an invariant: tenant scoping, write-only tokens, redact/scrub-before-send, fail-closed privacy, server-side tier, latest-only retention.
- Don't leave a server-side invariant enforced only in the UI.
- Don't add abstractions or "while I'm here" cleanups beyond the slice.
- Don't commit or push unless the user asked.
