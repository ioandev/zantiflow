// Owner-facing "Sent notifications" read plane (ADR-0006/0009): the account's last N notifications and
// the channels they were sent on. Owner-session-gated (dashboard cookie), account-scoped, never cached.
import type { PrismaClient } from '@prisma/client'
import { Router } from 'express'
import { requireSession } from '../auth/session'
import type { Config } from '../config'
import { asyncHandler } from '../http/async'
import { listRecentNotifications } from './service'

const RECENT_LIMIT = 10

export const createNotificationsRouter = (prisma: PrismaClient, config: Config): Router => {
  const router = Router()
  router.use(requireSession(prisma, config))
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      res.json({ notifications: await listRecentNotifications(prisma, req.account!.id, RECENT_LIMIT) })
    }),
  )
  return router
}
