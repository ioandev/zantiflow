# ADR-0052 — Debug pane-title audit lines (extends ADR-0049)

- **Status:** Accepted
- **Extends:** [ADR-0049](0049-plugin-debug-logging.md) — adds one line-kind to the `debug` log and
  widens its permitted content to include **observed pane titles**.
- **Relates to:** [ADR-0034](0034-reliable-claude-thinking-marker-freshness.md) — the claude-pane
  title marker these lines exist to audit.
- **Date:** 2026-07-22
- **Deciders:** project owner
- **Tags:** plugin, logging, observability, attentions
- **Testing:** plugin unit — `pane_title_lines` formats identity + claude verdict + freshness + the
  quoted/truncated raw title; all panes are observed (not only claude ones) and non-claude panes
  produce no claude-transition lines; snapshot builder collects titles + verdicts for every pane.
- **Wire contract:** unchanged (**v4**) — local log only.

## Context

Live debugging hit the limit of ADR-0049's lines: a pane running Claude Code went **unrecognized for
~64 s** (reported `claude=idle` while its content churned), then flipped to seen+thinking in a single
tick. The transition lines say *when* the verdict changed but not *what the detector saw* — the pane
title. Whether the title was genuinely unmarked (Claude Code writes no marker until its first turn)
or carried a **marker variant the detector doesn't match** (Claude Code has used several sparkle
glyphs — `✻` U+273B, `✶` U+2736, `✽` U+273D, `✢` U+2722 — while ADR-0034's detector accepts only `✳`
U+2733 and Braille spinner frames) cannot be settled without logging the title itself.

## Decision

When `debug` is on, **after each ingest-send line**, log **one audit line per observed pane**:
session, tab/pane id, the claude verdict (`claude=yes|no`), freshness (`fresh=yes|no`), and the
**raw pane title**, quote-escaped and truncated (~80 chars). Emitted only at send time (sends are
already coalesced by ADR-0026/0049), so volume stays bounded — no per-tick title spam even while a
spinner glyph cycles.

Mechanics: the snapshot builder's debug observations (`ClaudePaneObs` → generalized **`PaneObs`**)
now cover **every** pane — with `title` and an `is_claude` verdict — not just recognized claude
panes; the ADR-0049 transition differ filters on `is_claude` (behavior unchanged), and a new pure
`debuglog::pane_title_lines` renders the audit lines.

**Privacy:** pane titles may embed user text (Claude task names, program titles). They appear in the
**local** `zellij.log` only, behind the opt-in `debug` flag; the token and pane content/scrollback
remain never-logged (ADR-0018 §4). The wire is untouched — titles already reach it (redaction
permitting) as pane `name`s; these lines are pre-redaction *local* observations.

## Consequences

- Claude-marker detection becomes auditable in the field: if a marked title is ever unrecognized,
  the log shows the exact glyph, and the ADR-0034 marker set can be widened on evidence (a new ADR).
- Debug output grows by pane-count lines per send — acceptable behind the opt-in flag.
