// The plugin-facing DELIVERY side of the pane-output channel (ADR-0016), token-authed (same plane as
// ingest, NOT owner sessions). The plugin learns which panes to send from the control response
// (`POST /control`, ADR-0026) and delivers the scrubbed tail here to `/output`.
import type { PrismaClient } from '@prisma/client'
import { OutputDelivery } from '@zantiflow/protocol'
import { Router } from 'express'
import { badRequest, forbidden } from '../http/errors'
import { asyncHandler } from '../http/async'
import { ingestAuth } from '../ingest/auth'
import { submitOutput } from './service'
import type { PaneOutputStore } from './store'

export const createOutputRouter = (prisma: PrismaClient, store: PaneOutputStore): Router => {
  const router = Router()
  router.use(ingestAuth(prisma)) // token plane

  // Deliver captured output. The plugin learns WHICH panes to send from the control response
  // (ADR-0026); this endpoint just accepts the scrubbed tail. (The old `GET /pending` is retired.)
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const parsed = OutputDelivery.safeParse(req.body)
      if (!parsed.success) throw badRequest('invalid_body')
      const { machineId, sessionSid, tabId, paneId, lines, capturedAt } = parsed.data
      const ok = await submitOutput(
        prisma,
        store,
        req.ingest!.accountId,
        machineId,
        sessionSid,
        tabId,
        paneId,
        lines,
        capturedAt,
      )
      // Generic 403 (uniform across ingest/control): refuse without disclosing that the machineId
      // belongs to another account. machineIds are unguessable secrets, so this leaks nothing usable.
      if (!ok) throw forbidden()
      res.status(204).end()
    }),
  )

  return router
}
