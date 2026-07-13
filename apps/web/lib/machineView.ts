// View-shaping transforms for the dashboard machine list/tree (ADR-0008/0015): a client-side sort
// over the machine overview and a "Claude only" prune of the sessions→tabs→panes tree. Pure and
// React-free so it unit-tests directly, and applied in one place (the page) so the overview grid and
// the detail sections stay consistent. Kept alongside the other lib/* transforms (format.ts, attn.ts).
import type { MachineDetail, MachineSummary, WirePane, WireSession, WireTab } from './types'

export type SortMode = 'recent' | 'name' | 'attention'

const SORT_MODES: readonly SortMode[] = ['recent', 'name', 'attention']

// "Recently used" buckets activity to this window so machines whose Claude panes are all churning
// (thinking, streaming output) don't reshuffle on every ~1 s snapshot — within one bucket the order is
// held stable by a fixed key. Coarse enough to de-jitter, fine enough to feel responsive.
const RECENT_BUCKET_MS = 30_000

/** Validate a persisted value into a SortMode, falling back to the default ('recent'). Lets the
 *  localStorage read stay a thin call around a testable, node-safe coercion. */
export function coerceSortMode(raw: string | null | undefined): SortMode {
  return SORT_MODES.includes(raw as SortMode) ? (raw as SortMode) : 'recent'
}

const seenMs = (iso: string): number => new Date(iso).getTime()

/** The most recent **Claude** pane activity on a machine, in epoch ms — the max last-changed time over
 *  panes that run Claude Code (isClaudePane), from the derived activity map (paneKey → ISO). 0 when no
 *  Claude pane has been observed to change. This is the "last used" signal: a machine keeps reporting
 *  (~1/s, ADR-0026) so `lastSeenAt` is always ~now, and counting *every* pane lets a background
 *  `npm run dev`/shell bump an untouched machine to the top — so we scope it to Claude output. */
export function machineLastActiveMs(detail: MachineDetail | undefined): number {
  const snap = detail?.snapshot
  if (!snap) return 0
  const activity = detail.activity ?? {}
  let max = 0
  for (const s of snap.sessions) {
    for (const t of s.tabs) {
      for (const p of t.panes) {
        if (!isClaudePane(p)) continue
        const iso = activity[`${s.sid}:${t.tabId}:${p.id}`]
        if (!iso) continue
        const ms = new Date(iso).getTime()
        if (ms > max) max = ms
      }
    }
  }
  return max
}

/** Sort machines for display. Returns a NEW array (never mutates the input):
 *  - recent:    most recently *used* first — newest Claude-pane activity (see machineLastActiveMs),
 *               bucketed to RECENT_BUCKET_MS so a machine with churning Claude panes doesn't jitter,
 *               and tie-broken by machine id (a fixed key) so same-bucket order is stable frame to
 *               frame. `lastActiveMs` maps machineId → last-active epoch ms; a machine missing from it
 *               (detail not loaded, or no Claude activity) counts as 0 and sinks to the bottom.
 *  - name:      displayName A–Z, case-insensitive; hidden machines (null name) sort last.
 *  - attention: most attentions first, then most thinking, then most recently seen.
 *  Array.prototype.sort is stable (ES2019+), so equal keys keep their incoming order. */
export function sortMachines(
  machines: MachineSummary[],
  mode: SortMode,
  lastActiveMs: Record<string, number> = {},
): MachineSummary[] {
  const out = [...machines]
  if (mode === 'name') {
    out.sort((a, b) => {
      if (a.displayName === b.displayName) return 0
      if (a.displayName === null) return 1 // hidden sorts last
      if (b.displayName === null) return -1
      return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
    })
  } else if (mode === 'attention') {
    out.sort(
      (a, b) =>
        b.attentionCount - a.attentionCount ||
        b.thinkingCount - a.thinkingCount ||
        seenMs(b.lastSeenAt) - seenMs(a.lastSeenAt),
    )
  } else {
    const bucket = (id: string) => Math.floor((lastActiveMs[id] ?? 0) / RECENT_BUCKET_MS)
    out.sort((a, b) => bucket(b.id) - bucket(a.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }
  return out
}

// A pane runs the Claude Code app. Claude Code takes over the pane TITLE (which Zellij reports as the
// pane name), prefixing it with a marker: a static `✳` sparkle (U+2733) when idle, and a cycling
// Braille spinner frame (U+2801..=U+28FF; U+2800 is the blank pattern → excluded) while a turn is in
// flight. That leading glyph is the primary signal — the same `✳`/Braille split the plugin's
// `is_thinking` keys on (ADR-0025). We check the pane NAME, not the tab name (Zellij leaves the tab
// "Tab #1" — the marker never reaches it). `command` is a fallback: a just-launched pane may still
// read `claude …` before it has set its title, and Zellij often reports the launch command as `null`,
// so it can only ever confirm, never exclude. NOTE: the backend keeps a matching copy in
// @zantiflow/protocol (`claude.ts`) for the Spotlight roster; the two are pinned by their test suites
// (the web can't depend on protocol — it's CJS+zod and would bloat the browser bundle).
const CLAUDE_SPARKLE = 0x2733 // ✳ (idle)
const BRAILLE_MIN = 0x2801 // spinner frames (thinking); U+2800 blank excluded
const BRAILLE_MAX = 0x28ff

function hasClaudeMarker(name: string | null): boolean {
  const trimmed = name?.replace(/^\s+/, '')
  if (!trimmed) return false
  const cp = trimmed.codePointAt(0) ?? 0
  return cp === CLAUDE_SPARKLE || (cp >= BRAILLE_MIN && cp <= BRAILLE_MAX)
}

export function isClaudePane(pane: WirePane): boolean {
  return hasClaudeMarker(pane.name) || !!pane.command?.toLowerCase().includes('claude')
}

/** Strip Claude Code's leading status marker (`✳` idle / Braille spinner) from a pane title for
 *  DISPLAY only. The glyph is terminal-render noise and — worse — Claude leaves the spinner frame
 *  FROZEN in a background pane's title when a turn ends, so a finished pane shows a stuck "." (the
 *  `⠂` frame) on the dashboard. Claude-ness (`isClaudePane`) and the "thinking" state (the attention)
 *  are derived elsewhere, so the row drops the marker and shows the clean task title. A non-Claude
 *  name passes through untouched; `null` (redacted) stays `null`; a title that is *only* a marker
 *  falls back to the original so a row is never blank. */
export function paneDisplayName(name: string | null): string | null {
  if (name === null || !hasClaudeMarker(name)) return name
  // The marker glyphs (✳, Braille) are all single-code-unit BMP chars, so drop the leading glyph and
  // any following whitespace off the trimmed title.
  const stripped = name.replace(/^\s+/, '').slice(1).replace(/^\s+/, '')
  return stripped.length > 0 ? stripped : name
}

/** Prune a session list to only what runs Claude, cascading pane → tab → session. Returns new
 *  objects carrying only the kept children: a tab keeps only its Claude panes, a session keeps only
 *  tabs that still have a Claude pane, and a session with no Claude pane drops out entirely (this
 *  also removes dead/resurrectable sessions, which carry no pane detail). */
export function filterSessionsToClaude(sessions: WireSession[]): WireSession[] {
  const out: WireSession[] = []
  for (const session of sessions) {
    const tabs: WireTab[] = []
    for (const tab of session.tabs) {
      const panes = tab.panes.filter(isClaudePane)
      if (panes.length > 0) tabs.push({ ...tab, panes })
    }
    if (tabs.length > 0) out.push({ ...session, tabs })
  }
  return out
}
