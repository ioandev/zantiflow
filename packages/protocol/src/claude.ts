// Claude-pane detection — shared by the web dashboard and the backend Spotlight roster (ADR-0015).
// Claude Code takes over the pane TITLE (which Zellij reports as the pane `name`), prefixing it with a
// marker: a static `✳` sparkle (U+2733) when idle, and a cycling Braille spinner frame
// (U+2801..=U+28FF; U+2800 is the blank pattern → excluded) while a turn is in flight. That leading
// glyph is the primary, reliable signal — Zellij often reports the launch `command` as `null`, so
// command matching can only ever CONFIRM (never exclude). Detection keys on the pane NAME, not the tab
// name (the marker never reaches the tab). Kept dependency-free (no zod) so both apps import it cheaply.

export interface ClaudePaneLike {
  name: string | null
  command: string | null
  /** The plugin's own detection verdict (ADR-0055): title marker OR live-content signatures
   *  (ADR-0054). When present it is authoritative — it covers panes the backend cannot classify
   *  from the stored name at all (a content-detected Claude named `"Pane #1"`). Optional: old
   *  plugins omit it. */
  claude?: boolean
}

const CLAUDE_SPARKLE = 0x2733 // ✳ (idle)
const BRAILLE_MIN = 0x2801 // spinner frames (thinking); U+2800 blank excluded
const BRAILLE_MAX = 0x28ff

/** The leading code point of a name, ignoring leading whitespace (0 when empty/redacted). */
const leadingCodePoint = (name: string | null): number => {
  const trimmed = name?.replace(/^\s+/, '')
  if (!trimmed) return 0
  return trimmed.codePointAt(0) ?? 0
}

/** True when the pane name starts with Claude's marker (sparkle OR Braille spinner). */
export function hasClaudeMarker(name: string | null): boolean {
  const cp = leadingCodePoint(name)
  return cp === CLAUDE_SPARKLE || (cp >= BRAILLE_MIN && cp <= BRAILLE_MAX)
}

/** True when the marker is specifically the Braille spinner (a turn in flight). The sparkle ✳ is
 *  idle, so it returns false — use this for a live "thinking" indicator. */
export function isThinkingMarker(name: string | null): boolean {
  const cp = leadingCodePoint(name)
  return cp >= BRAILLE_MIN && cp <= BRAILLE_MAX
}

/** True when a pane runs Claude Code: the plugin's wire verdict when present (ADR-0055 —
 *  authoritative, covers content-detected panes with unmarked names), else the name marker, else a
 *  `claude` command as a fallback (confirm-only — a redacted/null command can't exclude). */
export function isClaudePane(pane: ClaudePaneLike): boolean {
  if (pane.claude !== undefined) return pane.claude
  return hasClaudeMarker(pane.name) || !!pane.command?.toLowerCase().includes('claude')
}
