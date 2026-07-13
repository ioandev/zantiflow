import { describe, it, expect } from 'vitest'
import { parseConfig } from '../src/config'
import { LOCAL_OWNER_ID, LOCAL_PROVIDER, localOwnerProfile, localSecretMatches } from '../src/auth/local'

const secret = 's'.repeat(40)
const config = parseConfig({
  DATABASE_URL: 'mysql://u:p@localhost:3306/zantiflow',
  TOKEN_SECRET: 'x'.repeat(32),
  SELF_HOST_SECRET: secret,
})

describe('localSecretMatches (ADR-0035)', () => {
  it('accepts the exact configured secret', () => {
    expect(localSecretMatches(config, secret)).toBe(true)
  })

  it('rejects a wrong secret', () => {
    expect(localSecretMatches(config, 'w'.repeat(40))).toBe(false)
  })

  it('rejects non-strings without throwing', () => {
    expect(localSecretMatches(config, undefined)).toBe(false)
    expect(localSecretMatches(config, 12345)).toBe(false)
    expect(localSecretMatches(config, { secret })).toBe(false)
  })

  it('rejects a differing-length input without throwing (no length leak)', () => {
    expect(localSecretMatches(config, 'short')).toBe(false)
  })

  it('returns false when the secret is not configured', () => {
    const noSecret = parseConfig({ DATABASE_URL: config.databaseUrl, TOKEN_SECRET: 'x'.repeat(32) })
    expect(localSecretMatches(noSecret, secret)).toBe(false)
  })
})

describe('localOwnerProfile', () => {
  it('is the fixed single-owner identity', () => {
    expect(localOwnerProfile()).toEqual({
      sub: LOCAL_OWNER_ID,
      email: null,
      emailVerified: null,
      name: 'Owner',
      picture: null,
    })
    expect(LOCAL_PROVIDER).toBe('local')
  })
})
