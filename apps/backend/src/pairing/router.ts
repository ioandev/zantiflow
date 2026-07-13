// Device-pairing endpoints (ADR-0012). start/poll are UNAUTHENTICATED (the plugin has no token
// yet); approve is OWNER-authenticated (the logged-in user entering the code). Code entry is
// rate-limited to defend the short userCode against brute force.
import type { PrismaClient } from '@prisma/client'
import { Router } from 'express'
import { z } from 'zod'
import { requireSession } from '../auth/session'
import type { Config } from '../config'
import { asyncHandler } from '../http/async'
import { AppError, badRequest } from '../http/errors'
import { ipKey, tokenBucket } from '../ratelimit'
import { approvePairing, pollPairing, startPairing } from './service'

const StartBody = z.object({ machineHint: z.string().max(128).optional() })
const PollBody = z.object({ sessionId: z.string().min(10).max(256) })
const ApproveBody = z.object({ userCode: z.string().min(4).max(32) })

export const createPairingRouter = (prisma: PrismaClient, config: Config): Router => {
  const router = Router()

  // Session-creation flood guard; poll paced by sessionId; code-entry brute-force guard (5/10min).
  const startLimit = tokenBucket({ capacity: 10, refillPerSec: 10 / 60, key: ipKey('pair-start') })
  const pollLimit = tokenBucket({
    capacity: 20,
    refillPerSec: 1,
    key: (req) => `pair-poll:${typeof req.body?.sessionId === 'string' ? req.body.sessionId : (req.ip ?? '?')}`,
  })
  const approveLimit = tokenBucket({
    capacity: 5,
    refillPerSec: 5 / 600,
    key: (req) => `pair-approve:${req.account?.id ?? req.ip ?? '?'}`,
  })

  router.post(
    '/start',
    startLimit,
    asyncHandler(async (req, res) => {
      const parsed = StartBody.safeParse(req.body ?? {})
      if (!parsed.success) throw badRequest('invalid_body')
      res.setHeader('Cache-Control', 'no-store')
      res.status(201).json(await startPairing(prisma, `${config.webOrigin}/pair`, parsed.data.machineHint))
    }),
  )

  router.post(
    '/poll',
    pollLimit,
    asyncHandler(async (req, res) => {
      const parsed = PollBody.safeParse(req.body)
      if (!parsed.success) throw badRequest('invalid_body')
      const result = await pollPairing(prisma, parsed.data.sessionId)
      if (result.status === 'unknown') throw new AppError(404, 'unknown_session', 'Unknown pairing session')
      res.setHeader('Cache-Control', 'no-store')
      res.json(result)
    }),
  )

  router.post(
    '/approve',
    requireSession(prisma, config),
    approveLimit,
    asyncHandler(async (req, res) => {
      const parsed = ApproveBody.safeParse(req.body)
      if (!parsed.success) throw badRequest('invalid_body')
      await approvePairing(prisma, req.account!.id, parsed.data.userCode)
      res.status(204).end()
    }),
  )

  return router
}
