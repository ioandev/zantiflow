import { describe, it, expect } from 'vitest'
import {
  safeRedirect,
  signSession,
  signState,
  signToken,
  verifySession,
  verifyState,
  verifyToken,
} from '../src/auth/tokens'

const SECRET = 'test-secret-0123456789-abcdefghij'

describe('signToken / verifyToken', () => {
  it('round-trips claims and rejects a tampered payload', () => {
    const tok = signToken(SECRET, { a: 1, b: 'x' })
    expect(verifyToken(SECRET, tok)).toMatchObject({ a: 1, b: 'x' })

    // Flip the payload → signature no longer matches.
    const [, sig] = tok.split('.')
    const forged = `${Buffer.from('{"a":999}').toString('base64url')}.${sig}`
    expect(verifyToken(SECRET, forged)).toBeNull()
  })

  it('rejects a token signed with a different secret', () => {
    const tok = signToken(SECRET, { a: 1 })
    expect(verifyToken('another-secret-9999999999-abcdefg', tok)).toBeNull()
  })

  it('rejects malformed tokens', () => {
    expect(verifyToken(SECRET, 'no-dot')).toBeNull()
    expect(verifyToken(SECRET, '.sig')).toBeNull()
    expect(verifyToken(SECRET, 'payload.')).toBeNull()
    expect(verifyToken(SECRET, '')).toBeNull()
  })

  it('honours exp', () => {
    const past = Math.floor(Date.now() / 1000) - 10
    expect(verifyToken(SECRET, signToken(SECRET, { exp: past }))).toBeNull()
    const future = Math.floor(Date.now() / 1000) + 100
    expect(verifyToken(SECRET, signToken(SECRET, { exp: future }))).toMatchObject({ exp: future })
  })
})

describe('state vs session domain separation', () => {
  it('a state token cannot be verified as a session, and vice versa', () => {
    const state = signState(SECRET, { redirect: '/dashboard' })
    const session = signSession(SECRET, { accountId: 'acc1', epoch: 3 }, 14)

    expect(verifyState(SECRET, state)).toEqual({ redirect: '/dashboard' })
    expect(verifySession(SECRET, state)).toBeNull() // state ≠ session

    expect(verifySession(SECRET, session)).toEqual({ accountId: 'acc1', epoch: 3 })
    expect(verifyState(SECRET, session)).toBeNull() // session ≠ state
  })

  it('verifyState strips typ/exp from returned claims', () => {
    const claims = verifyState(SECRET, signState(SECRET, { redirect: '/x', mode: 'popup' }))
    expect(claims).toEqual({ redirect: '/x', mode: 'popup' })
  })

  it('verifySession rejects claims with wrong-typed fields', () => {
    const bad = signToken(SECRET, { typ: 'session', accountId: 123, epoch: 'nope' })
    expect(verifySession(SECRET, bad)).toBeNull()
  })
})

describe('safeRedirect', () => {
  it('accepts same-site relative paths', () => {
    expect(safeRedirect('/dashboard')).toBe('/dashboard')
    expect(safeRedirect('/machines/abc?tab=1')).toBe('/machines/abc?tab=1')
  })

  it('rejects open-redirect vectors → fallback', () => {
    expect(safeRedirect('https://evil.example')).toBe('/')
    expect(safeRedirect('//evil.example')).toBe('/')
    expect(safeRedirect('/\\evil.example')).toBe('/')
    expect(safeRedirect('http://evil')).toBe('/')
    expect(safeRedirect('javascript:alert(1)')).toBe('/')
    expect(safeRedirect('/path\nwith-crlf')).toBe('/')
    expect(safeRedirect('')).toBe('/')
    expect(safeRedirect(undefined)).toBe('/')
    expect(safeRedirect(42)).toBe('/')
  })

  it('honours a custom fallback', () => {
    expect(safeRedirect('nope', '/home')).toBe('/home')
  })
})
