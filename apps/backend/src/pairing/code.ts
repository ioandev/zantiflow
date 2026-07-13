// Device-pairing identifiers (ADR-0012). Two very different values:
//   • sessionId — UNGUESSABLE (256-bit CSRNG); polling is keyed by this, never the short code.
//   • userCode  — SHORT, human-typed (8 base32 chars, `XXXX-XXXX`); protected by a ~10-min TTL +
//                 rate-limited entry rather than by entropy alone. Stored only as a SHA-256 hash.
import { createHash, randomBytes } from 'node:crypto'

// 32-char base32-ish alphabet with the visually ambiguous 0/O/1/I removed (usability).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LEN = 8

export const generateSessionId = (): string => randomBytes(32).toString('base64url')

export const generateUserCode = (): string => {
  // 256 % 32 === 0, so every random byte maps to the alphabet without modulo bias.
  let raw = ''
  for (const b of randomBytes(CODE_LEN)) raw += CODE_ALPHABET[b % CODE_ALPHABET.length]
  return `${raw.slice(0, 4)}-${raw.slice(4)}`
}

/** Normalize a user-entered code for lookup: uppercase, strip dashes/spaces/etc. */
export const normalizeUserCode = (input: string): string => input.toUpperCase().replace(/[^A-Z0-9]/g, '')

export const hashUserCode = (normalized: string): string => createHash('sha256').update(normalized).digest('hex')
