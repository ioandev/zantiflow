// Liveness + readiness probes (ADR-0018 §1; used by the compose healthchecks). `/healthz` is a
// pure liveness signal (the process is up); `/readyz` runs a caller-supplied readiness check
// (DB connectivity, wired in Phase 1b) and returns 503 until dependencies are reachable.
import { Router } from 'express'
import { asyncHandler } from '../http/async'
import { getVersion } from '../version'

export type Readiness = () => Promise<boolean> | boolean

export const healthRouter = (readiness: Readiness = () => true): Router => {
  const r = Router()

  r.get('/healthz', (_req, res) => {
    const { version, commit } = getVersion()
    res.json({ status: 'ok', version, commit })
  })

  r.get(
    '/readyz',
    asyncHandler(async (_req, res) => {
      const ready = await readiness()
      if (ready) res.json({ status: 'ready' })
      else res.status(503).json({ error: { code: 'not_ready', message: 'Not Ready' } })
    }),
  )

  return r
}
