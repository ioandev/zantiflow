// Spotlight API (ADR-0016) — OWNER plane, PRO-only. `GET /api/v1/spotlight` returns the live roster of
// active Claude sessions across the account's machines for the album view. Gated by an owner session
// AND a hard PRO check (403 requires_pro), so non-PRO can't reach the feed even calling it directly.
import type { PrismaClient } from '@prisma/client'
import { Router } from 'express'
import { requireSession } from '../auth/session'
import type { Config } from '../config'
import { asyncHandler } from '../http/async'
import type { Presence } from '../presence/service'
import { requirePro } from '../tiers/requirePro'
import { activeClaudeSessions } from './service'

export const createSpotlightRouter = (prisma: PrismaClient, config: Config, presence: Presence): Router => {
  const router = Router()
  router.use(requireSession(prisma, config))
  router.use(requirePro)

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      // An open Spotlight IS a viewer (ADR-0026): mark presence so the plugin keeps the livelier cadence
      // (and idle-but-running Claudes keep reporting, so they stay on the roster instead of aging out).
      presence.markViewer(req.account!.id)
      const sessions = await activeClaudeSessions(prisma, req.account!.id)
      res.setHeader('Cache-Control', 'no-store')
      res.json({ activeCount: sessions.length, sessions })
    }),
  )

  return router
}
