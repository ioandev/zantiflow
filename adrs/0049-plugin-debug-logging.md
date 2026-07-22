# ADR-0049 — Plugin debug logging behind a `debug` config flag

- **Status:** Accepted
- **Amends:** [ADR-0018](0018-engineering-and-operational-conventions.md) — adds `debug` to the plugin
  config key catalog (§3) and extends the logging conventions (§6) to the plugin side.
- **Builds on:** [ADR-0005](0005-attentions-detection-and-triggering.md) (attention model),
  [ADR-0026](0026-minimise-plugin-update-cadence.md) (change-driven send cadence),
  [ADR-0034](0034-reliable-claude-thinking-marker-freshness.md) (claude-pane content-freshness),
  [ADR-0027](0027-machine-idle-claude-attention.md) (the backend-derived `claude.idle` these logs
  make debuggable from the plugin side)
- **Date:** 2026-07-22
- **Deciders:** project owner
- **Tags:** plugin, logging, observability, config
- **Testing:** plugin unit — config parse (`debug` defaults OFF; invalid value warns and stays OFF);
  the `debuglog` differ (attention onset/clear lines; per-pane claude freshness transitions; the
  machine-level all-idle ↔ active edge; an unchanged tick produces **no** lines); cadence
  (`decide_reason` names exactly the branch `decide` fires on); snapshot builder (claude-pane
  observations are collected with the same freshness the thinking detector used). See
  [ADR-0014](0014-testing-strategy.md).
- **Wire contract:** unchanged (**v4**) — debug logging is local-only; nothing new leaves the machine.

## Context

The plugin's only observability today is a handful of always-on `HostPort::log` lines (version on
load, config warnings, pairing milestones, non-2xx responses). They reach Zellij's own log file
(`zellij.log` — plugin stderr is captured there; the directory is shown by `zellij setup --check`),
which is fine as a sink, but the *content* is far too thin to debug the behaviors that have actually
bitten us (ADR-0034's frozen-spinner bug was diagnosed by rebuilding with ad-hoc `eprintln!`s):

- **What did the attention detectors decide, and when?** `claude.needs-input` / `claude.thinking`
  onsets and clears are invisible — you only see their *effect* on the dashboard, tiers of
  backend-side thresholding later.
- **When did a snapshot actually get POSTed, and what was in it?** ADR-0026's send-gate makes sends
  deliberately rare and reason-dependent (forced / notable / content-floor / keepalive); when "the
  dashboard is stale" there is no way to tell "plugin never sent" from "backend never applied".
- **What is the claude activity picture across sessions?** The per-pane content-freshness signal
  (ADR-0034) is what feeds — via each pane's `contentFingerprint` — the backend's machine-level
  `claude.idle` sweep (ADR-0027, "every claude pane idle past the tier threshold"). Whether the
  plugin currently sees *any* claude pane producing output is exactly the fact one needs when
  `claude.idle` fires (or fails to fire) unexpectedly, and it is recorded nowhere.

A debugger inside the WASM sandbox is not practical, and always-on verbose logging would spam every
user's `zellij.log` ~1/s. Per-second logging is also pointless: the interesting facts are edges, not
levels.

## Decision

Add a **`debug` plugin config key** (bool; **default OFF**; invalid → warn + OFF; live-toggleable via
`PluginConfigurationChanged` like every other key) that enables **transition-only debug lines**
through the existing `HostPort::log` sink (plugin stderr → `zellij.log`). No separate log file, no
new permission, no wire change.

When ON, the plugin logs (all lines prefixed `debug:` so they grep cleanly):

1. **Attention transitions** — one line per onset and per clear of each detected attention
   (`type @ <sid-prefix>:<tab>:<pane>`), the moment the detector's output changes — independent of
   whether a snapshot was sent yet.
2. **Ingest sends** — one line per actual POST: the send **reason** (`first` / `forced` / `notable` /
   `content` / `keepalive`, from the ADR-0026 gate), session/pane counts, the attention list on the
   wire, and the body size. Skipped ticks log nothing (an idle, unwatched machine stays silent).
3. **Claude activity across sessions** — per claude pane (identified per ADR-0034), a line when it is
   first seen, when it turns **active** (content fresh — producing output), **idle** (output
   settled), and when it disappears; plus the **machine-level edge**: one line when the plugin's view
   crosses "≥1 claude pane producing output" ↔ "all claude panes idle" (the local leading indicator
   of the backend's `claude.idle`, which fires after its tier threshold of all-idle).
4. **Flag edges** — one line when debug logging turns ON (at load or live-reconfigure) and a final
   one when it turns OFF.

**Privacy:** debug lines may include *local* session names, tab/pane ids, truncated sids, attention
types, counts, and byte sizes. They must **never** include the ingest token, pane content/scrollback,
or captured output lines (upholding ADR-0018 §4 "never log secrets or pane content" and the
`HostPort::log` contract). The log is written by Zellij to the local machine only.

**Mechanics (ADR-0015-conformant):** the differ is a new pure module — `debuglog::DebugState`, fed
once per telemetry tick with the built snapshot's attentions plus per-claude-pane freshness
observations (`ClaudePaneObs`, collected by the snapshot builder from the same
`activity::PaneActivity` verdicts the thinking detector uses); it returns the lines to emit, so the
whole policy unit-tests natively without Zellij. The ADR-0026 send-gate gains
`SendGate::decide_reason(...) -> Option<SendReason>` (with `decide` delegating to it) so the send
line can name the branch that fired.

## Alternatives considered

- **A dedicated log file in `/data` or `/cache`** — the sandbox allows it (WASI `std::fs`, no extra
  permission), but it needs growth capping, a host-side "where is it" story, and adds a second sink
  for no gain while `zellij.log` already exists and rotates with Zellij. Revisit only if mixing with
  Zellij's own log proves painful.
- **Always-on verbose logging** — spams every user's `zellij.log` and violates the "quiet by
  default" posture; rejected.
- **A `log_level` key (error/warn/info/debug)** — over-engineered for one consumer; the existing
  lines stay always-on, everything new sits behind the single bool. A future ADR can graduate it.
- **Sending debug info to the backend** — never: debugging must not change what leaves the machine.

## Consequences

- Field debugging of attention detection, send cadence, and the claude-idle picture becomes a
  config flip (`debug on`) + `tail -f` of `zellij.log`, with no rebuild.
- Transition-only volume: an idle machine logs nothing; a busy claude session logs a handful of
  lines per turn boundary plus one line per (already-coalesced) send.
- Toggling debug ON mid-run emits the current state as an initial burst of "transitions" (the differ
  starts empty) — accepted, and useful as a state dump.
- One more config key to document in the plugin getting-started guide (ADR-0022/0023 docs).
