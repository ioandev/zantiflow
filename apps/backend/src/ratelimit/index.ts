// In-memory token-bucket rate limiter (ADR-0018 §9; no Redis by design, ADR-0019). Each plane
// (ingest, auth, read-API, promo, pairing) instantiates its own bucket with a principal-scoped
// key so one tenant/token can't starve others. Returns `429` + `Retry-After` when a bucket empties.
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { errorEnvelope } from '../http/errors'

export interface TokenBucketOptions {
  /** Max burst — the bucket's full capacity. */
  capacity: number
  /** Sustained refill rate (tokens per second). */
  refillPerSec: number
  /** Derive the rate-limit key (the principal) from the request. */
  key: (req: Request) => string
  /** Injectable clock (ms since epoch) — defaults to `Date.now`, overridden in tests. */
  now?: () => number
  /** Guard against unbounded key growth; when exceeded the table is cleared. */
  maxEntries?: number
}

interface Bucket {
  tokens: number
  last: number
}

export const tokenBucket = (opts: TokenBucketOptions): RequestHandler => {
  const { capacity, refillPerSec, key } = opts
  const now = opts.now ?? Date.now
  const maxEntries = opts.maxEntries ?? 100_000
  const buckets = new Map<string, Bucket>()

  return (req: Request, res: Response, next: NextFunction): void => {
    const k = key(req)
    const t = now()
    let b = buckets.get(k)
    if (!b) {
      if (buckets.size >= maxEntries) buckets.clear() // coarse overflow guard; rare in practice
      b = { tokens: capacity, last: t }
      buckets.set(k, b)
    }
    const elapsedSec = Math.max(0, (t - b.last) / 1000)
    b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillPerSec)
    b.last = t

    if (b.tokens >= 1) {
      b.tokens -= 1
      next()
      return
    }
    const retryAfter = Math.max(1, Math.ceil((1 - b.tokens) / refillPerSec))
    res.setHeader('Retry-After', String(retryAfter))
    res.status(429).json(errorEnvelope('rate_limited', 'Too Many Requests'))
  }
}

/**
 * Key by client IP. `req.ip` is proxy-aware only because the app sets `trust proxy` from config,
 * so `X-Forwarded-For` is never blindly trusted (spoofable rate-limit bypass — ADR-0018 §8).
 */
export const ipKey =
  (prefix: string) =>
  (req: Request): string =>
    `${prefix}:${req.ip ?? 'unknown'}`
