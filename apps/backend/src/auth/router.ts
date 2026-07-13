// The owner-auth router: Google sign-in (via @zantiflow/oauth-express) + session lifecycle.
// Mounted under /api/v1. The OAuth `state` is our HMAC CSRF token; `onLogin` upserts the account
// and sets the `ztf_session` cookie, then redirects to a validated same-site target.
import type { PrismaClient } from '@prisma/client'
import type { OAuthProvider } from '@zantiflow/oauth'
import { createOAuthRouter } from '@zantiflow/oauth-express'
import { Router } from 'express'
import type { Config } from '../config'
import { asyncHandler } from '../http/async'
import { AppError, badRequest } from '../http/errors'
import { ipKey, tokenBucket } from '../ratelimit'
import { upsertAccount } from './accounts'
import { LOCAL_PROVIDER, localOwnerProfile, localSecretMatches } from './local'
import { clearSessionCookie, requireSession, setSessionCookie } from './session'
import { safeRedirect, signState, verifyState } from './tokens'

export interface AuthRouterDeps {
  prisma: PrismaClient
  config: Config
  /** Providers to mount (usually `[GoogleProvider]`). Injected for testability. */
  providers: OAuthProvider[]
}

export const createAuthRouter = ({ prisma, config, providers }: AuthRouterDeps): Router => {
  const router = Router()

  // Login/callback flooding guard (ADR-0018 §9): ~10/min per IP.
  const loginLimit = tokenBucket({ capacity: 10, refillPerSec: 10 / 60, key: ipKey('auth') })
  // Self-host secret login is a brute-force target, so it gets its OWN, stricter bucket (5 burst
  // then ~1/min) under a distinct key prefix — it must never share the OAuth-start bucket (ADR-0035).
  const localLimit = tokenBucket({ capacity: 5, refillPerSec: 1 / 60, key: ipKey('auth_local') })

  router.use(
    createOAuthRouter({
      providers,
      signState: (claims) => signState(config.tokenSecret, claims),
      verifyState: (token) => verifyState(config.tokenSecret, token),
      startMiddleware: loginLimit,
      // Carry a validated post-login redirect target through the state (never a raw user value).
      startState: (req) => ({ redirect: safeRedirect(req.query.redirect) }),
      onLogin: async (profile, ctx) => {
        const account = await upsertAccount(prisma, ctx.provider.id, profile)
        setSessionCookie(ctx.res, config, { accountId: account.id, epoch: account.sessionEpoch })
        ctx.res.redirect(safeRedirect(ctx.state.redirect))
      },
    }),
  )

  // Which owner sign-in methods this deployment offers, so the SAME web image renders the right
  // login surface (ADR-0035). Unauthenticated + no secret material — only whether each is enabled.
  // `google` is derived from the actually-mounted providers, not raw config.
  router.get('/auth/methods', (_req, res) => {
    res.json({
      google: providers.some((p) => p.id === 'google'),
      local: Boolean(config.selfHostSecret),
    })
  })

  // Self-host owner sign-in via the configured secret (ADR-0035). Mounted ONLY when the secret is
  // set, so a deployment without it 404s here (no oracle beyond `/auth/methods`). On success it sets
  // the same `ztf_session` cookie as Google and returns 204 — the client owns the post-login redirect.
  if (config.selfHostSecret) {
    router.post(
      '/auth/local',
      localLimit,
      asyncHandler(async (req, res) => {
        const secret = (req.body as { secret?: unknown } | undefined)?.secret
        if (typeof secret !== 'string') throw badRequest('secret required')
        // Distinct `invalid_secret` (not `unauthorized`) so the web tells "wrong secret" apart from
        // "session expired". Timing-safe compare lives in `localSecretMatches`.
        if (!localSecretMatches(config, secret)) throw new AppError(401, 'invalid_secret', 'Invalid secret')
        const account = await upsertAccount(prisma, LOCAL_PROVIDER, localOwnerProfile())
        setSessionCookie(res, config, { accountId: account.id, epoch: account.sessionEpoch })
        res.status(204).end()
      }),
    )
  }

  // Current account (owner session required). Account-specific → never cached.
  router.get('/auth/me', requireSession(prisma, config), (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const a = req.account!
    res.json({
      id: a.id,
      email: a.email,
      name: a.name,
      avatarUrl: a.avatarUrl,
      tier: a.tier,
      tierExpiresAt: a.tierExpiresAt,
    })
  })

  // Logout — clear the cookie. The session is stateless HMAC, so a stolen cookie stays valid until
  // TTL unless the account also logs out everywhere (epoch bump below). (ADR-0004 §2; audit A11.)
  router.post('/auth/logout', (_req, res) => {
    clearSessionCookie(res, config)
    res.status(204).end()
  })

  // Logout everywhere — bump sessionEpoch so every outstanding ztf_session fails the DB re-check.
  router.post(
    '/auth/logout-all',
    requireSession(prisma, config),
    asyncHandler(async (req, res) => {
      await prisma.account.update({ where: { id: req.account!.id }, data: { sessionEpoch: { increment: 1 } } })
      clearSessionCookie(res, config)
      res.status(204).end()
    }),
  )

  return router
}
