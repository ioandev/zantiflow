# ADR-0055 — Per-pane `claude` flag on the wire; `claude.idle` keys on it

- **Status:** Accepted
- **Fixes:** [ADR-0027](0027-machine-idle-claude-attention.md)'s implementation — `claude.idle` could
  **never fire**: its pane scope matched Claude panes by the pane **command**, which Zellij reports as
  `null` (the exact lesson of [ADR-0034](0034-reliable-claude-thinking-marker-freshness.md), never
  applied to this module — and its tests fixtured `command: 'claude'`, a world Zellij doesn't provide).
- **Builds on:** [ADR-0054](0054-content-fallback-claude-detection.md) (the plugin's content-based
  verdict this flag transports), [ADR-0051](0051-tier-aware-heartbeat-snapshots.md) (the additive-
  optional wire pattern, `claudeActive`)
- **Date:** 2026-07-22
- **Deciders:** project owner
- **Tags:** plugin, backend, attentions, wire
- **Testing:** protocol unit — `isClaudePane` honors the flag (true wins; absent falls back to
  marker/command); wire schema accepts/omits `claude`. Backend unit — `watchedPaneKeys` with
  realistic panes (null command + marker name; flag + unmarked name; legacy command-only; zero
  claude panes → cleared). Plugin unit — the built pane carries the detector's verdict.
- **Wire contract:** **v4 unchanged** — one additive optional pane field (`claude`); the backend
  schema was tolerant, old plugins omit it, old backends strip it.

## Context

`claude.idle` ("all your Claude agents went quiet", ADR-0027 — the flagship Telegram/Discord
notification) never fired in the field: `idle.ts`'s `watchedPaneKeys` selected Claude panes via
`isClaudeCommand(p.command)`, and Zellij reports `command: null` for every pane — so every machine
had zero watched panes, making the all-idle predicate vacuous (correctly suppressed). Meanwhile the
plugin now holds the **best available** per-pane verdict (title marker OR live-content signatures,
ADR-0054) — including panes the backend cannot classify at all, e.g. a content-detected Claude whose
pane name is a plain `"Pane #1"`. The backend re-deriving identity from stored names is strictly
worse than transporting the plugin's verdict.

## Decision

1. **Wire:** each pane gains an **additive optional `claude: boolean`** — the plugin's detection
   verdict (marker or content, ADR-0034/0052), set on every pane it reports. Still v4.
2. **Protocol helper:** `isClaudePane` (shared by spotlight/dashboard) accepts the optional flag and
   honors it **first**, falling back to the name marker / command for old plugins. Spotlight and any
   name-marker consumer thereby inherit the fix for unmarked (content-detected) panes.
3. **`idle.ts`:** the `claude-only` / `claude-sessions` scopes classify panes via `isClaudePane`
   (flag → marker → command) instead of command-only. Tests re-fixtured to Zellij reality
   (`command: null`), keeping one command-only case as the legacy fallback.

## Consequences

- `claude.idle` fires for real: pro machines notify ~60–80 s after the last Claude pane goes quiet
  (60 s threshold + ~20 s sweep), free after ~5 min — through the already-working delivery chain.
- Redaction note: the flag reveals "this pane runs Claude" even when names are hidden — consistent
  with the wire already carrying per-pane attentions targeting Claude panes and `claudeActive`
  (ADR-0051); structure/kind leaks by design (ADR-0002), content never.
- The flag participates in the change signature's structural hash (a pane becoming/ceasing Claude is
  a notable change → sent promptly), which is the desired latency for the idle clock.
