import { describe, it, expect } from 'vitest'
import { parseConfig } from '../src/config'

const base = {
  DATABASE_URL: 'mysql://u:p@localhost:3306/zantiflow',
  TOKEN_SECRET: 'x'.repeat(32),
}

describe('parseConfig', () => {
  it('applies defaults when only required vars are set', () => {
    const c = parseConfig({ ...base })
    expect(c.port).toBe(4000)
    expect(c.nodeEnv).toBe('development')
    expect(c.sessionTtlDays).toBe(14)
    expect(c.webOrigin).toBe('http://localhost:3000')
    expect(c.trustProxy).toBe('loopback')
    expect(c.isProd).toBe(false)
    expect(c.cookieSecure).toBe(false) // not prod → insecure cookies allowed for local dev
  })

  it('throws with a helpful message when TOKEN_SECRET is missing', () => {
    expect(() => parseConfig({ DATABASE_URL: base.DATABASE_URL })).toThrow(/TOKEN_SECRET/)
  })

  it('rejects a too-short TOKEN_SECRET (<256-bit)', () => {
    expect(() => parseConfig({ ...base, TOKEN_SECRET: 'short' })).toThrow(/256-bit|at least 32/)
  })

  it('requires DATABASE_URL', () => {
    expect(() => parseConfig({ TOKEN_SECRET: base.TOKEN_SECRET })).toThrow(/DATABASE_URL/)
  })

  it('defaults cookieSecure ON in production, and honours COOKIE_SECURE override', () => {
    expect(parseConfig({ ...base, NODE_ENV: 'production' }).cookieSecure).toBe(true)
    expect(parseConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' }).cookieSecure).toBe(false)
    expect(parseConfig({ ...base, COOKIE_SECURE: 'true' }).cookieSecure).toBe(true)
  })

  it('coerces numeric PORT and validates WEB_ORIGIN as a URL', () => {
    expect(parseConfig({ ...base, PORT: '8080' }).port).toBe(8080)
    expect(() => parseConfig({ ...base, WEB_ORIGIN: 'not-a-url' })).toThrow(/WEB_ORIGIN/)
  })

  describe('SELF_HOST_SECRET (ADR-0035)', () => {
    it('is undefined when unset (Google-only, feature off)', () => {
      expect(parseConfig({ ...base }).selfHostSecret).toBeUndefined()
    })

    it('accepts a ≥32-char secret and surfaces it on the config', () => {
      const secret = 's'.repeat(40)
      expect(parseConfig({ ...base, SELF_HOST_SECRET: secret }).selfHostSecret).toBe(secret)
    })

    it('rejects a too-short secret', () => {
      expect(() => parseConfig({ ...base, SELF_HOST_SECRET: 'short' })).toThrow(/at least 32/)
    })

    it('treats an empty string as unset (a blank .env line must not brick boot)', () => {
      expect(parseConfig({ ...base, SELF_HOST_SECRET: '' }).selfHostSecret).toBeUndefined()
    })

    it('rejects a secret equal to TOKEN_SECRET (would allow session-cookie forgery)', () => {
      expect(() => parseConfig({ ...base, SELF_HOST_SECRET: base.TOKEN_SECRET })).toThrow(/differ from TOKEN_SECRET/)
    })
  })
})
