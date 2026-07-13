# ADR-0005 — Attentions: pluggable state detectors with backend-enforced triggering

- **Status:** Accepted
- **Builds on:** [ADR-0001](0001-zellij-session-telemetry-architecture.md) (scrollback/activity), [ADR-0002](0002-configurable-telemetry-privacy-controls.md) (config + `ReadPaneContents`), [ADR-0003](0003-multi-tenant-backend-and-token-auth.md) (accounts/machines/ingest), [ADR-0004](0004-google-auth-owner-sign-in.md) (owner session)
- **Partly superseded by:** [ADR-0025](0025-claude-thinking-attention.md) — **reverses the "drop `claude.thinking`" decision** (§3 / Open-Question #1). Thinking is re-adopted as a built-in detector using Claude Code's fixed spinner-word vocabulary (not the full TUI parsing this ADR rejected). Everything else here stands.
- **Leads to:** ADR-0006 (notification delivery); the status website (ADR-0008) for display
- **Date:** 2026-07-10
- **Deciders:** project owner
- **Tags:** attentions, detection, plugin, backend, notifications
- **Testing:** unit (trash-checker heuristics) + BDD (silence/threshold → attention/trigger) — see [ADR-0014](0014-testing-strategy.md)
- **Wire contract:** → **v4**

## Context

Beyond raw session/pane structure, users care about *states worth acting on*: **"Claude needs my
input,"** **"Claude is thinking,"** **"a session stopped or detached."** We call these **attentions**.

We want (a) an **extensible** way to detect them and (b) a **policy layer** that decides when one
matters (e.g. needs-input sustained ≥5 min for free users / ≥1 min for pro) and **how often** it may
fire — feeding **notifications (ADR-0006)** and **website display (ADR-0008)**.

The split is forced by where data and authority live:

- **Detection must run in the plugin** — only it sees pane content (`get_pane_scrollback` +
  `ReadPaneContents`, ADR-0001/0002), the running command (`get_pane_running_command`), and session
  liveness (`SessionInfo.connected_clients`, the resurrectable list). Detection is **best-effort**,
  inheriting ADR-0001's content-diff approximations.
- **Policy + enforcement must run in the backend** — it is authoritative, multi-tenant, tier-aware,
  drives notifications, and survives the plugin dying.

## Decision Drivers

- Extensible — "attentions as plugins of the plugin"; add types without churn.
- Detection (plugin) vs policy/enforcement (backend) split matches data + authority.
- Reuse existing content access; add **no new permissions**.
- Tier-aware thresholds (free/pro) and anti-spam frequency, centralized in the backend.
- Robust to the plugin dying (backend infers "stopped" from update staleness).

## Considered Options

- **Extension model:** *hybrid* (built-in Rust modules **+** config-defined pattern attentions)
  *(chosen, per project owner)* vs config-only (brittle for TUI states) vs built-in-only (not
  user-extensible).
- **Where thresholds/frequency are enforced:** *backend* *(chosen)* — tier-aware, anti-spam,
  account-scoped; the plugin lacks that context and would drift. vs plugin-side (rejected).
- **Transport:** attentions ride the 1s snapshot (+ optional transition-triggered prompt send)
  *(chosen)* vs a separate attentions endpoint (rejected — reuse ingest).
- **Stop/detach detection:** *both* plugin (`connected_clients`, resurrectable list) **and** backend
  staleness inference *(chosen)* — plugin can't self-report its own session stopping; backend alone
  misses detach.

## Decision

### 1. Attention model (hybrid)

An attention is a module behind a common trait, registered and enabled/tuned via config:

```rust
trait Attention {
    fn id(&self) -> &str;                       // e.g. "claude.needs-input"
    fn evaluate(&mut self, ctx: &TickCtx) -> Vec<Observation>;
}
```

- **Built-in modules (Rust):** `claude.needs-input`, `claude.thinking`, `session.detached`,
  `session.stopped` — complex/TUI-aware logic lives here.
- **Config-defined pattern attentions:** a generic module parameterized entirely by config
  (`{ id, pattern, scope, watch_cmd?, … }`), so users add simple attentions **with no code**.

Both emit the same `Observation`.

### 2. `Observation` (what a detector emits)

- `type` — the attention id (`claude.needs-input`).
- `target` — `{ machineId, sessionSid?, tabId?, paneId? }` (identity from ADR-0003/0002).
- `state` — `active` | `cleared`.
- `since` — when the plugin first saw it active (relative, per ADR-0001's clock caveat; the backend
  stamps authoritative time).
- `detail?` — optional small string; **subject to ADR-0002 privacy** (redacted when the scope's
  names are hidden; off by default).

### 3. Detection specifics (built-ins)

- **`claude.needs-input`** — a set of **cheap heuristics** (a "trash checker"), gated to panes running
  `claude` (`get_pane_running_command`), over the pane's rendered tail — best-effort, configurable,
  versioned:
    - **output-silence** — no new stdout for ≥ the tier threshold (5 min free / 1 min pro); **and/or**
    - **prompt-dwell** — the last non-blank line matches a prompt pattern (e.g. **ends with `?`**) and
      stays unchanged for ≥ a dwell (default **15 s**).
  Content is inspected **locally**; only the attention *type* leaves the machine (never the matched
  text — see §2 `detail`). *(Full TUI-state parsing is dropped — too brittle. The `claude.thinking`
  attention was dropped here too, then **re-adopted by [ADR-0025](0025-claude-thinking-attention.md)**
  via Claude Code's fixed spinner-word list — a closed vocabulary, not open TUI parsing.)*
- **`session.detached`** — a live session with `connected_clients == 0` (FINDINGS §3).
- **`session.stopped`** — a session leaving the live set: **plugin-detectable** for *other* sessions
  (they move to the resurrectable list in `SessionUpdate`), and **backend-inferred** for the plugin's
  own machine/session via **update staleness** (no snapshot within a grace window → stopped). Both
  paths converge on the backend.

### 4. Plugin-side behavior ("decides or not to send")

- Observations ride the regular 1s snapshot (wire contract v4).
- On a **state transition** (active↔cleared) the plugin may send a **prompt out-of-cycle update** so
  the backend can start/stop timing promptly; a small local **significance filter/debounce** ("decides
  or not to send") suppresses flapping.
- The plugin owns **no** thresholds/tiers — those are the backend's.

### 5. Backend policy & enforcement (authoritative)

- **Per-attention policy** (account-configurable, tier-gated defaults): `threshold` (minimum active
  duration before firing — needs-input free ≥5 min, pro ≥1 min), `cooldown`/frequency (how often it
  may fire per target — anti-spam), `action` (`notify` → ADR-0006, and/or `display` → website).
- The backend tracks each attention **episode** per target (first-active via its own clock, current
  duration, last-fired). When an active attention's duration ≥ `threshold` and it is outside
  `cooldown`, the backend **fires a trigger**; clearing ends the episode.
- **"How often they are triggered"** = this threshold + cooldown logic, tier-aware, lives here — the
  plugin reports freely, the backend decides.
- **Staleness** drives `session.stopped` / machine-offline: last snapshot older than the grace window
  → raise the stop attention (website + optional notify).

### 6. Tiering

Account gains a minimal `tier` (`free` | `pro`) used **only as a policy input** here (free thresholds
≥5 min; pro permits ≥1 min and tighter cadence). How tiers are **assigned/billed is out of scope**
(future ADR) — this is just the hook the 5-min/1-min example needs.

### 7. Configuration split

- **Plugin** (KDL/CLI, live via `PluginConfigurationChanged`, ADR-0002): enable/disable attentions,
  per-attention params (`watch_cmd`, `pattern`, `scope`), local debounce. Uses existing
  `ReadPaneContents` + `ReadApplicationState` — **no new permission**.
- **Backend** (per account, via the owner-authenticated management API, ADR-0004; defaults tier-gated):
  thresholds, cooldowns, actions. Enforcement is server-side.

### 8. Wire contract v4

Extends v3 with a top-level **`attentions`** array; `version` → `4`. Backend-derived attentions
(staleness) are added server-side, not sent by the plugin.

```json
{
  "version": 4,
  "machineId": "m-7f3a1c2e",
  "capturedAtTick": 42,
  "attentions": [
    { "type": "claude.needs-input", "target": { "sessionSid": "s3f9a1c2", "tabId": 0, "paneId": 1 },
      "state": "active", "since": 40 },
    { "type": "session.detached", "target": { "sessionSid": "s9c2" }, "state": "active", "since": 12 }
  ],
  "privacy": { "...": "..." },
  "machine": { "...": "..." },
  "sessions": [ "…v3 tree…" ]
}
```

### 9. Website (ADR-0008)

`session.stopped` / `detached` and other `display`-action attentions are stored per account/machine
and surfaced by the website. Only the storage + trigger are defined here.

## Consequences

**Positive**
- Extensible detection; clean plugin-detect / backend-enforce split matching data + authority.
- Reuses existing permissions; tier-aware, anti-spam triggering centralized in one place.
- Robust to plugin death via staleness; feeds notifications and the website uniformly.

**Negative / costs**
- Detection is **best-effort**: content patterns + TUI drift → maintenance and false pos/neg; Claude
  patterns are brittle and need versioning.
- More backend state (episodes per target) and a policy-config surface.
- Introduces a **tier** concept — must stay a bounded policy hook, not creep into monetization here.
- Wire contract v3 → v4. Local pattern scanning shares ADR-0001/0002 cost/privacy considerations
  (scanning is **local-only**; only the attention *type* leaves the machine unless `detail` is sent).

**Neutral**
- Pushes the website to ADR-0008; notification **delivery** is deferred to ADR-0006.

## Open Questions / Risks

1. **Claude detection** — **decided:** cheap heuristics (output-silence + last-line prompt-dwell, e.g.
   ends-with-`?` for ≥15 s), configurable/versioned; full TUI parsing and `thinking` dropped. A
   machine-readable Claude status (hook/status file) remains a future improvement.
2. **`detail` privacy** — **decided: off** — attentions carry only their *type* + *target*, never
   content snippets (even the matched `?` line stays local).
3. **Staleness window vs detach** — **decided:** `detached` = `connected_clients 0`; `session.stopped`
   only after ~**30–60 s** of missed updates (grace), so brief network gaps don't false-fire.
4. **Tier assignment/billing** — deferred; keep the policy hook free of product decisions. **Resolved by ADR-0011:** promo codes (paid billing declined, ADR-0013).
5. **Config pattern safety** — arbitrary regex over pane content risks ReDoS/cost; cap pattern
   complexity and scanned bytes. **Decided:** anchored/substring patterns + a scanned-bytes cap (last N KB); no unbounded regex.
6. **Where account attention policy is edited** (website settings vs API) — finalize with ADR-0008. **Decided:** edited in the web app (ADR-0008) via the ADR-0005 §7 management API.
7. **Cadence** — base stays 1s; transition prompt-sends are additive, not a cadence change. **Decided.**

## References

- ADR-0001 (scrollback/activity), ADR-0002 (config, `ReadPaneContents`, privacy), ADR-0003
  (accounts/machines/ingest/staleness), ADR-0004 (owner-auth for backend policy config)
- FINDINGS §3 (`connected_clients`), §11 (`get_pane_running_command` / `get_pane_scrollback`) — [FINDINGS.md](../FINDINGS.md)
- Next: **ADR-0006 — notifications** (delivery of fired attentions to the user)
