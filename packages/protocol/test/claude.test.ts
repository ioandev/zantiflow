// Shared Claude-pane detection (ADR-0015/0016). This is the canonical copy the backend Spotlight
// roster uses; the web keeps a matching copy in lib/machineView (it can't depend on this CJS+zod
// package without bloating the browser bundle) — these cases mirror machineView.test.ts so the two
// stay pinned together. The detector keys on the pane NAME marker (✳ idle / Braille spinner thinking),
// with the `command` as a confirm-only fallback.
import { describe, expect, it } from 'vitest'
import { hasClaudeMarker, isClaudePane, isThinkingMarker } from '../src/claude'

const pane = (name: string | null, command: string | null = null) => ({ name, command })

describe('isClaudePane', () => {
  it('detects the leading sparkle / Braille-spinner marker', () => {
    expect(isClaudePane(pane('✳ Claude Code'))).toBe(true)
    expect(isClaudePane(pane('  ✳ padded'))).toBe(true) // leading whitespace tolerated
    expect(isClaudePane(pane('⠐ github actions'))).toBe(true) // U+2810
    expect(isClaudePane(pane('⠂ coloured text'))).toBe(true) // U+2802
    expect(isClaudePane(pane('⠙ Fixing the parser'))).toBe(true)
  })

  it('honors the wire verdict first when present (ADR-0055)', () => {
    // Content-detected claude with an unmarked name — only the flag can identify it.
    expect(isClaudePane({ name: 'Pane #1', command: null, claude: true })).toBe(true)
    // The plugin said no — a marker-less shell stays a shell even with a claude-ish command string.
    expect(isClaudePane({ name: 'zsh', command: 'claude-helper', claude: false })).toBe(false)
    // Absent flag (old plugin) → marker/command fallbacks as before.
    expect(isClaudePane({ name: '✳ Claude Code', command: null })).toBe(true)
  })

  it('falls back to a claude command (confirm-only)', () => {
    expect(isClaudePane(pane('claude --resume', 'claude --resume'))).toBe(true)
    expect(isClaudePane(pane('some-title', '/usr/bin/Claude'))).toBe(true) // case-insensitive
  })

  it('rejects non-Claude panes', () => {
    expect(isClaudePane(pane('nordic@nordic-standardpc:~'))).toBe(false)
    expect(isClaudePane(pane('python3 -m http.server 8088'))).toBe(false)
    expect(isClaudePane(pane('● Done'))).toBe(false) // a bullet is not the sparkle/spinner
    expect(isClaudePane(pane('build ⠐ step'))).toBe(false) // marker must be leading
    expect(isClaudePane(pane('⠀ idle'))).toBe(false) // U+2800 blank pattern excluded
    expect(isClaudePane(pane(null, null))).toBe(false) // fully redacted
    expect(isClaudePane(pane(''))).toBe(false)
  })
})

describe('isThinkingMarker', () => {
  it('is true only for the Braille spinner (a turn in flight), not the idle sparkle', () => {
    expect(isThinkingMarker('⠙ Fixing the parser')).toBe(true)
    expect(isThinkingMarker('⠐ working')).toBe(true)
    expect(isThinkingMarker('✳ idle at prompt')).toBe(false) // sparkle = idle
    expect(isThinkingMarker('bash')).toBe(false)
    expect(isThinkingMarker('⠀ blank')).toBe(false) // U+2800 excluded
    expect(isThinkingMarker(null)).toBe(false)
  })
})

describe('hasClaudeMarker', () => {
  it('accepts either marker on the name', () => {
    expect(hasClaudeMarker('✳ x')).toBe(true)
    expect(hasClaudeMarker('⠙ x')).toBe(true)
    expect(hasClaudeMarker('bash')).toBe(false)
    expect(hasClaudeMarker(null)).toBe(false)
  })
})
