# ADR-0002 — Configurable privacy controls for what the plugin sends

- **Status:** Accepted
- **Amends:** [ADR-0001](0001-zellij-session-telemetry-architecture.md) — evolves the wire contract to **v2**
- **Extended by:** [ADR-0003](0003-multi-tenant-backend-and-token-auth.md) — adds plugin `token` / `server_url` config; wire contract → **v3**. [ADR-0016](0016-dashboard-page-and-pane-output.md) — adds an opt-in **`pane_output`** share axis (default OFF); pane output is a **separate on-demand channel** (ingest contract unchanged)
- **Amended by:** [ADR-0024](0024-opt-in-hostname-lookup.md) — the real-hostname lookup (and its `RunCommands` permission) is now **opt-in, OFF by default** (a new `hostname` flag), not the `full`-baseline default of `real`
- **Date:** 2026-07-10
- **Deciders:** project owner
- **Tags:** privacy, configuration, plugin, backend, telemetry
- **Testing:** unit (Model-A resolution, redaction) + BDD (hidden names never leave the plugin) — see [ADR-0014](0014-testing-strategy.md)

## Context

[ADR-0001](0001-zellij-session-telemetry-architecture.md) has the plugin push a full
sessions→tabs→panes tree to the backend every second. Those names are often sensitive: session and
tab names encode project/client names, pane titles and running commands can reveal file paths,
hostnames, or arguments. A user must be able to **choose what leaves their machine**.

This ADR adds a **privacy/redaction layer** governing four things:

- **Machine name** — send the real hostname, send a **custom alias**, or **hide** it entirely.
  (Note: machine identity is *not* in the ADR-0001 payload yet — this ADR introduces it.)
- **Session names** — send or hide.
- **Tab names** — send or hide.
- **Pane names** — send or hide (covers the pane title *and* its running command, since ADR-0001
  falls back to the command when the title is empty — redacting only the title would leak via the
  fallback).

There is one master switch, **`full`**, **on by default**, plus individual per-field overrides. The
backend must accept redacted payloads without breaking.

Grounding (verified against `zellij-tile`/zellij.dev/`data.rs`; see References):

- Plugins receive config as `BTreeMap<String, String>` in `load(configuration)`, set via layout KDL
  child braces or the `--configuration key=value,…` CLI flag. Keys/values are arbitrary strings.
- Settings can change **at runtime** via `Event::PluginConfigurationChanged(BTreeMap<String,String>)`
  delivered to `update` — no restart, **no permission** required. (The `Reconfigure` permission is
  unrelated: it mutates *global* Zellij config, not our plugin's.)
- Zellij exposes the **host machine name nowhere** (not in `SessionInfo`/`ModeInfo`). The only
  reliable way to obtain the real hostname is `run_command(&["hostname"], ctx)` + subscribing to
  `Event::RunCommandResult`, gated by the **`RunCommands`** permission. Env-var scraping is
  unreliable; reading `/etc/hostname` needs `FullHdAccess` + a mount remap.

## Decision Drivers

- **Redact at the source.** Filtering must happen in the plugin *before* data leaves the machine;
  backend-side filtering cannot protect privacy (the data has already been transmitted).
- Use Zellij's **native** plugin configuration (KDL/CLI) and its live-reload event — no bespoke
  config channel.
- **Least privilege:** only pull in `RunCommands` when the user actually wants the *real* hostname.
- Redaction must **not break activity tracking** (ADR-0001 keys pane activity partly on the session
  *name*).
- Safe defaults: opting into telemetry means `full` on by default, but a misconfigured restriction
  must never silently leak.

## Considered Options

**Where redaction happens**
1. **In the plugin, before send** *(chosen)* — the only place that actually protects privacy.
2. In the backend — rejected: data has already left the machine.

**Full vs per-field precedence** (see [ADR-0001] Q&A)
1. **Model A — `full` is the baseline, per-field settings override** *(chosen)* — run `full` and still
   hide, e.g., just pane names.
2. Model B — `full` is an all-or-nothing gate that ignores per-field settings when on — rejected as
   less flexible.

**How a hidden field is represented on the wire**
1. **Keep structure, null the name** *(chosen)* — send the node with `name: null` (backend renders
   `<hidden>`); preserves the tree and the ids used for tracking.
2. Omit the node entirely — rejected: loses counts/structure and breaks activity tracking.
3. Send a literal `"<hidden>"` string — rejected: conflates redaction with a real title of that text.

**Getting the real machine name**
1. **`run_command(["hostname"])` + `RunCommandResult`, `RunCommands` permission** *(chosen)* — simple,
   cross-platform, only requested when `machine_name` resolves to `real`.
2. Env vars (`HOSTNAME`) — unreliable/environment-dependent.
3. `/etc/hostname` via `FullHdAccess` + mount remap — heavier, Linux-centric.

## Decision

### 1. Settings & config keys

Read from the `configuration` map (all values are strings). Re-read on
`Event::PluginConfigurationChanged` so changes apply live.

| Key | Values | Meaning |
| --- | --- | --- |
| `full` | `"true"` \| `"false"` (default `true`) | Master baseline for every field below. |
| `machine_name` | `"real"` \| `"alias:<text>"` \| `"hidden"` | Machine identity. |
| `session_names` | `"send"` \| `"hidden"` | Session name visibility. |
| `tab_names` | `"send"` \| `"hidden"` | Tab name visibility. |
| `pane_names` | `"send"` \| `"hidden"` | Pane title **and** command visibility. |

Example (layout KDL):

```kdl
plugin location="file:/path/to/zantiflow-plugin.wasm" {
    full          "true"
    machine_name  "alias:red-laptop"
    pane_names    "hidden"
}
```

Example (CLI, e.g. from a keybinding):

```bash
zellij action launch-or-focus-plugin file:/path/to/zantiflow-plugin.wasm \
  --configuration "full=false,session_names=send"
```

### 2. Precedence (Model A) & resolution

Effective visibility per field:

- **Explicit valid value present** → use it.
- **Explicit but invalid value** (e.g. a typo) → **fail closed** to the most-private option
  (names → `hidden`, machine → `hidden`) and log a warning. A restriction typo must never leak.
- **Absent** → inherit from `full`: `full=true` ⇒ machine `real`, names `send`; `full=false` ⇒
  machine `hidden`, names `hidden`.
- `full` itself: absent or invalid → treated as `true` (its documented default; invalid is warned).
  `full` only sets baselines that per-field rules can still restrict, so defaulting it *on* cannot
  over-share beyond what the per-field rules allow.

Resulting examples:

| Config | machine | session | tab | pane |
| --- | --- | --- | --- | --- |
| `full=true` (only) | real | send | send | send |
| `full=true`, `pane_names=hidden` | real | send | send | **hidden** |
| `full=false` (only) | hidden | hidden | hidden | hidden |
| `full=false`, `session_names=send` | hidden | **send** | hidden | hidden |
| `machine_name=alias:foo` (`full=true`) | **alias:foo** | send | send | send |

### 3. Redaction semantics (structure preserved, names nulled)

Redaction only blanks **display names**; the **tree and its ids are always sent** so counts and
activity tracking survive.

- **Hidden session name** → `name: null`. Because Zellij gives sessions no stable id, the plugin
  attaches a **stable pseudonymous `sid`** (implementation: salted hash of the real name persisted in
  the plugin's `/cache`, or a per-run first-seen ordinal). This `sid` becomes the canonical session
  identity **even when names are sent**, so redaction never changes identity. *(This amends
  ADR-0001 §4: the activity-tracking key becomes `sid + tabId + paneId`, replacing the session
  name.)*
- **Hidden tab name** → `name: null`; identity stays `tabId`.
- **Hidden pane name** → `name: null` **and** `command: null`; identity stays the pane `id`.
- Machine hidden → `machine.source: "hidden"`, `machine.name: null`.

`contentFingerprint` (activity metadata from ADR-0001) is unaffected — it is an opaque one-way hash
and is governed by ADR-0001, not by these name controls. Suppressing activity/timing is out of scope
(see Open Questions).

### 4. Machine name sourcing

- `hidden` / `alias:<text>` → no host access needed; emit directly.
- `real` → the plugin lazily requests the **`RunCommands`** permission, runs `run_command(&["hostname"], ctx)`
  once, reads `Event::RunCommandResult`, caches the result (the hostname doesn't change), and emits
  it. If the permission is denied or the command fails, it **falls back to `hidden`** and warns.

`RunCommands` is requested **only** when `machine_name` resolves to `real` — users on `alias`/`hidden`
never see that prompt.

### 5. Config mechanism & live reload

- Parse settings in `load` from `configuration`.
- Subscribe to `EventType::PluginConfigurationChanged`; on receipt, re-parse and apply immediately —
  toggling privacy takes effect on the next tick without restarting the plugin.
- No `Reconfigure` permission is needed for any of this.

### 6. Wire contract v2

> **Extended by [ADR-0003](0003-multi-tenant-backend-and-token-auth.md):** the current contract is
> **v3**, which adds a top-level `machineId` and moves ingest to an authenticated
> `POST /api/v1/ingest` (the account/token are carried in the `Authorization` header, not the body).
> The v2 body below is otherwise unchanged.

Extends ADR-0001's v1. Changes: `version` → `2`; add top-level `machine` and `privacy`; add `sid`
per session; `name` on sessions/tabs/panes and `command` on panes become **nullable** (`null` =
redacted).

```json
{
  "version": 2,
  "capturedAtTick": 42,
  "privacy": {
    "full": true,
    "machine": "alias",
    "sessionNames": "send",
    "tabNames": "send",
    "paneNames": "hidden"
  },
  "machine": { "source": "alias", "name": "red-laptop" },
  "sessions": [
    {
      "sid": "s3f9a1c2",
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
              "name": null,
              "command": null,
              "isFocused": true,
              "exited": false,
              "contentFingerprint": "a1b2c3d4"
            }
          ]
        }
      ]
    }
  ]
}
```

- `machine.source` ∈ `"real" | "alias" | "hidden"`; `machine.name` is `null` when hidden.
- `privacy` echoes the **effective** settings so the backend (and user) can confirm what is in force.
- `name` (`null` = redacted) and pane `command` (`null` = redacted) are nullable throughout.

### 7. Backend acceptance

The Express backend accepts contract **v2** and degrades gracefully:

- Treat every name (`machine.name`, session/tab/pane `name`, pane `command`) as **optional/nullable** —
  never assume presence.
- Render a `null` name as **`<hidden>`** (kept distinct from **`Unknown`**, which remains ADR-0001's
  "no update observed yet" marker).
- `machine.source == "hidden"` → render `<machine hidden>`; otherwise render `machine.name`.
- Track pane activity by **`sid + tabId + paneId`** (per §3), so redaction doesn't disturb timing.
- Surface the `privacy` echo as a header note (e.g. `privacy: restricted (pane names hidden)`), so
  the user can see their config took effect.

Example console render (machine aliased, pane names hidden):

```
zantiflow — red-laptop — 2 sessions — privacy: restricted (pane names hidden) — 2026-07-10 18:42:07

● main (current) [live]
    ▸ editor (active)
        • <hidden>        updated 0.3s ago
● other [live]
    ▸ shell (active)
        • <hidden>        Unknown
```

### 8. Permissions summary

- Base (ADR-0001): `ReadApplicationState`, `WebAccess`, `ReadPaneContents`.
- **Added by this ADR:** `RunCommands` — **only** requested when `machine_name` resolves to `real`.
- `PluginConfigurationChanged` requires **no** permission.

## Consequences

**Positive**
- Genuine user control over what leaves the machine, via native Zellij config with **live reload**.
- Redaction preserves structure and activity tracking (via `sid`/`tabId`/`paneId`).
- Minimal permission footprint: `RunCommands` only for the real hostname.
- The `privacy` echo makes the effective policy visible and self-documenting.

**Negative / costs**
- Real hostname needs `RunCommands` + an async command and an extra permission prompt.
- Redaction is **name-only**: structure (session/tab/pane counts) and activity timing still leak by
  design in v2 — documented, with a stricter mode deferred (see Open Questions).
- `sid` via salted hash needs a persisted salt (in `/cache`) for cross-restart stability; the
  per-run ordinal alternative resets each run. Hashing low-entropy session names is a stable
  *pseudonym*, not cryptographic anonymity.
- The backend must treat all name fields as nullable (contract v2).

**Neutral**
- Amends ADR-0001 (wire contract v1 → v2; activity key name → `sid`). ADR-0001 carries a
  forward-pointer.

## Open Questions / Risks

1. **`PluginConfigurationChanged` trigger conditions** are only partially documented — verify live
   reload actually fires on config change in the target Zellij version; fallback is plugin restart. **Decided:** use it for live reload; verify the trigger at build.
2. **`sid` scheme** (salted-hash-in-`/cache` vs per-run ordinal) is an implementation choice; confirm
   the plugin can persist to `/cache` in the target sandbox. **Decided:** salted hash persisted in `/data` (cross-restart stable).
3. **Metadata still leaks** even when fully redacted (counts + activity timing). A stricter
   "counts-only" / activity-off / allowlist mode is a candidate for a future ADR. **Decided: not pursuing** — counts/timing metadata visibility is accepted.
4. **Granularity**: only global per-category toggles exist (no per-session/per-pane pattern rules,
   no separate `pane_commands` toggle) — deliberately out of scope for v2; note as possible future.
5. **`RunCommands` for the real hostname** is a heavier permission than base telemetry; some users
   may prefer `alias` specifically to avoid it — that trade-off is by design.

## References

- ADR-0001 — [Zellij-plugin session telemetry](0001-zellij-session-telemetry-architecture.md)
- Plugin configuration (KDL / CLI / `load`) — https://zellij.dev/documentation/plugin-api-configuration.html
- `ZellijPlugin::load` — https://docs.rs/zellij-tile/latest/zellij_tile/trait.ZellijPlugin.html
- Plugin events (`PluginConfigurationChanged`, `RunCommandResult`) — https://zellij.dev/documentation/plugin-api-events.html
- `Event` enum source — https://raw.githubusercontent.com/zellij-org/zellij/main/zellij-utils/src/data.rs
- Permissions (`RunCommands`, `Reconfigure`, `ReadSessionEnvironmentVariables`, `FullHdAccess`) — https://zellij.dev/documentation/plugin-api-permissions.html
- `run_command` / shim — https://docs.rs/zellij-tile/latest/zellij_tile/shim/index.html
- Plugin filesystem (`/cache`, `/data`, `/host`) — https://zellij.dev/documentation/plugin-api-file-system.html
- Prior art: zjstatus (config-driven plugin) — https://github.com/dj95/zjstatus
