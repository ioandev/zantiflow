# ADR-0025 — Re-adopt `claude.thinking` via the spinner-word vocabulary

- **Status:** Accepted — **detector superseded in part by [ADR-0034](0034-reliable-claude-thinking-marker-freshness.md)**: the attention stays, but it now reads the pane-TITLE marker (not the tab name) gated on the pane-title/command (not the null command) and requires observed output freshness, so a spinner frame Claude leaves frozen on a finished pane no longer reads as "thinking".
- **Supersedes (in part):** [ADR-0005](0005-attentions-detection-and-triggering.md) — reverses its decision to **drop** the `claude.thinking` attention. ADR-0005's detect-in-plugin / enforce-in-backend split, `Observation` shape, wire contract v4, and every other attention are unchanged; only the "thinking dropped, too brittle" conclusion is replaced. The detector recognises the **status spinner Claude Code prefixes onto the tab name**, not open-ended TUI state.
- **Builds on:** [ADR-0001](0001-zellij-session-telemetry-architecture.md) (scrollback), [ADR-0002](0002-configurable-telemetry-privacy-controls.md) (`ReadPaneContents`, privacy), [ADR-0005](0005-attentions-detection-and-triggering.md) (attention model), [ADR-0008](0008-status-website.md) (display)
- **Date:** 2026-07-11
- **Deciders:** project owner
- **Tags:** attentions, detection, plugin, dashboard
- **Testing:** unit (detector: a tab name with a leading Braille spinner frame → thinking; the idle
  `✳` sparkle and plain / other-glyph-led names rejected; leading and padding whitespace tolerated) +
  snapshot-builder test (a `claude` pane whose tab name carries a spinner → `claude.thinking`, a prompt
  tail still winning → `claude.needs-input`) + a web full-path render test (`AttentionView` →
  `MachineDetail` → the pane's busy "thinking…" indicator) — see [ADR-0014](0014-testing-strategy.md)
- **Wire contract:** unchanged (**v4**) — `Attention.type` is an open string; a new type needs no schema bump.

## Context

ADR-0005 §1 listed `claude.thinking` as a built-in detector, but §3 and Open-Question #1 then
**dropped** it: the only detection idea on the table was *full TUI-state parsing*, judged too brittle
to maintain. "Claude is thinking" was left as an explicit non-goal.

Two things have changed since:

1. **A robust signal exists.** While it is working, Claude Code prefixes the **tab name** with a
   cycling Braille spinner frame followed by a short task summary, then swaps that leading glyph for a
   static `✳` sparkle once it goes idle:

   ```text
   ⠐ Implement homepage from design file   <- working: leading Braille spinner frame
   ✳ Fix tabs showing output…              <- idle:    static sparkle
   ```

   So "the tab name begins (after any whitespace) with a Braille spinner glyph" is a cheap, one-glyph
   check — not the open-ended TUI parsing ADR-0005 rejected, and cheaper still than scanning the pane's
   scrollback. The exact frame cycles tick to tick (`⠋`/`⠙`/`⠐`/…), so we match the whole Braille
   Patterns block rather than a fixed glyph; the idle `✳` sparkle lives in a different block and so does
   not match. It stays best-effort — the leading glyphs are Claude Code's and can change — but it is a
   genuine, low-cost heuristic in exactly the spirit of ADR-0005 §3's "trash checker". *(An earlier cut
   scanned the scrollback tail for a `Gerund…` spinner word plus an `esc to interrupt` / `still thinking`
   status anchor across the visible lines; the tab-name glyph is a simpler, more direct signal that needs
   no scrollback read.)*
2. **The backend already assumes it exists.** `attentions/policy.ts` gives `claude.thinking` a
   threshold and `notifications/service.ts` renders "Claude is thinking" — the type flowed through
   every type-agnostic layer, only the plugin never emitted it and the dashboard never distinguished
   it. This ADR closes that gap rather than opening a new surface.

"Thinking" is also **semantically distinct** from the other attentions: it means *Claude is busy*, not
*Claude needs you*. Folding it into the existing amber "needs attention" badge would mislabel an
actively-working session as one demanding action.

## Decision

### 1. Re-adopt `claude.thinking` as a built-in plugin detector

Gated exactly like `claude.needs-input` (ADR-0005 §3): only for panes whose running command is
`claude`. Off the **tab name** (already observed each tick as part of the session tree):

- **Signal:** the tab name, after any leading whitespace, **begins with a Braille spinner glyph** — a
  char in the Unicode Braille Patterns block (U+2801..=U+28FF; the blank U+2800 is excluded). This is
  the frame Claude Code cycles at the head of the name while a turn is in flight (`⠐ Implement homepage
  from design file`). Once idle, that leading glyph becomes a static `✳` sparkle
  (`✳ Fix tabs showing output…`), which is *not* in the Braille block and so does not match.
- **Match the whole block, not a fixed frame.** The spinner glyph cycles from tick to tick
  (`⠋`/`⠙`/`⠐`/…) and may carry padding whitespace around it, so the detector keys on "first
  non-whitespace char is a Braille pattern" rather than any single glyph — robust to whichever frame is
  currently drawn.
- **No scrollback read for thinking.** Unlike needs-input, thinking no longer scans the pane's tail; it
  reads the tab name the snapshot already carries. The leading-glyph vocabulary is Claude Code's and can
  drift, so it is expected to be revisited like any best-effort heuristic here.
- **Inspected locally**; per ADR-0005 §2 and Open-Question #2, only the attention **`type`**
  (`claude.thinking`) + target leaves the machine — never the tab name itself (`detail` stays off).

### 2. Precedence: an explicit prompt wins over a spinner word

When a `claude` pane's tail ends on a prompt (`claude.needs-input`'s last-line-`?` rule) **and** its tab
name still shows a spinner glyph, the plugin emits **`claude.needs-input`**, not `claude.thinking`. The
current prompt is the more specific, more actionable state. In practice the two rarely co-occur — the
tab-name spinner clears once Claude is waiting — so this only disambiguates a lagging tab title. At most
one of the two fires per pane.

### 3. Backend: unchanged, already correct

No plugin-side thresholds (ADR-0005 §4). The backend's existing episode engine, tier-aware
`thresholdSeconds` (thinking shares the needs-input family: ≥5 min free / ≥1 min pro before it may
*fire a notification*), and `cooldownSeconds` apply as-is. Note the distinction ADR-0008 already draws:
an attention is **displayed as soon as it is active**; the threshold only gates *notification firing*.
So a thinking pane lights up on the dashboard immediately, while a "Claude is thinking" push (if the
account enables it) still waits out the anti-spam threshold.

### 4. Dashboard: a distinct "thinking" indicator (not "needs attention")

Per its own semantics, thinking renders separately from the amber needs-attention family:

- **Pane row / session card / machine card:** a distinct **"thinking"** pill and a busy activity
  indicator, visually separate from the amber "needs attention" / "quiet Xm" state.
- **Counts:** `claude.thinking` is **excluded** from a machine's "N need attention" count and surfaced
  as its own "N thinking" count, so an actively-working Claude never reads as one demanding action.

This lives inside the vendored v2 dashboard's existing pill/activity vocabulary; broader presentation
stays governed by ADR-0019 (build to sensible defaults).

## Consequences

**Positive**
- Users see *"Claude is thinking"* at a glance — the most-requested state after needs-input — at
  near-zero cost: a one-glyph check on the tab name the snapshot already carries (no scrollback read
  for thinking, no new permission, no wire-contract change).
- Reconciles a real inconsistency: the backend already spoke `claude.thinking`; now the plugin emits it
  and the dashboard shows it distinctly.

**Negative / costs**
- **Best-effort, and coupled to Claude Code's UI.** Keying on a leading Braille spinner glyph in the tab
  name is far less prose-prone than scanning content, but the glyph vocabulary is Claude Code's and can
  change — if it stops prefixing the tab name, or uses a non-Braille frame, the badge silently stops (a
  false-negative, which is safe). It also assumes the host surfaces Claude's title into the tab name. A
  machine-readable Claude status (hook/status file) remains the future upgrade (as ADR-0005
  Open-Question #1 already noted).
- Adds a single leading-char check on each `claude` pane's tab name per tick — bounded and cheap, and
  drops the thinking detector's former scrollback scan entirely.

**Neutral**
- Type stays an open string on the wire; nothing downstream needed a contract change.

## References

- [ADR-0005](0005-attentions-detection-and-triggering.md) §1–§5 (attention model, detection, policy) —
  this ADR revives its `claude.thinking` entry with a concrete detector.
- [ADR-0002](0002-configurable-telemetry-privacy-controls.md) (local-only scanning, `detail` privacy),
  [ADR-0008](0008-status-website.md) (active = displayed; firing = notified), [ADR-0019](0019-ux-decisions-deferred.md) (defaults).
- FINDINGS §11 (`get_pane_scrollback` / `get_pane_running_command`) — [FINDINGS.md](../FINDINGS.md).
