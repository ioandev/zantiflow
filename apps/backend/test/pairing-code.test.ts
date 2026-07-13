import { describe, it, expect } from 'vitest'
import { generateSessionId, generateUserCode, hashUserCode, normalizeUserCode } from '../src/pairing/code'

describe('pairing code', () => {
  it('generates an XXXX-XXXX user code from the unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateUserCode()
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/) // no 0/O/1/I
    }
  })

  it('normalizes user input (case, dashes, spaces) before hashing', () => {
    expect(normalizeUserCode('abcd-2345')).toBe('ABCD2345')
    expect(normalizeUserCode(' ab cd 23 45 ')).toBe('ABCD2345')
    expect(hashUserCode(normalizeUserCode('abcd-2345'))).toBe(hashUserCode('ABCD2345'))
    expect(hashUserCode('ABCD2345')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('generates unguessable, unique session ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateSessionId()))
    expect(ids.size).toBe(200)
    expect(generateSessionId().length).toBeGreaterThan(40) // 256-bit base64url
  })
})
