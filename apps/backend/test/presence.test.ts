// Viewer presence (ADR-0026): "watching" = a live SSE stream OR a viewer signal within the TTL; plus
// a per-machine refresh counter. Unit-tested with a fake bus + injected clock (no DB, no server).
import { describe, it, expect } from 'vitest'
import type { SseBus } from '../src/sse/bus'
import { createPresence, PRESENCE_TTL_MS } from '../src/presence/service'

const fakeBus = (counts: Record<string, number> = {}): SseBus => ({
  publish: () => {},
  subscribe: () => () => {},
  countFor: (accountId) => counts[accountId] ?? 0,
})

describe('presence.isWatching', () => {
  it('is true whenever a live SSE stream is open, without any viewer mark', () => {
    const p = createPresence(fakeBus({ a: 1 }))
    expect(p.isWatching('a')).toBe(true)
  })

  it('is false for an account with no stream and no recent viewer signal', () => {
    const p = createPresence(fakeBus())
    expect(p.isWatching('a')).toBe(false)
  })

  it('stays watching for the TTL after a viewer mark, then lapses', () => {
    let t = 10_000
    const p = createPresence(fakeBus(), { now: () => t })
    p.markViewer('a')
    expect(p.isWatching('a')).toBe(true)

    t += PRESENCE_TTL_MS - 1
    expect(p.isWatching('a')).toBe(true) // still inside the window

    t += 2
    expect(p.isWatching('a')).toBe(false) // TTL elapsed
  })

  it('a re-mark (e.g. SSE heartbeat) extends the window', () => {
    let t = 0
    const p = createPresence(fakeBus(), { now: () => t })
    p.markViewer('a')
    t += PRESENCE_TTL_MS - 1
    p.markViewer('a') // heartbeat
    t += PRESENCE_TTL_MS - 1
    expect(p.isWatching('a')).toBe(true)
  })

  it('scopes presence per account', () => {
    const p = createPresence(fakeBus())
    p.markViewer('a')
    expect(p.isWatching('a')).toBe(true)
    expect(p.isWatching('b')).toBe(false)
  })
})

describe('presence.refreshSeq', () => {
  it('starts at 0 and increments monotonically per machine', () => {
    const p = createPresence(fakeBus())
    expect(p.refreshSeq('m1')).toBe(0)
    expect(p.bumpRefresh('m1')).toBe(1)
    expect(p.bumpRefresh('m1')).toBe(2)
    expect(p.refreshSeq('m1')).toBe(2)
    expect(p.refreshSeq('m2')).toBe(0) // independent per machine
  })
})
