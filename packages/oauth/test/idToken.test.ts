import { describe, it, expect } from 'vitest'
import { decodeIdTokenPayload } from '../src/idToken'

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')

describe('decodeIdTokenPayload', () => {
  it('decodes the payload (2nd segment) and ignores the header + signature', () => {
    const payload = { sub: '123', email: 'a@b.com', name: 'Zoë', aud: 'client' }
    const jwt = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64(payload)}.signature-ignored`
    expect(decodeIdTokenPayload(jwt)).toEqual(payload)
  })

  it('round-trips base64url payloads with unicode / special chars', () => {
    const payload = { data: '???>>><<<~~~/+=', emoji: '😀', name: 'Jörg Ñoño' }
    const jwt = `header.${b64(payload)}.sig`
    expect(decodeIdTokenPayload(jwt)).toEqual(payload)
  })

  it('reads only the payload even when extra segments follow (JWE-style)', () => {
    const payload = { sub: 'x' }
    expect(decodeIdTokenPayload(`h.${b64(payload)}.sig.extra.parts`)).toEqual(payload)
  })

  it('throws "malformed id_token" when there is no payload segment', () => {
    expect(() => decodeIdTokenPayload('onlyonesegment')).toThrow('malformed id_token')
    expect(() => decodeIdTokenPayload('')).toThrow('malformed id_token')
    expect(() => decodeIdTokenPayload('header.')).toThrow('malformed id_token') // empty 2nd segment
  })

  it('throws when the payload segment is not valid JSON', () => {
    const jwt = `h.${Buffer.from('not json at all').toString('base64url')}.s`
    expect(() => decodeIdTokenPayload(jwt)).toThrow()
  })
})
