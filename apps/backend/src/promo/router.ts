// Promo endpoints (ADR-0011). `GET /promo/current` is PUBLIC (the homepage code); `POST /promo/redeem`
// requires an owner session and is strictly rate-limited (5/hr per account) — anti-enumeration/abuse.
import type { PrismaClient } from '@prisma/client'
import { Router } from 'express'
import { z } from 'zod'
import { requireSession } from '../auth/session'
import type { Config } from '../config'
import { asyncHandler } from '../http/async'
import { badRequest } from '../http/errors'
import { tokenBucket } from '../ratelimit'
import { currentCode, redeem } from './service'

const RedeemBody = z.object({ code: z.string().min(3).max(32) })

export const createPromoRouter = (prisma: PrismaClient, config: Config): Router => {
  const router = Router()

  // Public — the current homepage code (or null).
  router.get(
    '/current',
    asyncHandler(async (_req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      res.json({ code: await currentCode(prisma) })
    }),
  )

  // Strict anti-abuse limit: 5 redeem attempts / hour, keyed by the (session-verified) account.
  const redeemLimit = tokenBucket({
    capacity: 5,
    refillPerSec: 5 / 3600,
    key: (req) => `promo-redeem:${req.account?.id ?? 'anon'}`,
  })

  router.post(
    '/redeem',
    requireSession(prisma, config),
    redeemLimit,
    asyncHandler(async (req, res) => {
      const parsed = RedeemBody.safeParse(req.body)
      if (!parsed.success) throw badRequest('invalid_body')
      const tierExpiresAt = await redeem(prisma, req.account!.id, parsed.data.code)
      res.json({ tier: 'pro', tierExpiresAt: tierExpiresAt.toISOString() })
    }),
  )

  return router
}
