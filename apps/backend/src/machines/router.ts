// Machine read/manage API (ADR-0008) — OWNER plane. Mounted at /machines; the whole plane requires
// an owner session. Responses are account-specific → never cached.
import type { PrismaClient } from '@prisma/client'
import { Router } from 'express'
import { requireSession } from '../auth/session'
import type { Config } from '../config'
import type { ControlWaiters } from '../control/waiters'
import { asyncHandler } from '../http/async'
import { badRequest, notFound } from '../http/errors'
import type { AutoRefreshLimiter } from '../output/autoRefresh'
import { readOutput, registerRequest } from '../output/service'
import type { PaneOutputStore } from '../output/store'
import type { Presence } from '../presence/service'
import { tokenBucket } from '../ratelimit'
import { effectiveTier } from '../tiers/service'
import { forgetMachine, getMachine, listMachines } from './service'

const parseNonNegInt = (v: unknown): number | null => {
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : null
}

/** A pane is addressed by its FULL identity `sessionSid/tabId/paneId` (a bare paneId is only unique
 * within one session — see output/service). Returns null if any segment is missing/malformed. */
const parsePaneRef = (params: {
  sid?: unknown
  tabId?: unknown
  paneId?: unknown
}): { sessionSid: string; tabId: number; paneId: number } | null => {
  const sessionSid = typeof params.sid === 'string' ? params.sid : ''
  const tabId = parseNonNegInt(params.tabId)
  const paneId = parseNonNegInt(params.paneId)
  if (!sessionSid || sessionSid.length > 64 || tabId === null || paneId === null) return null
  return { sessionSid, tabId, paneId }
}

export const createMachinesRouter = (
  prisma: PrismaClient,
  config: Config,
  presence: Presence,
  waiters: ControlWaiters,
  autoRefresh: AutoRefreshLimiter,
  outputStore: PaneOutputStore,
): Router => {
  const router = Router()
  router.use(requireSession(prisma, config))

  // Reading the dashboard is a viewer signal (ADR-0026) — covers the SSE-less polling-fallback client.
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      presence.markViewer(req.account!.id)
      res.setHeader('Cache-Control', 'no-store')
      res.json({ machines: await listMachines(prisma, req.account!.id) })
    }),
  )

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      presence.markViewer(req.account!.id)
      res.setHeader('Cache-Control', 'no-store')
      res.json(await getMachine(prisma, req.account!.id, String(req.params.id)))
    }),
  )

  // Manual refresh button (ADR-0026): bump the machine's refresh sequence so its plugin sends one
  // fresh snapshot on the next control poll. Strict rate-limit (≥5 s per account+machine, ADR-0018 §9)
  // — one token, refilling at 1/5 s — so a mashed button can't force a per-second cadence.
  const refreshLimit = tokenBucket({
    capacity: 1,
    refillPerSec: 0.2,
    key: (req) => `refresh:${req.account?.id ?? 'anon'}:${req.params.id}`,
  })
  router.post(
    '/:id/refresh',
    refreshLimit,
    asyncHandler(async (req, res) => {
      const machineId = String(req.params.id)
      // Owner-scoped: a caller can only refresh their own machine (IDOR → 404).
      const owned = await prisma.machine.findFirst({
        where: { id: machineId, accountId: req.account!.id },
        select: { id: true },
      })
      if (!owned) throw notFound('machine_not_found')
      presence.markViewer(req.account!.id)
      presence.bumpRefresh(machineId)
      // Wake any long-poll parked for this machine so the refresh reaches the plugin now (ADR-0029).
      waiters.signal(machineId)
      res.status(202).end()
    }),
  )

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      await forgetMachine(prisma, outputStore, req.account!.id, String(req.params.id))
      res.status(204).end()
    }),
  )

  // --- On-demand pane output (ADR-0016), owner plane. A pane is addressed by its full
  // sessionSid/tabId/paneId identity so panes that merely share a numeric id in another tab/session
  // never collide (they used to overwrite + read back each other's output). ---
  router.post(
    '/:id/sessions/:sid/tabs/:tabId/panes/:paneId/output/request',
    asyncHandler(async (req, res) => {
      const ref = parsePaneRef(req.params)
      if (ref === null) throw badRequest('invalid_pane_id')
      const machineId = String(req.params.id)
      // The drawer auto-refreshes while open (ADR-0016). `mode=auto` is one automatic tick; anything
      // else (incl. the `start` default) is a human gesture — a drawer open or "resume" — that
      // (re)opens the tier-gated auto-refresh window. PRO refreshes indefinitely; a spent FREE window
      // makes an `auto` tick refused server-side (`{ autoRefresh: false }`) so the client pauses and
      // must resume manually — a free client can't bypass the UI and keep streaming.
      const mode = req.query.mode === 'auto' ? 'auto' : 'start'
      const key = `${req.account!.id}:${machineId}:${ref.sessionSid}:${ref.tabId}:${ref.paneId}`
      if (mode === 'start') {
        autoRefresh.start(key)
      } else if (!autoRefresh.allow(key, effectiveTier(req.account!))) {
        // Window spent: don't capture again — the client keeps its last frame and shows "resume".
        res.status(202).json({ autoRefresh: false })
        return
      }
      const ok = await registerRequest(
        prisma,
        outputStore,
        req.account!.id,
        machineId,
        ref.sessionSid,
        ref.tabId,
        ref.paneId,
      )
      if (!ok) throw notFound('machine_not_found')
      // Wake any long-poll parked for this machine so the plugin captures this pane now (ADR-0029).
      waiters.signal(machineId)
      res.status(202).json({ autoRefresh: true })
    }),
  )

  router.get(
    '/:id/sessions/:sid/tabs/:tabId/panes/:paneId/output',
    asyncHandler(async (req, res) => {
      const ref = parsePaneRef(req.params)
      if (ref === null) throw badRequest('invalid_pane_id')
      res.setHeader('Cache-Control', 'no-store')
      res.json(
        await readOutput(
          prisma,
          outputStore,
          req.account!.id,
          String(req.params.id),
          ref.sessionSid,
          ref.tabId,
          ref.paneId,
        ),
      )
    }),
  )

  return router
}
