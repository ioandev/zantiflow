// Long-poll wake registry (ADR-0029): `signal(machineId)` wakes every request parked on that machine;
// a parked wait otherwise resolves when its timeout elapses. Unit-tested with no DB/server — signal
// paths run on real (immediate) microtasks; the timeout path uses fake timers so it's instant + exact.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createControlWaiters } from '../src/control/waiters'

describe('control waiters', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('signal wakes a parked wait before its timeout', async () => {
    const w = createControlWaiters()
    let woke = false
    const p = w.wait('m1', 60_000).then(() => {
      woke = true
    })
    expect(woke).toBe(false)
    w.signal('m1')
    await p
    expect(woke).toBe(true)
  })

  it('resolves on timeout when never signalled', async () => {
    vi.useFakeTimers()
    const w = createControlWaiters()
    let woke = false
    const p = w.wait('m1', 5_000).then(() => {
      woke = true
    })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(woke).toBe(false) // still held just before the deadline
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(woke).toBe(true)
  })

  it('signal is machine-scoped — it never wakes another machine’s parked wait', async () => {
    const w = createControlWaiters()
    let a = false
    let b = false
    const pa = w.wait('mA', 60_000).then(() => {
      a = true
    })
    w.wait('mB', 60_000).then(() => {
      b = true
    })
    w.signal('mA')
    await pa
    expect(a).toBe(true)
    expect(b).toBe(false) // mB stays parked
  })

  it('wakes every request parked on the same machine', async () => {
    const w = createControlWaiters()
    let n = 0
    const ps = [w.wait('m1', 60_000), w.wait('m1', 60_000), w.wait('m1', 60_000)].map((p) =>
      p.then(() => {
        n++
      }),
    )
    w.signal('m1')
    await Promise.all(ps)
    expect(n).toBe(3)
  })

  it('signal with nothing parked is a harmless no-op', () => {
    const w = createControlWaiters()
    expect(() => w.signal('nobody')).not.toThrow()
  })
})
