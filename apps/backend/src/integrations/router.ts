// Chat-integration management (ADR-0007) — OWNER plane. The user mints a one-time link token here,
// then runs the bot's `/link <token>` command; the bot relays it over the internal WS.
import type { PrismaClient } from '@prisma/client'
import { Router } from 'express'
import { mintLinkToken } from '../bots/linkToken'
import { requireSession } from '../auth/session'
import type { Config } from '../config'
import { asyncHandler } from '../http/async'
import { badRequest, notFound } from '../http/errors'
import { tokenBucket } from '../ratelimit'

const PLATFORMS = ['discord', 'telegram']

export const createIntegrationsRouter = (prisma: PrismaClient, config: Config): Router => {
  const router = Router()
  router.use(requireSession(prisma, config))

  // Flood guard for link-token minting: owner-authed but otherwise unbounded, so cap remints to
  // ~5/min per account (burst 5). Repeated "Connect" presses 429 instead of spending DB writes;
  // combined with replace-on-remint, they also never accumulate rows. `req.account` is set by the
  // `requireSession` above, so keying by it is safe here.
  const mintLimit = tokenBucket({
    capacity: 5,
    refillPerSec: 5 / 60,
    key: (req) => `link-token:${req.account?.id ?? req.ip ?? '?'}`,
  })

  router.post(
    '/:platform/link-token',
    mintLimit,
    asyncHandler(async (req, res) => {
      const platform = String(req.params.platform)
      if (!PLATFORMS.includes(platform)) throw badRequest('invalid_platform')
      const { token, expiresAt } = await mintLinkToken(prisma, req.account!.id, platform)
      res.setHeader('Cache-Control', 'no-store')
      res.json({ token, expiresAt: expiresAt.toISOString(), command: `/link ${token}` })
    }),
  )

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      const links = await prisma.channelLink.findMany({
        where: { accountId: req.account!.id },
        orderBy: { linkedAt: 'desc' },
      })
      res.json({
        links: links.map((l) => ({
          id: l.id,
          platform: l.platform,
          platformUsername: l.platformUsername,
          status: l.status,
          linkedAt: l.linkedAt,
        })),
      })
    }),
  )

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const result = await prisma.channelLink.updateMany({
        where: { id: String(req.params.id), accountId: req.account!.id },
        data: { status: 'revoked' },
      })
      if (result.count === 0) throw notFound('link_not_found')
      res.status(204).end()
    }),
  )

  return router
}
