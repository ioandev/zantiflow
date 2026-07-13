import { describe, it, expect } from 'vitest'
import { createLogger, redact } from '../src/log'

describe('redact', () => {
  it('masks secret-named keys regardless of value', () => {
    const out = redact({ authorization: 'Bearer abc', token: 'plain', password: 'hunter2', ok: 'keep' }) as Record<
      string,
      unknown
    >
    expect(out.authorization).toBe('«redacted»')
    expect(out.token).toBe('«redacted»')
    expect(out.password).toBe('«redacted»')
    expect(out.ok).toBe('keep')
  })

  it('masks secret-shaped values inside innocent strings', () => {
    expect(redact('using ztf_ABCDEF1234567890 now')).toBe('using «redacted» now')
    expect(redact('auth: Bearer eyJhbGciOi.payloadpart.sigpart')).toContain('«redacted»')
  })

  it('recurses into nested objects and arrays', () => {
    const out = redact({ a: { secret: 's', list: [{ token: 't' }, 'ztf_XXXXXXXXXX'] } }) as {
      a: { secret: string; list: [{ token: string }, string] }
    }
    expect(out.a.secret).toBe('«redacted»')
    expect(out.a.list[0].token).toBe('«redacted»')
    expect(out.a.list[1]).toBe('«redacted»')
  })
})

describe('createLogger', () => {
  it('writes redacted JSON lines at/above the configured level', () => {
    const lines: string[] = []
    const log = createLogger({ level: 'info', sink: (l) => lines.push(l) })
    log.debug('skipped') // below level
    log.info('hello', { token: 'ztf_secretvalue123456', keep: 1 })

    expect(lines).toHaveLength(1)
    const rec = JSON.parse(lines[0])
    expect(rec.level).toBe('info')
    expect(rec.msg).toBe('hello')
    expect(rec.token).toBe('«redacted»')
    expect(rec.keep).toBe(1)
    expect(typeof rec.time).toBe('string')
  })

  it('merges child bindings', () => {
    const lines: string[] = []
    const log = createLogger({ level: 'info', sink: (l) => lines.push(l) }).child({ reqId: 'r1' })
    log.info('x')
    expect(JSON.parse(lines[0]).reqId).toBe('r1')
  })
})
