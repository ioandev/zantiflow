// The Express application factory. Kept dependency-injected (config/logger/readiness) so tests
// build an app without a live server or DB. Order matters: security headers → CORS → body parse →
// cookies → health → versioned API → 404 → error envelope (registered last).
import type { PrismaClient } from '@prisma/client'
import type { OAuthProvider } from '@zantiflow/oauth'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { type Express } from 'express'
import helmet from 'helmet'
import type { Config } from '../config'
import { createControlWaiters, type ControlWaiters } from '../control/waiters'
import { healthRouter, type Readiness } from '../health'
import type { Logger } from '../log'
import { createAutoRefreshLimiter, type AutoRefreshLimiter } from '../output/autoRefresh'
import { createPaneOutputStore, type PaneOutputStore } from '../output/store'
import { createPresence, type Presence } from '../presence/service'
import { createBus, type SseBus } from '../sse/bus'
import { makeErrorHandler, notFoundHandler } from './errors'
import { apiRouter } from './router'

export interface AppDeps {
  config: Config
  logger: Logger
  prisma: PrismaClient
  /** OAuth providers to mount on the auth router (usually `[GoogleProvider]`). */
  authProviders?: OAuthProvider[]
  /** SSE event bus shared by ingest (publish) and /stream (subscribe). Defaults to a fresh bus. */
  bus?: SseBus
  /** Viewer-presence tracker (ADR-0026); defaults to one backed by the bus. */
  presence?: Presence
  /** Long-poll wake registry (ADR-0029); defaults to a fresh in-process one. */
  waiters?: ControlWaiters
  /** Pane-output auto-refresh tier gate (ADR-0016); defaults to a fresh in-process one. */
  autoRefresh?: AutoRefreshLimiter
  /** In-memory pane-output relay (ADR-0032); defaults to a fresh in-process one. Content lives here
   *  only — never the DB. Pass one in (and prune it on the sweep) to share it with a background prune. */
  outputStore?: PaneOutputStore
  readiness?: Readiness
}

export const createApp = ({
  config,
  logger,
  prisma,
  authProviders = [],
  bus = createBus(),
  presence,
  waiters = createControlWaiters(),
  autoRefresh = createAutoRefreshLimiter(),
  outputStore = createPaneOutputStore(),
  readiness,
}: AppDeps): Express => {
  // Presence is bus-backed (a live SSE stream = watching); default to one over the resolved bus.
  const resolvedPresence = presence ?? createPresence(bus)
  const app = express()
  // Behind Caddy/proxy: derive `req.ip` from X-Forwarded-For only for the trusted hops (ADR-0018 §8).
  app.set('trust proxy', config.trustProxy)
  app.disable('x-powered-by')

  app.use(
    helmet({
      // The web/proxy tier (Caddy) owns the page CSP; the JSON API just locks itself down hard.
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      // HSTS only makes sense over TLS in prod; helmet's default is fine there.
      hsts: config.isProd ? undefined : false,
    }),
  )
  // Credentialed CORS locked to the single web origin — never wildcard-with-credentials (ADR-0018 §8).
  app.use(cors({ origin: config.webOrigin, credentials: true }))
  app.use(express.json({ limit: '256kb' }))
  app.use(cookieParser())

  app.use(healthRouter(readiness))
  app.use(
    '/api/v1',
    apiRouter({ prisma, config, authProviders, bus, presence: resolvedPresence, waiters, autoRefresh, outputStore }),
  )

  app.use(notFoundHandler)
  app.use(makeErrorHandler(logger))
  return app
}
