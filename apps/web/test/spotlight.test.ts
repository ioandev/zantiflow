// Spotlight album reducer (ADR-0016). The backend returns only the currently-active roster; these pure
// functions diff successive rosters into the ordered album — appending new sessions, marking vanished
// ones "completed" (kept until cleared) while preserving their last output frame, and counting active.
import { describe, expect, it } from 'vitest'
import {
  clearCompleted,
  countActive,
  filterRunning,
  reconcileAlbum,
  sortByRecent,
  type SpotlightEntry,
} from '../lib/spotlight'
import type { SpotlightSession } from '../lib/types'

const session = (key: string, over: Partial<SpotlightSession> = {}): SpotlightSession => ({
  key,
  machineId: key.split(':')[0],
  machineName: 'red-laptop',
  sessionSid: 's1',
  sessionName: 'work',
  tabId: 0,
  tabName: 'Tab #1',
  paneId: Number(key.split(':').pop()),
  paneName: '✳ claude',
  command: 'claude',
  thinking: false,
  updatedAt: null,
  ...over,
})

describe('reconcileAlbum', () => {
  it('adds brand-new active sessions in roster order', () => {
    const out = reconcileAlbum([], [session('m:s1:0:1'), session('m:s1:0:2')])
    expect(out.map((e) => e.key)).toEqual(['m:s1:0:1', 'm:s1:0:2'])
    expect(out.every((e) => !e.completed)).toBe(true)
  })

  it('keeps insertion order and appends newcomers at the end', () => {
    const first = reconcileAlbum([], [session('m:s1:0:1')])
    const out = reconcileAlbum(first, [session('m:s1:0:1'), session('m:s1:0:9')])
    expect(out.map((e) => e.key)).toEqual(['m:s1:0:1', 'm:s1:0:9'])
  })

  it('marks a vanished session completed but keeps it (and its last frame)', () => {
    let album = reconcileAlbum([], [session('m:s1:0:1')])
    // page persisted a captured frame on the entry
    album = album.map((e) => (e.key === 'm:s1:0:1' ? { ...e, lastFrame: ['hello'], capturedAt: 'T' } : e))
    const out = reconcileAlbum(album, []) // roster now empty — the pane exited
    expect(out).toHaveLength(1)
    expect(out[0].completed).toBe(true)
    expect(out[0].lastFrame).toEqual(['hello']) // preserved
    expect(out[0].capturedAt).toBe('T')
  })

  it('refreshes live fields of still-active entries and un-completes a returning one', () => {
    const prev: SpotlightEntry[] = [{ ...session('m:s1:0:1', { thinking: false }), completed: true, lastFrame: ['x'] }]
    const out = reconcileAlbum(prev, [session('m:s1:0:1', { thinking: true })])
    expect(out[0].completed).toBe(false) // came back
    expect(out[0].thinking).toBe(true) // refreshed
    expect(out[0].lastFrame).toEqual(['x']) // frame still preserved
  })

  it('counts only active entries and clears completed ones', () => {
    let album = reconcileAlbum([], [session('m:s1:0:1'), session('m:s1:0:2')])
    album = reconcileAlbum(album, [session('m:s1:0:2')]) // pane 1 vanished → completed
    expect(countActive(album)).toBe(1)
    expect(album).toHaveLength(2)
    const cleared = clearCompleted(album)
    expect(cleared.map((e) => e.key)).toEqual(['m:s1:0:2'])
    expect(countActive(cleared)).toBe(1)
  })
})

describe('sortByRecent', () => {
  it('orders most-recently-used first, never-observed (null) last', () => {
    const roster = [
      session('m:s1:0:1', { updatedAt: '2026-07-12T10:00:00.000Z' }),
      session('m:s1:0:2', { updatedAt: null }),
      session('m:s1:0:3', { updatedAt: '2026-07-12T10:05:00.000Z' }),
    ]
    const out = sortByRecent(roster)
    expect(out.map((s) => s.key)).toEqual(['m:s1:0:3', 'm:s1:0:1', 'm:s1:0:2'])
  })

  it('is pure (does not mutate the input) and keeps incoming order for ties', () => {
    const roster = [
      session('m:s1:0:1', { updatedAt: '2026-07-12T10:00:00.000Z' }),
      session('m:s1:0:2', { updatedAt: '2026-07-12T10:00:00.000Z' }),
    ]
    const out = sortByRecent(roster)
    expect(out.map((s) => s.key)).toEqual(['m:s1:0:1', 'm:s1:0:2']) // stable tie-break
    expect(roster.map((s) => s.key)).toEqual(['m:s1:0:1', 'm:s1:0:2']) // input untouched
  })

  it('lays out a fresh album most-recent-first via reconcileAlbum', () => {
    const roster = [
      session('m:s1:0:1', { updatedAt: '2026-07-12T10:00:00.000Z' }),
      session('m:s1:0:2', { updatedAt: '2026-07-12T10:09:00.000Z' }),
    ]
    const out = reconcileAlbum([], sortByRecent(roster))
    expect(out.map((e) => e.key)).toEqual(['m:s1:0:2', 'm:s1:0:1'])
  })
})

describe('filterRunning', () => {
  it('keeps only actively-thinking, non-completed entries', () => {
    const entries: SpotlightEntry[] = [
      { ...session('m:s1:0:1', { thinking: true }), completed: false },
      { ...session('m:s1:0:2', { thinking: false }), completed: false },
      { ...session('m:s1:0:3', { thinking: true }), completed: true }, // was thinking, now gone
    ]
    expect(filterRunning(entries).map((e) => e.key)).toEqual(['m:s1:0:1'])
  })
})
