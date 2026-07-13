// Tier-gated pane-output auto-refresh window (ADR-0016), server-side enforcement. FREE accounts may
// auto-refresh only for FREE_AUTO_REFRESH_SEC after a human gesture; PRO is unbounded. Uses an
// injected clock so the window boundary is exercised without waiting real time.
import { describe, expect, it } from 'vitest'
import { createAutoRefreshLimiter, FREE_AUTO_REFRESH_SEC } from '../src/output/autoRefresh'

const KEY = 'acc:machine:sid:0:1'

describe('auto-refresh limiter', () => {
  it('allows FREE auto ticks within the window and refuses them once it is spent', () => {
    let now = 1_000_000
    const lim = createAutoRefreshLimiter({ now: () => now })

    lim.start(KEY) // human gesture opens the window
    expect(lim.allow(KEY, 'free')).toBe(true) // t=0

    now += (FREE_AUTO_REFRESH_SEC - 1) * 1000
    expect(lim.allow(KEY, 'free')).toBe(true) // still inside the window

    now += 2 * 1000 // just past the window
    expect(lim.allow(KEY, 'free')).toBe(false)
  })

  it('re-opening the window (a resume) lets FREE tick again', () => {
    let now = 5_000_000
    const lim = createAutoRefreshLimiter({ now: () => now })
    lim.start(KEY)

    now += (FREE_AUTO_REFRESH_SEC + 5) * 1000
    expect(lim.allow(KEY, 'free')).toBe(false)

    lim.start(KEY) // resume
    expect(lim.allow(KEY, 'free')).toBe(true)
  })

  it('never refuses PRO, no matter how long the window has been open', () => {
    let now = 9_000_000
    const lim = createAutoRefreshLimiter({ now: () => now })
    lim.start(KEY)
    now += (FREE_AUTO_REFRESH_SEC + 3600) * 1000
    expect(lim.allow(KEY, 'pro')).toBe(true)
  })

  it('treats a FREE tick with no prior window (e.g. after a restart) as a fresh window', () => {
    let now = 2_000_000
    const lim = createAutoRefreshLimiter({ now: () => now })
    expect(lim.allow(KEY, 'free')).toBe(true) // first-ever tick opens a window and is allowed
    now += (FREE_AUTO_REFRESH_SEC + 1) * 1000
    expect(lim.allow(KEY, 'free')).toBe(false) // ...which then expires normally
  })

  it('scopes windows per key', () => {
    let now = 3_000_000
    const lim = createAutoRefreshLimiter({ now: () => now })
    lim.start('acc:m:sid:0:1')
    now += (FREE_AUTO_REFRESH_SEC + 1) * 1000
    expect(lim.allow('acc:m:sid:0:1', 'free')).toBe(false) // spent
    lim.start('acc:m:sid:0:2')
    expect(lim.allow('acc:m:sid:0:2', 'free')).toBe(true) // independent window
  })
})
