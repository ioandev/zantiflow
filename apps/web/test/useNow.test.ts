import { afterEach, describe, expect, it, vi } from 'vitest'
import { Clock } from '../lib/useNow'

describe('Clock', () => {
  afterEach(() => vi.useRealTimers())

  it('fires every subscriber once per interval off a single shared timer', () => {
    vi.useFakeTimers()
    const clock = new Clock(1000)
    let a = 0
    let b = 0
    const unA = clock.subscribe(() => a++)
    const unB = clock.subscribe(() => b++)
    expect(clock.subscriberCount).toBe(2)
    expect(clock.running).toBe(true)

    vi.advanceTimersByTime(3000)
    expect(a).toBe(3)
    expect(b).toBe(3)
    unA()
    unB()
  })

  it('stops the interval when the last subscriber leaves, and restarts for a new one', () => {
    vi.useFakeTimers()
    const clock = new Clock(1000)
    let ticks = 0
    const un = clock.subscribe(() => ticks++)
    expect(clock.running).toBe(true)

    un()
    expect(clock.running).toBe(false)
    expect(clock.subscriberCount).toBe(0)
    // No orphaned timer keeps firing after the last unsubscribe.
    vi.advanceTimersByTime(5000)
    expect(ticks).toBe(0)

    // A fresh subscriber restarts the interval.
    const un2 = clock.subscribe(() => ticks++)
    expect(clock.running).toBe(true)
    vi.advanceTimersByTime(2000)
    expect(ticks).toBe(2)
    un2()
  })

  it('unsubscribing one of many keeps the timer running for the rest', () => {
    vi.useFakeTimers()
    const clock = new Clock(1000)
    let a = 0
    let b = 0
    const unA = clock.subscribe(() => a++)
    clock.subscribe(() => b++)
    unA()
    expect(clock.running).toBe(true)
    vi.advanceTimersByTime(2000)
    expect(a).toBe(0) // unsubscribed → no longer fires
    expect(b).toBe(2)
  })
})
