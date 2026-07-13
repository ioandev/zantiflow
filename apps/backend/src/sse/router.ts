// Dashboard live stream: `GET /api/v1/stream` (ADR-0008). Owner-gated Server-Sent Events, scoped to
// the caller's account. Concurrent streams per account are capped (audit E7) to prevent connection
// exhaustion. Latest-state only — there is no history replay (retention = none).
import type { PrismaClient } from '@prisma/client'
import { Router } from 'express'
import { requireSession } from '../auth/session'
import type { Config } from '../config'
import { errorEnvelope } from '../http/errors'
import type { Presence } from '../presence/service'
import type { SseBus } from './bus'

export const MAX_SSE_PER_ACCOUNT = 5

export const createSseRouter = (prisma: PrismaClient, config: Config, bus: SseBus, presence: Presence): Router => {
  const router = Router()

  router.get('/', requireSession(prisma, config), (req, res) => {
    const accountId = req.account!.id
    if (bus.countFor(accountId) >= MAX_SSE_PER_ACCOUNT) {
      res.setHeader('Retry-After', '10')
      res.status(429).json(errorEnvelope('too_many_streams', 'Too many concurrent streams'))
      return
    }

    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()
    res.write(': connected\n\n')

    // An open stream IS presence (ADR-0026); mark on connect and on each heartbeat so the TTL keeps
    // covering an idle-but-open tab and bridges a reconnect blip after `close` drops the count.
    presence.markViewer(accountId)
    const unsubscribe = bus.subscribe(accountId, (event) => {
      res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`)
    })
    // Keep intermediaries from closing an idle connection; unref so it never holds the process open.
    const heartbeat = setInterval(() => {
      presence.markViewer(accountId)
      res.write(': ping\n\n')
    }, 25_000)
    heartbeat.unref?.()

    req.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })

  return router
}
