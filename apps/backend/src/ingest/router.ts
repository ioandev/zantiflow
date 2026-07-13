// The ingest endpoint: `POST /api/v1/ingest` (ADR-0003 §3; wire v4 = Appendix B). Token-authed,
// per-token rate-limited, body validated at the boundary (ignore unknown fields, reject
// unknown-newer with 400, bounded depth/lengths), then stored latest-only. Write-only plane.
import type { PrismaClient } from '@prisma/client'
import { parseSnapshot } from '@zantiflow/protocol'
import { Router } from 'express'
import { processAttentions } from '../attentions/service'
import { createForFired } from '../notifications/service'
import { effectiveTier } from '../tiers/service'
import { AppError } from '../http/errors'
import { asyncHandler } from '../http/async'
import { tokenBucket } from '../ratelimit'
import type { SseBus } from '../sse/bus'
import { markTokenUsed } from '../tokens/service'
import { ingestAuth } from './auth'
import { storeSnapshot } from './service'

export const createIngestRouter = (prisma: PrismaClient, bus: SseBus): Router => {
  const router = Router()

  // Per-token ingest limit: ~2/s sustained, burst 10 (Appendix C). Keyed by the authed token so
  // one token can't flood, and one account's tokens can't starve another's.
  const limit = tokenBucket({
    capacity: 10,
    refillPerSec: 2,
    key: (req) => `ingest:${req.ingest?.tokenId ?? 'anon'}`,
  })

  router.post(
    '/',
    ingestAuth(prisma),
    limit,
    asyncHandler(async (req, res) => {
      const result = parseSnapshot(req.body)
      if (!result.ok) {
        // `code` is the machine-readable reason (unknown_wire_version / unsupported_wire_version /
        // invalid_body); all map to 400 so the plugin degrades quietly.
        const details = 'version' in result ? { version: result.version } : undefined
        throw new AppError(400, result.code, 'Invalid ingest snapshot', details)
      }
      const accountId = req.ingest!.accountId
      const machineId = result.snapshot.machineId
      const { sids } = await storeSnapshot(prisma, accountId, req.ingest!.tokenId, result.snapshot)
      await markTokenUsed(prisma, req.ingest!.tokenId)
      // Notify any live dashboard streams for this account (best-effort, in-process).
      bus.publish(accountId, { event: 'machine.update', data: { machineId } })

      // Reconcile attentions server-side (tier-gated firing) and notify streams on change.
      const account = await prisma.account.findUnique({
        where: { id: accountId },
        select: { tier: true, tierExpiresAt: true },
      })
      // Use the EFFECTIVE tier so an expired PRO can't keep pro cadence even before the lapse sweep.
      const tier = account ? effectiveTier(account) : 'free'
      // `session.detached` (a Zellij session with no client attached) is NORMAL usage, not an alert —
      // it fired constantly and told the owner nothing actionable. Whole-machine disconnects are the
      // useful signal and are raised as `machine.offline` by the backend sweep instead (ADR-0028). We
      // drop it here (authoritative, regardless of plugin version); existing active rows self-clear on
      // this ingest since it's no longer in the reported set for the session's sids.
      const reported = result.snapshot.attentions.filter((a) => a.type !== 'session.detached')
      // Scope the reconcile to THIS ingest's sessions — attentions for sessions reported by other
      // plugin instances (other Zellij sessions on the same machine) must not be cleared here.
      const { changed, fired } = await processAttentions(
        prisma,
        accountId,
        machineId,
        reported,
        tier,
        new Date(),
        new Set(sids),
      )
      if (changed) bus.publish(accountId, { event: 'attention.update', data: { machineId } })
      // A fired attention enqueues durable notifications; the dispatcher sweep delivers them.
      if (fired.length > 0) await createForFired(prisma, accountId, tier, fired)

      res.json({ ok: true })
    }),
  )

  return router
}
