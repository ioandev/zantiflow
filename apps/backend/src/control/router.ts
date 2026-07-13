// The plugin control channel (ADR-0026): `POST /api/v1/control`, TOKEN plane (same auth as ingest and
// pane-output — never an owner session, and it can reach no read/management handler). Always-on: the
// plugin polls this every ~5 s regardless of `pane_output`. Replaces the pane-output-only
// `GET /output/pending` for the plugin once it migrates (Phase 11b); that route stays until then.
import type { PrismaClient } from '@prisma/client'
import { ControlRequest } from '@zantiflow/protocol'
import { Router } from 'express'
import { asyncHandler } from '../http/async'
import { badRequest, forbidden } from '../http/errors'
import { ingestAuth } from '../ingest/auth'
import type { Presence } from '../presence/service'
import { handleControl } from './service'
import type { ControlWaiters } from './waiters'

export const createControlRouter = (prisma: PrismaClient, presence: Presence, waiters: ControlWaiters): Router => {
  const router = Router()
  router.use(ingestAuth(prisma)) // token plane

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const parsed = ControlRequest.safeParse(req.body)
      if (!parsed.success) throw badRequest('invalid_body')
      const { machineId, liveSids, waitMs } = parsed.data
      // A long-poll may be parked in `handleControl`. If the plugin/proxy drops the socket while it's
      // held, release the parked promise so its timer can't linger for the full hold (ADR-0029). We
      // detect a real disconnect with `res.on('close')` BEFORE the response finished — `req`'s own
      // close can fire as soon as the request body is consumed, which is not a disconnect.
      if (waitMs && waitMs > 0) {
        res.on('close', () => {
          if (!res.writableEnded) waiters.signal(machineId)
        })
      }
      const result = await handleControl(
        prisma,
        presence,
        waiters,
        req.ingest!.accountId,
        machineId,
        liveSids,
        waitMs ?? 0,
      )
      // Generic 403 (uniform across ingest/output): refuse without disclosing that the machineId
      // belongs to another account. machineIds are unguessable secrets, so this leaks nothing usable.
      if (!result) throw forbidden()
      if (res.writableEnded) return // client disconnected during the hold — nothing left to write
      res.setHeader('Cache-Control', 'no-store')
      res.json(result)
    }),
  )

  return router
}
