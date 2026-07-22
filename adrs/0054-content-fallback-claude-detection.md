# ADR-0054 — Content-fallback Claude detection (and content-anchored thinking) for unmarked panes

- **Status:** Accepted
- **Partly supersedes:** [ADR-0034](0034-reliable-claude-thinking-marker-freshness.md) — keeps the
  title marker as the primary signal and freshness as the thinking qualifier, but drops its implicit
  "title is the only identity signal" stance for panes whose scrollback we can read.
- **Revives (narrowed):** the `esc to interrupt` anchor from [ADR-0025](0025-claude-thinking-attention.md) —
  rejected there as a *thinking* detector paired with gerund-scanning; used here as a *turn-in-flight*
  anchor only where no title marker exists.
- **Relates to:** [ADR-0052](0052-debug-pane-title-audit-lines.md) (the audit lines that measured the gap),
  [ADR-0051](0051-tier-aware-heartbeat-snapshots.md) (`claudeActive` counts these panes too)
- **Date:** 2026-07-22
- **Deciders:** project owner
- **Tags:** plugin, attentions, detection
- **Testing:** plugin unit — `is_claude_content` (chrome+anchor conjunction; anchor-only and
  chrome-only both rejected; tail-window bounded); snapshot builder (an unmarked-title pane with
  Claude UI content is observed `is_claude`, fires `claude.thinking` while fresh with a
  turn-in-flight tail, counts toward `claudeActive`; a cross-session pane — no scrollback — is
  unaffected); needs-input precedence unchanged.
- **Wire contract:** unchanged (**v4**) — `Attention.type` values unchanged; detection is local.

## Context

Measured live (2026-07-22, via the ADR-0052 audit lines), two incidents with one root cause:

1. A freshly launched Claude Code ran a streaming turn for **~4.5 minutes** (pane continuously fresh
   from 15:38:55) while the plugin still saw the shell's prompt title; the spinner title reached it
   only at 15:43:18. No `claude.thinking` fired; `claudeActive` stayed false.
2. After an interrupt, the pane's on-screen title flipped `⠂` → `✳` promptly — but the plugin kept
   reporting the frozen `⠂` until **15:54:55**, ~8 minutes later.

The root cause is not (only) when Claude Code writes titles: **Zellij does not emit `SessionUpdate`
for title-only changes**, so the plugin's cached tree — including every pane title — goes stale
until some unrelated session event (tab/focus/layout change) happens to fire one. Title-based
detection is therefore not merely *eventual* — it is **arbitrarily late**. Meanwhile the plugin
already reads every own-session pane's viewport **every tick** for the activity fingerprint, so pane
*content* is the one signal that is always ≤1 s fresh. A pre-first-turn Claude waiting at its input
box additionally can never fire `claude.needs-input` under title-only identity.

## Decision

For a pane whose **scrollback is readable** (own-session panes — the plugin already reads every
pane's viewport each tick for the activity fingerprint; cross-session panes return nothing and are
unaffected), recognize Claude Code by its **UI in the visible tail** (last ~15 lines), requiring a
**conjunction of two distinct signatures** (verified against a live pane dump, 2026-07-22):

1. **Prompt chrome** — a tail line whose trimmed form starts with `❯` (this version's prompt row)
   or `│ >` (the older bordered input box), and
2. **A textual anchor** — a tail line containing `esc to interrupt` (turn in flight) or
   `? for shortcuts` (idle at the prompt).

Additionally, for a Claude pane whose title carries **no live spinner frame** (stale or `✳`),
`claude.thinking` may be qualified by the **content anchor**: fresh (ADR-0034 unchanged) **and**
`esc to interrupt` in the tail — this is what makes turn detection ~1 s-fresh regardless of title
delivery. Marker-based thinking, needs-input precedence, and the freshness rule are untouched.

## Alternatives considered

- **Do nothing (title-eventually-arrives)** — leaves a multi-minute hole exactly when a new Claude
  is busiest, and needs-input permanently broken pre-first-turn. Rejected by field evidence.
- **Single-signature match** — `esc to interrupt` alone false-positives on panes *displaying* such
  text (editors viewing this repo's own ADRs quote it). The chrome+anchor conjunction in the tail
  window keeps that residual risk small; a false positive is cosmetic (labeling/attention noise),
  never a privacy change.
- **Gerund-scanning (ADR-0025's full detector)** — still rejected; identity is a weaker claim than
  state, and freshness remains the state qualifier.

## Consequences

- A just-launched or resumed Claude is detected within ~1 tick of its UI rendering, not minutes
  later; needs-input works before the first turn; `claudeActive`/dashboard "Claude only" include it.
- Cross-session panes still rely on the title marker (scrollback unreadable) — the backend's
  per-machine merge (ADR-0027) is unchanged.
- A pane scrolled so its input box is off-viewport falls back to title-only detection — acceptable:
  the box is pinned to the bottom in normal operation.
