import { describe, it, expect } from 'vitest'
import {
  generateToken,
  hashSecret,
  LOOKUP_LEN,
  lookupPrefixOf,
  parseBearer,
  secretHashMatches,
  TOKEN_PREFIX,
} from '../src/tokens/secret'
import { NAMED_DURATIONS, parseTtl } from '../src/tokens/ttl'

describe('token secret', () => {
  it('generates a ztf_ token with a lookup prefix and a 64-hex SHA-256 hash', () => {
    const t = generateToken()
    expect(t.secret.startsWith(TOKEN_PREFIX)).toBe(true)
    expect(t.secret.length).toBeGreaterThan(40) // ztf_ + ~43 base62 chars
    expect(t.lookupPrefix).toBe(t.secret.slice(0, LOOKUP_LEN))
    expect(t.secretHash).toMatch(/^[0-9a-f]{64}$/)
    expect(t.secretHash).toBe(hashSecret(t.secret))
  })

  it('produces unique secrets', () => {
    const secrets = new Set(Array.from({ length: 200 }, () => generateToken().secret))
    expect(secrets.size).toBe(200)
  })

  it('derives the lookup prefix only from well-formed tokens', () => {
    const t = generateToken()
    expect(lookupPrefixOf(t.secret)).toBe(t.lookupPrefix)
    expect(lookupPrefixOf('ztf_short')).toBeNull()
    expect(lookupPrefixOf('nope_abcdefghijklmnop')).toBeNull()
  })

  it('matches a secret against its stored hash (and rejects a wrong one), timing-safe', () => {
    const t = generateToken()
    expect(secretHashMatches(t.secret, t.secretHash)).toBe(true)
    expect(secretHashMatches(t.secret + 'x', t.secretHash)).toBe(false)
    expect(secretHashMatches('ztf_totallywrong', t.secretHash)).toBe(false)
  })

  it('parses only Bearer ztf_ headers', () => {
    expect(parseBearer('Bearer ztf_abc123')).toBe('ztf_abc123')
    expect(parseBearer('Bearer somethingelse')).toBeNull() // not a ztf_ token
    expect(parseBearer('ztf_abc123')).toBeNull() // missing scheme
    expect(parseBearer(undefined)).toBeNull()
    expect(parseBearer('Bearer')).toBeNull()
  })
})

describe('parseTtl', () => {
  const near = (d: Date | null, secs: number) => {
    expect(d).not.toBeNull()
    const delta = Math.abs((d as Date).getTime() - (Date.now() + secs * 1000))
    expect(delta).toBeLessThan(2000)
  }

  it('maps infinite → null', () => {
    expect(parseTtl('infinite')).toBeNull()
  })

  it('maps named durations', () => {
    near(parseTtl('24h'), NAMED_DURATIONS['24h'])
    near(parseTtl('7d'), NAMED_DURATIONS['7d'])
    near(parseTtl('365d'), NAMED_DURATIONS['365d'])
  })

  it('accepts an explicit positive seconds value (string or number)', () => {
    near(parseTtl('3600'), 3600)
    near(parseTtl(3600), 3600)
  })

  it('rejects garbage / non-positive / over-cap values', () => {
    expect(() => parseTtl('abc')).toThrow(/invalid_ttl/)
    expect(() => parseTtl(0)).toThrow(/invalid_ttl/)
    expect(() => parseTtl(-5)).toThrow(/invalid_ttl/)
    expect(() => parseTtl(999_999_999)).toThrow(/invalid_ttl/) // > 365d cap
    expect(() => parseTtl(undefined)).toThrow(/invalid_ttl/)
  })
})
