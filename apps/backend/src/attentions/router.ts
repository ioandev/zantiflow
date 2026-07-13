// Current attentions for the owner (ADR-0005/0008). Attentions are populated in Phase 5; this read
// endpoint exists now so the dashboard can poll it. Current-only (no history), account-scoped.
import type { PrismaClient } from '@prisma/client'
import { Router } from 'express'
import { requireSession } from '../auth/session'
import type { Config } from '../config'
import { asyncHandler } from '../http/async'

export interface AttentionView {
  id: string
  machineId: string
  type: string
  targetKey: string
  activeSince: Date
  lastFiredAt: Date | null
}

export const listActiveAttentions = async (prisma: PrismaClient, accountId: string): Promise<AttentionView[]> => {
  const rows = await prisma.attention.findMany({
    where: { accountId, state: 'active' },
    orderBy: { activeSince: 'desc' },
  })
  return rows.map((a) => ({
    id: a.id,
    machineId: a.machineId,
    type: a.type,
    targetKey: a.targetKey,
    activeSince: a.activeSince,
    lastFiredAt: a.lastFiredAt,
  }))
}

export const createAttentionsRouter = (prisma: PrismaClient, config: Config): Router => {
  const router = Router()
  router.use(requireSession(prisma, config))
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      res.json({ attentions: await listActiveAttentions(prisma, req.account!.id) })
    }),
  )
  return router
}
