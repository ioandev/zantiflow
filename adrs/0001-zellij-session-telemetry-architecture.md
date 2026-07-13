# ADR-0001 — Zellij-plugin session telemetry pushed to an Express backend

- **Status:** Accepted
- **Amended by:** [ADR-0002](0002-configurable-telemetry-privacy-controls.md) — privacy controls; wire contract → **v2**. [ADR-0003](0003-multi-tenant-backend-and-token-auth.md) — multi-tenant, token-authenticated backend; wire contract → **v3**
- **Date:** 2026-07-10
- **Deciders:** project owner
- **Tags:** architecture, zellij, plugin, backend, monorepo
- **Testing:** unit (fingerprint, ordering) + wire-contract (v4) via the mock-Zellij harness — see [ADR-0014](0014-testing-strategy.md)

## Context

We want live visibility into what is happening across all Zellij terminal sessions on a machine: a
tree of **sessions → tabs → panes**, each labelled with its name, and — for each pane — a sense of
**when it last produced output**. A Zellij plugin is the natural place to observe this, because
Zellij's plugin API exposes session/tab/pane structure to a plugin running inside the multiplexer.
We will push these observations to a separate backend process that renders them, keeping the plugin
thin and the presentation/aggregation concerns outside the WASM sandbox.

Constraints and findings that shape the decision (verified against `zellij-tile` docs, zellij.dev,
and `shim.rs`):

- Zellij plugins are **WASM modules**; the first-class, best-supported authoring path is **Rust +
  `zellij-tile`**.
- A plugin subscribes to events; **`SessionUpdate`** carries `(Vec<SessionInfo>, Vec<(String,
  Duration)>)` — **all live sessions** (each `SessionInfo` nests `.tabs: Vec<TabInfo>` and `.panes:
  PaneManifest`, and has `is_current_session`), plus **resurrectable/dead sessions** as `(name, time
  since death)`. This is a single, rich source for the whole tree.
- Plugins can issue outbound HTTP via **`web_request(url, verb, headers, body, context)`** (fire-and-
  forget; response returns asynchronously as a `WebRequestResult` event). `HttpVerb::Post` is
  available. Requires the **`WebAccess`** permission.
- A once-per-second cadence uses **`set_timeout(1.0)`**, which is **one-shot** and delivers a
  **`Timer`** event; it is re-armed from the handler. Requires subscribing to `EventType::Timer`.
- **Critical limitation:** `PaneInfo` (25 fields) has **no** output-activity signal — no "last
  updated" timestamp, no byte/line counter, no dirty flag (`is_focused` is selection, not output).
  The only realistic way to detect "new stdout in a pane" is to **poll pane content and diff it**
  (`get_pane_scrollback`, gated by the **`ReadPaneContents`** permission). This is approximate and
  costs O(panes) work per tick.

## Decision Drivers

- Keep the plugin thin; move rendering/aggregation to a normal process that is easy to iterate on.
- Use officially-supported, stable Zellij APIs.
- Be honest that per-pane "output recency" is derived and best-effort, not exact.
- Establish a monorepo layout that cleanly hosts a **polyglot** codebase (Rust WASM + Node/TS).

## Considered Options

**Transport (plugin → backend)**

1. **HTTP POST via `web_request`** *(chosen)* — built-in, simplest, one JSON snapshot per tick.
2. WebSocket — lower per-tick overhead, but more moving parts and less-proven from Zellij WASM.
3. Local sidecar process forwarding a pipe/file — most portable if `web_request` is restricted, but
   adds a component.

**Plugin language**

1. **Rust + `zellij-tile`** *(chosen)* — official, best API coverage; makes the repo polyglot.
2. Go (TinyGo) / AssemblyScript to WASM — keeps closer to one ecosystem, but rough tooling and
   lagging API coverage.

**Monorepo tooling**

1. **pnpm workspace (JS) + Cargo workspace (Rust), no meta-orchestrator** *(chosen)* — minimal,
   fits two-package polyglot repo.
2. Turborepo / Nx — task orchestration across packages; overkill at current size, revisit later.
3. Bazel — powerful polyglot builds, disproportionate complexity here.

## Decision

### 1. Architecture & data flow

```
┌────────────────────────── Zellij ──────────────────────────┐
│  zantiflow plugin (Rust → WASM, zellij-tile)                │
│   • request_permission: ReadApplicationState, WebAccess,    │
│     ReadPaneContents                                        │
│   • subscribe: SessionUpdate, Timer, WebRequestResult,      │
│     PermissionRequestResult                                 │
│   • every 1s (set_timeout re-armed on Timer):               │
│       build snapshot tree from latest SessionUpdate         │
│       + per-pane scrollback fingerprint (diff for activity) │
│       → web_request(POST, backend/snapshot, JSON body)      │
└───────────────────────────┬────────────────────────────────┘
                            │ HTTP POST application/json
                            ▼
┌──────────────── Express backend (Node + TS) ───────────────┐
│  POST /snapshot → validate → track per-pane change times    │
│  → clear console + print indented sessions>tabs>panes tree  │
│  (Unknown for panes with no observed update yet)            │
└─────────────────────────────────────────────────────────────┘
```

### 2. Cadence

The plugin subscribes to `EventType::Timer`, calls `set_timeout(1.0)` once, and re-arms
`set_timeout(1.0)` at the end of each `Timer` handler. The interval is a *minimum* (the host
schedules it; it may drift/coalesce under load) — treated as "~1s", not a real-time guarantee.

### 3. Data model / ordering

Source of truth is the `SessionUpdate` payload.

- **Sessions, "active first, then inactive":** ordered `current session` → `other live sessions` →
  `resurrectable/dead sessions`. Live sessions come from the first vec (`is_current_session` marks
  the current one); dead sessions come from the second vec (name + `diedSecondsAgo` only — Zellij
  gives **no tab/pane detail** for dead sessions, so they render as a name + death age).
- **Tabs:** taken from `SessionInfo.tabs`, ordered by `TabInfo.position`; the focused tab
  (`TabInfo.active`) is flagged.
- **Panes:** taken from `SessionInfo.panes` (`PaneManifest.panes: HashMap<tab_position,
  Vec<PaneInfo>>`), keyed back to their tab; name = `PaneInfo.title` (fallback to `terminal_command`,
  then `pane <id>`). Focused pane (`is_focused`) and `exited` are flagged.

### 4. Per-pane "last updated" (best-effort, derived)

Because Zellij exposes no output-recency signal, each tick the plugin computes a **fingerprint** of
each pane's current content (hash of a bounded tail of `get_pane_scrollback`) and includes it in the
snapshot. The **backend** compares a pane's fingerprint across consecutive snapshots (identity =
`session name + tab id + pane id`) and, on a change, stamps the change time using its own (Node)
clock — so timing lives where a real clock exists and survives the WASM sandbox's clock limitations.
A pane whose fingerprint has **not** yet changed since observation began has no known update time and
is rendered **`Unknown`** (this matches "wasn't updated before it started → Unknown").

*(Alternative considered: the plugin keeps a monotonic elapsed counter from `Timer` deltas and stamps
change times itself — authoritative at the source and survives backend restarts, but pushes
clock/bookkeeping into WASM. The backend-timed approach is the v1 default for simplicity.)*

### 5. Wire contract (v1)

> **Amended by [ADR-0002](0002-configurable-telemetry-privacy-controls.md):** the current wire
> contract is **v2**, which adds an optional top-level `machine` object and a stable per-session
> `sid`, and makes the `name`/`command` fields nullable (`null` = redacted). The v1 shape below
> still describes the tree; see ADR-0002 for the privacy-aware fields.

`POST /snapshot`, `Content-Type: application/json`:

```json
{
  "version": 1,
  "capturedAtTick": 42,
  "sessions": [
    {
      "name": "main",
      "isCurrent": true,
      "state": "live",
      "diedSecondsAgo": null,
      "tabs": [
        {
          "tabId": 0,
          "name": "editor",
          "position": 0,
          "active": true,
          "panes": [
            {
              "id": 1,
              "name": "nvim",
              "command": "nvim",
              "isFocused": true,
              "exited": false,
              "contentFingerprint": "a1b2c3d4"
            }
          ]
        }
      ]
    },
    {
      "name": "old-build",
      "isCurrent": false,
      "state": "resurrectable",
      "diedSecondsAgo": 312,
      "tabs": []
    }
  ]
}
```

Notes: `state` ∈ `"live" | "resurrectable"`. `contentFingerprint` is opaque to the backend (only
compared for equality). The backend derives each pane's `lastUpdated` from fingerprint changes; the
plugin does **not** send a timestamp in v1.

### 6. Backend behaviour

> **Amended by [ADR-0003](0003-multi-tenant-backend-and-token-auth.md):** the backend is now
> **multi-tenant and authenticated** — ingest moves to `POST /api/v1/ingest` with an
> `Authorization: Bearer` token, data persists per account/machine, and this console rendering is
> demoted to an optional dev/debug view. The single-user description below is retained for context.

A minimal Express app with one route (`POST /snapshot`). On each snapshot it updates its per-pane
last-change map, then **clears the console and re-renders** the tree with indentation, e.g.:

```
zantiflow — 3 sessions — 2026-07-10 18:42:07

● main (current) [live]
    ▸ editor (active)
        • nvim            updated 0.3s ago
        • shell           Unknown
    ▸ logs
        • tail -f app.log updated 1.2s ago
● build [live]
    ▸ tab-1 (active)
        • cargo watch     updated 0.1s ago
○ old-build [resurrectable, died 5m ago]
```

Panes with no observed update → `Unknown`. Rendering is intentionally basic (plain text +
indentation); no persistence or UI beyond the console in v1.

### 7. Permissions

The plugin requests, in one `request_permission(&[...])` call in `load()`: `ReadApplicationState`
(session/tab/pane updates), `WebAccess` (`web_request`), `ReadPaneContents` (scrollback for
fingerprints). Real logic is gated behind a granted `PermissionRequestResult`.

### 8. Monorepo tooling & layout (recorded here per ADR scope)

- **JS/TS:** **pnpm** workspaces; backend is Node + TypeScript + Express.
- **Rust:** **Cargo** workspace; plugin targets `wasm32-wasip1`; `zellij-tile` **pinned to an exact
  version** (the plugin API is `#[non_exhaustive]` and still evolving).
- **No** Nx/Turborepo/Bazel initially; revisit if package count grows. Task running via root scripts
  delegating to `pnpm --filter …` and `cargo …`.
- **Planned layout** (created by a later plan, not now):

```
zantiflow/
├── adrs/                     # ← created now
│   ├── README.md
│   └── 0001-zellij-session-telemetry-architecture.md
├── plans/                    # ← created now
├── apps/
│   ├── plugin/               # Rust crate → WASM (zellij-tile)   [later]
│   └── backend/              # Express + TypeScript              [later]
├── packages/
│   └── protocol/             # shared v1 wire-contract types/docs [later]
├── Cargo.toml                # Rust workspace                     [later]
├── package.json              # private root, pnpm workspace       [later]
├── pnpm-workspace.yaml       #                                    [later]
├── rust-toolchain.toml       #                                    [later]
└── README.md                 #                                    [later]
```

- Package names: crate `zantiflow-plugin`; npm `@zantiflow/backend`, `@zantiflow/protocol`.

## Consequences

**Positive**

- Thin, sandboxed plugin; all presentation/aggregation in an easy-to-iterate Node process.
- `SessionUpdate` gives the whole tree from one event; the wire contract is small and versioned.
- Uses only official Zellij APIs; permissions are explicit and least-privilege.
- Monorepo layout cleanly separates the polyglot pieces and a shared contract.

**Negative / costs**

- Per-pane activity is **approximate**: fingerprint-diffing sees *change*, not true new-byte counts;
  a repainting TUI (e.g. `htop`) looks perpetually "active", and content that scrolls past within a
  tick can be missed. Cost is O(panes × scrollback tail) per second.
- `web_request` is fire-and-forget; delivery/errors surface only via `WebRequestResult` and need
  handling (backend down, non-2xx) so the plugin degrades quietly.
- Polyglot repo means two toolchains (Cargo + pnpm) and a hand-maintained contract on both sides.

**Neutral**

- One ADR records two decisions (telemetry architecture + monorepo tooling); may be split later.

## Open Questions / Risks

1. **Pane activity detection is the headline risk.** Confirm `get_pane_scrollback` signature/sync
   behaviour and its permission on the pinned `zellij-tile` tag; evaluate the `PaneRenderReport` /
   `PaneRenderReportWithAnsi` events as an alternative (their per-pane opt-in mechanism, frequency,
   and permission were **not** verifiable and must be checked before relying on them). **Build task** — the real-Zellij smoke check (ADR-0014); default path is `get_pane_scrollback`, render-reports only if it is missing.
2. **`web_request` availability** depends on Zellij being built/allowed with web access; verify in
   the target environment and define fallback behaviour if denied. **Decided:** WebAccess denied & plugin warns & idles (no telemetry).
3. **WASM clock**: v1 avoids needing a wall clock in the plugin by timing in the backend; if we later
   move timing plugin-side, validate monotonic-counter accuracy vs `Timer` drift. **Decided:** backend-timed in v1; move plugin-side only if ever needed.
4. **Version pinning**: `Event`/`EventType`/`PermissionType` are `#[non_exhaustive]`; pin
   `zellij-tile` and re-verify field/enum names against that exact tag. **Decided:** pin an exact tag; the smoke check (ADR-0014) re-verifies field/enum names.
5. **Ordering semantics** of "active first, then inactive" assume current → other live →
   resurrectable; **decided:** confirmed.

## References

- Zellij plugin events — https://zellij.dev/documentation/plugin-api-events.html
- Zellij plugin commands — https://zellij.dev/documentation/plugin-api-commands.html
- `Event` enum — https://docs.rs/zellij-tile/latest/zellij_tile/prelude/enum.Event.html
- `SessionInfo` / `TabInfo` / `PaneInfo` / `PaneManifest` — https://docs.rs/zellij-tile/latest/zellij_tile/prelude/
- `PermissionType` — https://docs.rs/zellij-tile/latest/zellij_tile/prelude/enum.PermissionType.html
- `HttpVerb` — https://docs.rs/zellij-tile/latest/zellij_tile/prelude/enum.HttpVerb.html
- `zellij-tile` shim source — https://raw.githubusercontent.com/zellij-org/zellij/main/zellij-tile/src/shim.rs
