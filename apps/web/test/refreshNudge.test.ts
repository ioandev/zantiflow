// The repeated-refresh filter nudge (ADR-0053): pure click-window policy + the browser-reload
// trigger (injected storage/reload flag — no browser needed).
import { describe, expect, it } from 'vitest'
import {
  checkReloadNudge,
  NUDGE_CLICKS,
  NUDGE_TEXT,
  NUDGE_WINDOW_MS,
  recordRefreshClick,
  RELOAD_STORE_KEY,
} from '../lib/refreshNudge'

const T0 = 1_000_000

describe('recordRefreshClick', () => {
  it('a single click never nudges', () => {
    const r = recordRefreshClick([], T0)
    expect(r.nudge).toBe(false)
    expect(r.times).toEqual([T0])
  })

  it('two clicks within the 5-minute window nudge', () => {
    const first = recordRefreshClick([], T0)
    const second = recordRefreshClick(first.times, T0 + NUDGE_WINDOW_MS - 1)
    expect(second.nudge).toBe(true)
  })

  it('two clicks farther apart than the window do not nudge', () => {
    const first = recordRefreshClick([], T0)
    const second = recordRefreshClick(first.times, T0 + NUDGE_WINDOW_MS)
    expect(second.nudge).toBe(false)
    // The stale click was pruned — only the new one survives.
    expect(second.times).toEqual([T0 + NUDGE_WINDOW_MS])
  })

  it('prunes old clicks so slow-paced refreshing never accumulates to a nudge', () => {
    // One click every window-and-a-bit: the window never holds two at once.
    let times: number[] = []
    for (let i = 0; i < 5; i++) {
      const r = recordRefreshClick(times, T0 + i * (NUDGE_WINDOW_MS + 1))
      expect(r.nudge).toBe(false)
      times = r.times
    }
  })

  it('threshold is two clicks (a nudge fires ON the second)', () => {
    expect(NUDGE_CLICKS).toBe(2)
  })

  it('copy points at the filters', () => {
    expect(NUDGE_TEXT).toBe('Not finding what you’re looking for? Check the filters at the top')
  })
})

describe('checkReloadNudge (browser-refresh trigger)', () => {
  const fakeStorage = (initial?: string) => {
    const map = new Map<string, string>()
    if (initial !== undefined) map.set(RELOAD_STORE_KEY, initial)
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      dump: () => map.get(RELOAD_STORE_KEY),
    }
  }

  it('a non-reload navigation neither nudges nor records', () => {
    const s = fakeStorage()
    expect(checkReloadNudge(T0, s, false)).toBe(false)
    expect(s.dump()).toBeUndefined()
  })

  it('the 2nd reload within the window nudges, then the window resets', () => {
    const s = fakeStorage()
    expect(checkReloadNudge(T0, s, true)).toBe(false) // 1st reload: recorded, no nudge
    expect(checkReloadNudge(T0 + 60_000, s, true)).toBe(true) // 2nd within 5 min: nudge
    // Fired ⇒ stored window cleared: the very next reload starts a fresh count.
    expect(s.dump()).toBe('[]')
    expect(checkReloadNudge(T0 + 61_000, s, true)).toBe(false)
  })

  it('reloads farther apart than the window never nudge', () => {
    const s = fakeStorage()
    expect(checkReloadNudge(T0, s, true)).toBe(false)
    expect(checkReloadNudge(T0 + NUDGE_WINDOW_MS, s, true)).toBe(false)
    expect(checkReloadNudge(T0 + 2 * NUDGE_WINDOW_MS, s, true)).toBe(false)
  })

  it('corrupted storage starts a fresh count instead of throwing', () => {
    expect(checkReloadNudge(T0, fakeStorage('not json'), true)).toBe(false)
    expect(checkReloadNudge(T0, fakeStorage('{"a":1}'), true)).toBe(false)
    // Non-number entries are dropped, surviving numbers still count toward the window.
    expect(checkReloadNudge(T0 + 1000, fakeStorage(`["x",${T0}]`), true)).toBe(true)
  })

  it('no storage (SSR/private-mode failure) is a safe no-op', () => {
    expect(checkReloadNudge(T0, null, true)).toBe(false)
  })
})
