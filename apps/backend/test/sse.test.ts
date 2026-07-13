import { describe, it, expect, vi } from 'vitest'
import { createBus } from '../src/sse/bus'

const ev = (machineId: string) => ({ event: 'machine.update', data: { machineId } }) as const

describe('SseBus', () => {
  it("delivers events only to the target account's subscribers", () => {
    const bus = createBus()
    const a = vi.fn()
    const b = vi.fn()
    bus.subscribe('acc-a', a)
    bus.subscribe('acc-b', b)
    bus.publish('acc-a', ev('m1'))
    expect(a).toHaveBeenCalledWith(ev('m1'))
    expect(b).not.toHaveBeenCalled()
  })

  it('stops delivery after unsubscribe and tracks counts', () => {
    const bus = createBus()
    const l = vi.fn()
    const off = bus.subscribe('a', l)
    expect(bus.countFor('a')).toBe(1)
    off()
    expect(bus.countFor('a')).toBe(0)
    bus.publish('a', ev('m'))
    expect(l).not.toHaveBeenCalled()
  })

  it('counts multiple subscribers and publishing to none is a no-op', () => {
    const bus = createBus()
    bus.subscribe('a', vi.fn())
    bus.subscribe('a', vi.fn())
    expect(bus.countFor('a')).toBe(2)
    expect(() => bus.publish('nobody', ev('m'))).not.toThrow()
  })

  it('isolates a throwing listener from the others', () => {
    const bus = createBus()
    const good = vi.fn()
    bus.subscribe('a', () => {
      throw new Error('boom')
    })
    bus.subscribe('a', good)
    bus.publish('a', ev('m'))
    expect(good).toHaveBeenCalledOnce()
  })
})
