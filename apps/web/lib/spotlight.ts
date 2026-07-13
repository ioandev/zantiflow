// Spotlight album state (ADR-0016) — pure, React-free, node-safe so it unit-tests directly (like
// machineView/format). The backend returns only the CURRENTLY-active Claude roster; this diffs each
// fresh roster into the ordered album: new active panes append, panes that vanish become "completed"
// (kept until the user clears them), and every kept entry preserves its last captured output frame so
// flipping back to it (or seeing a completed one) shows the last thing it printed.
import type { SpotlightSession } from './types'

export interface SpotlightEntry extends SpotlightSession {
  completed: boolean
  lastFrame?: string[] // last captured output lines, persisted across flips + completion
  capturedAt?: string // ISO of that frame
}

/** Merge a fresh active roster into the album's ordered entries. Insertion order is the array order:
 *  existing entries stay in place (refreshed from the roster, or marked `completed` when absent —
 *  which also un-completes one that came back), then brand-new active panes append in roster order.
 *  `lastFrame`/`capturedAt` are always preserved. Pure — no clock, no mutation of `prev`. */
export function reconcileAlbum(prev: SpotlightEntry[], roster: SpotlightSession[]): SpotlightEntry[] {
  const byKey = new Map(roster.map((s) => [s.key, s]))
  const seen = new Set<string>()
  const out: SpotlightEntry[] = []
  for (const e of prev) {
    seen.add(e.key)
    const fresh = byKey.get(e.key)
    // Spread order matters: `fresh` refreshes the live fields but carries no lastFrame/capturedAt, so
    // those survive from `e`; `completed` is then set explicitly.
    out.push(fresh ? { ...e, ...fresh, completed: false } : { ...e, completed: true })
  }
  for (const item of roster) {
    if (!seen.has(item.key)) out.push({ ...item, completed: false })
  }
  return out
}

/** Order a fresh roster most-recently-used first (by observed `updatedAt`, newest first; panes never
 *  observed — `updatedAt === null` — sort last). Used only for the album's FIRST layout on page open;
 *  `reconcileAlbum` then keeps that order stable across live refreshes (existing entries never move).
 *  Pure — returns a new array, never mutates `roster`; ties keep their incoming (backend) order. */
export function sortByRecent(roster: SpotlightSession[]): SpotlightSession[] {
  const at = (s: SpotlightSession): number => (s.updatedAt ? new Date(s.updatedAt).getTime() : -Infinity)
  return [...roster].sort((a, b) => at(b) - at(a))
}

/** The "Running only" filter: keep just the entries whose Claude is actively working (a live turn — the
 *  Braille-spinner marker gated on recent output, `thinking`), excluding completed ones. Pure. */
export function filterRunning(entries: SpotlightEntry[]): SpotlightEntry[] {
  return entries.filter((e) => e.thinking && !e.completed)
}

/** Drop the completed entries (the "Clear sessions that completed" button). */
export function clearCompleted(entries: SpotlightEntry[]): SpotlightEntry[] {
  return entries.filter((e) => !e.completed)
}

/** How many entries are currently active (the "Spotlight (N)" count) — completed are excluded. */
export function countActive(entries: SpotlightEntry[]): number {
  return entries.reduce((n, e) => n + (e.completed ? 0 : 1), 0)
}
