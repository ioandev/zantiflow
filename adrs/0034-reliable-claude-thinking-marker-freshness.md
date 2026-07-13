# ADR-0034 — Reliable `claude.thinking`: pane-title marker + content-freshness, and a dashboard marker strip

- **Status:** Accepted
- **Supersedes (in part):** [ADR-0025](0025-claude-thinking-attention.md) — keeps its decision to *have*
  a `claude.thinking` attention and the detect-in-plugin / enforce-in-backend split, but replaces
  **what the detector reads**. ADR-0025 (and its "spinner-word" predecessor) read the **tab name** and
  gated on the pane **command**; both are wrong on real machines. The gerund-plus-`esc to interrupt`
  scan is **not** reintroduced.
- **Builds on:** [ADR-0001](0001-zellij-session-telemetry-architecture.md) (per-pane fingerprint /
  activity), [ADR-0005](0005-attentions-detection-and-triggering.md) (attention model),
  [ADR-0026](0026-minimise-plugin-update-cadence.md) (change-driven send cadence),
  [ADR-0016](0016-dashboard-and-pane-output.md)/[ADR-0033](0033-spotlight-active-claude-album.md)
  (dashboard + Spotlight display)
- **Date:** 2026-07-12
- **Deciders:** project owner
- **Tags:** attentions, detection, plugin, dashboard, bugfix
- **Testing:** plugin unit — the freshness tracker (`activity::PaneActivity`: first observation never
  fresh, a change is fresh then decays past the stale window, a frozen fingerprint never becomes fresh)
  + snapshot-builder tests (a spinner-marked pane that is **still producing output** → `claude.thinking`;
  a **frozen** spinner glyph with settled output → **no** thinking across many ticks; thinking **clears**
  once output settles; needs-input still wins over a live spinner); web unit — `paneDisplayName` strips
  the marker for display but leaves non-Claude names / redaction / marker-only titles alone; backend
  integration — Spotlight `thinking` requires fresh activity. See [ADR-0014](0014-testing-strategy.md).
- **Wire contract:** unchanged (**v4**) — `Attention.type` is an open string; no schema change.

## Context

Two bugs made a finished Claude pane look **stuck** on the dashboard — reported as "a pane shows a `.`
(dot) constantly, no update sent, even though Claude finished and the pane is fine in Zellij."

1. **`claude.thinking` / `claude.needs-input` never fired on a real machine.** The plugin gated both on
   `is_claude_command(pane.command)`, but Zellij reports the pane **`command` as `null`** — verified
   across every live dev-DB snapshot, and the reason the dashboard's own `isClaudePane`
   (ADR-0033) keys off the pane-NAME marker instead. And the ADR-0025 detector read the **tab name**
   for the spinner, but Zellij leaves the tab named `Tab #1` — Claude Code's marker lands on the
   **pane** title, never the tab. Net result: the only attention ever emitted was `session.detached`.

2. **The spinner glyph freezes, and the change-driven cadence has nothing to send.** Claude Code
   prefixes the pane title with a cycling Braille spinner frame (`⠂`, `⠐`, …) while a turn is in
   flight and a static `✳` sparkle when idle — but in a **background/unfocused** pane it leaves the
   **last spinner frame frozen** when the turn ends. `⠂` (U+2802) renders as a small dot ".". Because
   ADR-0026 only POSTs when the sampled snapshot changes, once the turn ends and the output settles
   there is **no change to send** — so the dashboard is frozen on the last (spinning-looking) state,
   and, since it renders the raw pane name, shows a stuck "`.`".

A marker-only detector would make (1) worse, not better: keyed off the frozen glyph it would report
"thinking" **forever**.

## Decision

**Detect Claude by the pane-title marker; qualify "thinking" with observed output freshness; strip the
marker from the dashboard display.**

1. **Plugin — recognise a Claude pane by its title marker** (`✳` sparkle or a Braille spinner frame),
   command only as a fallback (`attentions::is_claude_pane`) — mirroring `@zantiflow/protocol` /
   `machineView.ts`. This is what makes `needs-input` and `thinking` fire at all.

2. **Plugin — `claude.thinking` = a spinner-frame title AND the pane is still producing output.** A new
   per-pane freshness tracker (`activity::PaneActivity`) remembers each pane's content fingerprint and
   the wall-tick it last changed; a pane is *fresh* while that change is within `THINKING_STALE_TICKS`
   (8 s). A first-ever observation is never fresh, so an idle pane whose title carries a frozen frame
   never false-fires. When a turn ends and output settles, freshness lapses within a few seconds →
   the attention is dropped from the snapshot → that is a **structural change ADR-0026 sends promptly**
   (and `KEEPALIVE_TICKS` keeps it alive while active). So thinking now **clears itself** even though
   the frozen glyph never changes. `needs-input` still wins over `thinking` on the same pane.

3. **Web — strip the marker for display** (`paneDisplayName`). The `✳`/spinner glyph is
   terminal-render noise and the direct cause of the stuck "`.`"; Claude-ness (`isClaudePane`) and the
   thinking state (the attention) are derived elsewhere, so the pane row and the Spotlight photo show
   the clean task title. A stale glyph can never masquerade as a dot again.

4. **Backend — gate the Spotlight `thinking` flag on the same freshness.** The Spotlight roster derived
   `thinking` straight from the frozen-prone marker; it now also requires the pane's last observed
   change to be recent (`THINKING_FRESH_MS` = 45 s — generous vs the ADR-0026 send floor so it doesn't
   flicker between coalesced sends, under `STALE_AFTER_MS` so a finished pane clears before it ages out
   of the roster).

## Consequences

- A finished Claude pane stops showing "thinking" within a few seconds and no longer displays a stuck
  marker; the dashboard reflects "Claude finished" via a real attention clear (an SSE-pushed update),
  not a frozen glyph. Takes full effect after a plugin `.wasm` rebuild + reload.
- Detection now **fails closed under redaction**: if pane names are hidden the marker is unavailable,
  so thinking/needs-input don't fire — consistent with the dashboard's own `isClaudePane`.
- Best-effort, as before — the marker glyphs are Claude Code's and can change. `THINKING_STALE_TICKS`
  relies on a truly-thinking pane re-rendering its spinner (its elapsed-time counter) ~every second; a
  background pane the host never repaints reads as "not thinking" (safe, and matches its stale activity).
- Does **not** fix the general "dashboard relative times freeze when the plugin correctly goes quiet"
  (no client-side ticker) — a separate, milder UX gap left for later (ADR-0019).
