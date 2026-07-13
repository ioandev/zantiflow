import { describe, it, expect, vi } from 'vitest'
import type { Request, Response } from 'express'
import { tokenBucket, ipKey } from '../src/ratelimit'

// A minimal fake req/res good enough for the middleware.
const mkReq = (ip = '1.1.1.1'): Request => ({ ip }) as unknown as Request
const mkRes = () => {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader(k: string, v: string) {
      this.headers[k] = v
    },
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b
      return this
    },
  }
  return res as unknown as Response & { statusCode: number; headers: Record<string, string>; body: unknown }
}

describe('tokenBucket', () => {
  it('allows up to capacity, then 429s with Retry-After', () => {
    const t = 1_000_000
    const mw = tokenBucket({ capacity: 2, refillPerSec: 1, key: ipKey('t'), now: () => t })
    const next = vi.fn()

    const r1 = mkRes()
    mw(mkReq(), r1, next)
    const r2 = mkRes()
    mw(mkReq(), r2, next)
    expect(next).toHaveBeenCalledTimes(2) // 2 tokens consumed

    const r3 = mkRes()
    mw(mkReq(), r3, next)
    expect(next).toHaveBeenCalledTimes(2) // exhausted → not called again
    expect(r3.statusCode).toBe(429)
    expect(r3.headers['Retry-After']).toBe('1')
    expect((r3.body as { error: { code: string } }).error.code).toBe('rate_limited')
  })

  it('refills over time', () => {
    let t = 0
    const mw = tokenBucket({ capacity: 1, refillPerSec: 1, key: ipKey('t'), now: () => t })
    const next = vi.fn()

    mw(mkReq(), mkRes(), next)
    expect(next).toHaveBeenCalledTimes(1)
    mw(mkReq(), mkRes(), next) // immediately → blocked
    expect(next).toHaveBeenCalledTimes(1)

    t += 1000 // one second later → one token refilled
    mw(mkReq(), mkRes(), next)
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('keys separate principals independently', () => {
    const t = 0
    const mw = tokenBucket({ capacity: 1, refillPerSec: 1, key: ipKey('t'), now: () => t })
    const next = vi.fn()
    mw(mkReq('1.1.1.1'), mkRes(), next)
    mw(mkReq('2.2.2.2'), mkRes(), next) // different IP → own bucket
    expect(next).toHaveBeenCalledTimes(2)
  })
})
