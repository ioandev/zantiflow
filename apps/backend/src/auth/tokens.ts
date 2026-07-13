// HMAC-signed opaque tokens for the two owner-auth needs: OAuth `state` (CSRF) and the
// `ztf_session` cookie. Inherited from commenttoday's battle-tested signed-cookie pattern
// (ADR-0004 §2/§4) — a fixed-algorithm HMAC-SHA256 over a base64url JSON payload, NOT a JWT lib,
// so there is no `alg`-confusion surface. Verification is timing-safe (audit F3/F7). A `typ`
// claim domain-separates kinds so a `state` token can never be replayed as a `session` (audit A5).
import { createHmac, timingSafeEqual } from 'node:crypto'

const nowSec = (): number => Math.floor(Date.now() / 1000)
export const STATE_TTL_SEC = 600 // ~10 min (ADR-0004 §2)

const sign = (secret: string, payload: string): string =>
  createHmac('sha256', secret).update(payload).digest('base64url')

/** Sign a claims object into `<payload>.<sig>`. */
export const signToken = (secret: string, claims: Record<string, unknown>): string => {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${payload}.${sign(secret, payload)}`
}

/** Verify signature + (optional) `exp`; returns the claims, or null if invalid/tampered/expired. */
export const verifyToken = (secret: string, token: string): Record<string, unknown> | null => {
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const payload = token.slice(0, dot)
  const provided = Buffer.from(token.slice(dot + 1))
  const expected = Buffer.from(sign(secret, payload))
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>
    if (typeof claims.exp === 'number' && claims.exp < nowSec()) return null
    return claims
  } catch {
    return null
  }
}

// --- OAuth state (CSRF) ---

export const signState = (secret: string, claims: Record<string, unknown>): string =>
  signToken(secret, { ...claims, typ: 'state', exp: nowSec() + STATE_TTL_SEC })

export const verifyState = (secret: string, token: string): Record<string, unknown> | null => {
  const claims = verifyToken(secret, token)
  if (!claims || claims.typ !== 'state') return null
  const { typ: _typ, exp: _exp, ...rest } = claims
  return rest
}

// --- Owner session ---

export interface SessionClaims {
  accountId: string
  epoch: number
}

export const signSession = (secret: string, s: SessionClaims, ttlDays: number): string =>
  signToken(secret, { typ: 'session', accountId: s.accountId, epoch: s.epoch, exp: nowSec() + ttlDays * 86400 })

export const verifySession = (secret: string, token: string): SessionClaims | null => {
  const claims = verifyToken(secret, token)
  if (!claims || claims.typ !== 'session') return null
  if (typeof claims.accountId !== 'string' || typeof claims.epoch !== 'number') return null
  return { accountId: claims.accountId, epoch: claims.epoch }
}

// --- Redirect validation (open-redirect defense; audit C12) ---

/**
 * Accept only same-site RELATIVE redirects: one leading `/`, no scheme, no protocol-relative
 * `//host`, no backslashes (browsers treat `\` as `/`), no control chars. Anything else → fallback.
 */
export const safeRedirect = (value: unknown, fallback = '/'): string => {
  if (typeof value !== 'string' || value.length === 0) return fallback
  if (!value.startsWith('/')) return fallback
  if (value.startsWith('//')) return fallback
  if (value.includes('\\')) return fallback
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return fallback // reject control chars (CRLF/NUL/etc.)
  }
  return value
}
