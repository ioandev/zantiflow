// Ingest-token secrets (ADR-0003 §1). Format `ztf_<base62 random ≥256-bit>`. We store a SHA-256
// hash + an indexed `lookupPrefix` (the first chars, like a GitHub PAT) and show the full secret
// exactly once. A fast SHA-256 is appropriate here — these are high-entropy random tokens, NOT
// user-chosen passwords, so no slow KDF is needed (audit F2). Comparison is timing-safe (F7).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
export const TOKEN_PREFIX = 'ztf_'
// `ztf_` (4) + 12 random chars → the indexed lookup key. 62^12 ≈ 3e21 → collisions negligible.
export const LOOKUP_LEN = TOKEN_PREFIX.length + 12
const SECRET_RANDOM_LEN = 43 // 43 base62 chars ≈ 256 bits of entropy

// Unbiased base62 via rejection sampling (drop bytes ≥ 248 = 4×62 to avoid modulo bias).
const randomBase62 = (len: number): string => {
  let out = ''
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (out.length >= len) break
      if (b < 248) out += BASE62[b % 62]
    }
  }
  return out
}

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex')

export interface GeneratedToken {
  /** The full secret — shown to the user ONCE, never stored or returned again. */
  secret: string
  /** Indexed prefix used to find the row at ingest time. */
  lookupPrefix: string
  /** SHA-256 hex of the full secret, stored at rest. */
  secretHash: string
}

export const generateToken = (): GeneratedToken => {
  const secret = `${TOKEN_PREFIX}${randomBase62(SECRET_RANDOM_LEN)}`
  return { secret, lookupPrefix: secret.slice(0, LOOKUP_LEN), secretHash: sha256Hex(secret) }
}

export const hashSecret = (secret: string): string => sha256Hex(secret)

/** Derive the lookup prefix from a presented secret, or null if it isn't a well-formed token. */
export const lookupPrefixOf = (secret: string): string | null => {
  if (!secret.startsWith(TOKEN_PREFIX) || secret.length < LOOKUP_LEN + 8) return null
  return secret.slice(0, LOOKUP_LEN)
}

/** Timing-safe compare of two equal-length hex hashes. */
export const secretHashMatches = (presentedSecret: string, storedHash: string): boolean => {
  const a = Buffer.from(sha256Hex(presentedSecret))
  const b = Buffer.from(storedHash)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Extract the token from an `Authorization: Bearer ztf_…` header, or null. */
export const parseBearer = (header: string | undefined): string | null => {
  if (!header) return null
  const m = /^Bearer\s+(\S+)$/.exec(header)
  const tok = m?.[1]
  return tok && tok.startsWith(TOKEN_PREFIX) ? tok : null
}
