// Token TTL parsing (ADR-0003 §2). Accepts a named duration, an explicit positive seconds value,
// or `infinite` (→ null = no expiry). Returns the absolute `expiresAt` to store, or null.
import { badRequest } from '../http/errors'

const DAY = 86400
export const NAMED_DURATIONS: Record<string, number> = {
  '1h': 3600,
  '24h': 24 * 3600,
  '7d': 7 * DAY,
  '30d': 30 * DAY,
  '90d': 90 * DAY,
  '365d': 365 * DAY,
}
const MAX_SECONDS = 365 * DAY // cap explicit values at a year

export const parseTtl = (ttl: unknown): Date | null => {
  if (ttl === 'infinite') return null
  if (typeof ttl === 'string' && ttl in NAMED_DURATIONS) {
    return new Date(Date.now() + NAMED_DURATIONS[ttl] * 1000)
  }
  // Explicit seconds (string or number).
  const secs = typeof ttl === 'number' ? ttl : typeof ttl === 'string' ? Number(ttl) : NaN
  if (Number.isInteger(secs) && secs > 0 && secs <= MAX_SECONDS) {
    return new Date(Date.now() + secs * 1000)
  }
  throw badRequest('invalid_ttl', {
    allowed: [...Object.keys(NAMED_DURATIONS), 'infinite', `1..${MAX_SECONDS} (seconds)`],
  })
}
