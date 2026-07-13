// Owner-session cookie + the middleware that gates the read/management plane. The cookie is a
// stateless HMAC token, but every request ALSO re-checks the DB (account exists, not soft-deleted,
// and `epoch === account.sessionEpoch`) so bumping `sessionEpoch` logs the account out everywhere
// (ADR-0004 §2; audit A4/A11). This plane is entirely separate from ingest tokens (never conflated).
import type { PrismaClient } from '@prisma/client'
import type { NextFunction, Request, Response } from 'express'
import type { Config } from '../config'
import { unauthorized } from '../http/errors'
import { signSession, verifySession } from './tokens'

export const SESSION_COOKIE = 'ztf_session'

export interface AuthedAccount {
  id: string
  tier: string
  tierExpiresAt: Date | null
  email: string | null
  name: string
  avatarUrl: string | null
}

// Attach the resolved account to the request for downstream handlers.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      account?: AuthedAccount
    }
  }
}

const cookieOpts = (config: Config) =>
  ({ httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' }) as const

export const setSessionCookie = (res: Response, config: Config, claims: { accountId: string; epoch: number }): void => {
  res.cookie(SESSION_COOKIE, signSession(config.tokenSecret, claims, config.sessionTtlDays), {
    ...cookieOpts(config),
    maxAge: config.sessionTtlDays * 86400 * 1000,
  })
}

export const clearSessionCookie = (res: Response, config: Config): void => {
  res.clearCookie(SESSION_COOKIE, cookieOpts(config))
}

/** Gate a route on a valid owner session (HMAC cookie + DB re-check + epoch match). */
export const requireSession =
  (prisma: PrismaClient, config: Config) =>
  async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const raw = (req.cookies as Record<string, unknown> | undefined)?.[SESSION_COOKIE]
      const claims = typeof raw === 'string' ? verifySession(config.tokenSecret, raw) : null
      if (!claims) return next(unauthorized())

      const account = await prisma.account.findUnique({ where: { id: claims.accountId } })
      if (!account || account.deletedAt || account.sessionEpoch !== claims.epoch) return next(unauthorized())

      req.account = {
        id: account.id,
        tier: account.tier,
        tierExpiresAt: account.tierExpiresAt,
        email: account.email,
        name: account.name,
        avatarUrl: account.avatarUrl,
      }
      next()
    } catch (e) {
      next(e)
    }
  }
