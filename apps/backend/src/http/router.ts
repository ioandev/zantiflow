// The versioned API surface, mounted at `/api/v1`. Feature routers mount here as phases add them
// (tokens, machines, ingest, output, attentions, notifications, promo, …). Unknown paths fall
// through to the 404 handler registered in `app.ts`.
import type { PrismaClient } from '@prisma/client'
import type { OAuthProvider } from '@zantiflow/oauth'
import { Router } from 'express'
import { createAttentionsRouter } from '../attentions/router'
import { createAuthRouter } from '../auth/router'
import type { Config } from '../config'
import { createControlRouter } from '../control/router'
import type { ControlWaiters } from '../control/waiters'
import { createIngestRouter } from '../ingest/router'
import { createIntegrationsRouter } from '../integrations/router'
import { createMachinesRouter } from '../machines/router'
import { createNotificationsRouter } from '../notifications/router'
import type { AutoRefreshLimiter } from '../output/autoRefresh'
import { createOutputRouter } from '../output/router'
import type { PaneOutputStore } from '../output/store'
import { createPairingRouter } from '../pairing/router'
import type { Presence } from '../presence/service'
import { createPromoRouter } from '../promo/router'
import { createPushRouter } from '../push/router'
import { createSpotlightRouter } from '../spotlight/router'
import type { SseBus } from '../sse/bus'
import { createSseRouter } from '../sse/router'
import { createTokensRouter } from '../tokens/router'

export interface ApiDeps {
  prisma: PrismaClient
  config: Config
  authProviders: OAuthProvider[]
  bus: SseBus
  presence: Presence
  /** Long-poll wake registry (ADR-0029): control holds on it; machines signals it. */
  waiters: ControlWaiters
  /** Pane-output auto-refresh tier gate (ADR-0016): machines gates each refresh tick on it. */
  autoRefresh: AutoRefreshLimiter
  /** In-memory pane-output relay (ADR-0032): captured content lives here, never in the DB. */
  outputStore: PaneOutputStore
}

export const apiRouter = (deps: ApiDeps): Router => {
  const r = Router()
  r.use(createAuthRouter({ prisma: deps.prisma, config: deps.config, providers: deps.authProviders }))
  // Mounted at a path so its owner-session gate applies only to /tokens/*, not unmatched routes.
  r.use('/tokens', createTokensRouter(deps.prisma, deps.config, deps.outputStore))
  // Device pairing — start/poll unauth (plugin), approve owner-gated (per-route).
  r.use('/pair', createPairingRouter(deps.prisma, deps.config))
  // Write plane — token-authed (not owner session), mounted at its own path.
  r.use('/ingest', createIngestRouter(deps.prisma, deps.bus))
  // Pane-output plugin plane — token-authed (poll + deliver).
  r.use('/output', createOutputRouter(deps.prisma, deps.outputStore))
  // Always-on control plane (ADR-0026) — token-authed; liveness touch + presence + refresh. Holds
  // long-poll requests on `waiters` (ADR-0029) when the plugin opts in.
  r.use('/control', createControlRouter(deps.prisma, deps.presence, deps.waiters))
  // Read plane — owner-session-gated. Signals `waiters` so a view-request/refresh wakes a held poll.
  r.use(
    '/machines',
    createMachinesRouter(deps.prisma, deps.config, deps.presence, deps.waiters, deps.autoRefresh, deps.outputStore),
  )
  // Spotlight (ADR-0016) — PRO-only live roster of active Claude sessions across the account's machines.
  r.use('/spotlight', createSpotlightRouter(deps.prisma, deps.config, deps.presence))
  r.use('/attentions', createAttentionsRouter(deps.prisma, deps.config))
  r.use('/notifications', createNotificationsRouter(deps.prisma, deps.config))
  r.use('/stream', createSseRouter(deps.prisma, deps.config, deps.bus, deps.presence))
  r.use('/push', createPushRouter(deps.prisma, deps.config))
  r.use('/promo', createPromoRouter(deps.prisma, deps.config))
  r.use('/integrations', createIntegrationsRouter(deps.prisma, deps.config))
  return r
}
