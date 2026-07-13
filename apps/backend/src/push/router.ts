// Web Push subscription management (ADR-0006) — OWNER plane. The client fetches the VAPID public key,
// calls `PushManager.subscribe()`, and POSTs the resulting subscription here (stored per-device). All
// scoped by `accountId`.
import type { PrismaClient } from '@prisma/client'
import { Router } from 'express'
import { z } from 'zod'
import { requireSession } from '../auth/session'
import type { Config } from '../config'
import { asyncHandler } from '../http/async'
import { badRequest } from '../http/errors'

const SubscribeBody = z.object({
  endpoint: z.string().url().max(512),
  keys: z.object({ p256dh: z.string().max(256), auth: z.string().max(256) }),
})
const UnsubscribeBody = z.object({ endpoint: z.string().max(512) })

export const createPushRouter = (prisma: PrismaClient, config: Config): Router => {
  const router = Router()
  router.use(requireSession(prisma, config))

  router.get('/vapid-public-key', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ publicKey: config.vapid.publicKey ?? null })
  })

  router.post(
    '/subscribe',
    asyncHandler(async (req, res) => {
      const parsed = SubscribeBody.safeParse(req.body)
      if (!parsed.success) throw badRequest('invalid_body')
      const accountId = req.account!.id
      const { endpoint, keys } = parsed.data
      // A device re-subscribing updates its keys; otherwise create a new per-device subscription.
      const existing = await prisma.pushSubscription.findFirst({ where: { accountId, endpoint } })
      if (existing) {
        await prisma.pushSubscription.update({
          where: { id: existing.id },
          data: { p256dh: keys.p256dh, auth: keys.auth },
        })
      } else {
        await prisma.pushSubscription.create({ data: { accountId, endpoint, p256dh: keys.p256dh, auth: keys.auth } })
      }
      res.status(204).end()
    }),
  )

  router.delete(
    '/subscribe',
    asyncHandler(async (req, res) => {
      const parsed = UnsubscribeBody.safeParse(req.body)
      if (!parsed.success) throw badRequest('invalid_body')
      await prisma.pushSubscription.deleteMany({
        where: { accountId: req.account!.id, endpoint: parsed.data.endpoint },
      })
      res.status(204).end()
    }),
  )

  return router
}
