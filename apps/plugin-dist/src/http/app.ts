// The Express application factory. Dependency-injected (config/logger/store/readiness) so tests build
// an app without a live server or network. Order: security headers -> health -> asset routes -> 404 ->
// error envelope (registered last).
import express, { type Express } from 'express'
import helmet from 'helmet'
import type { Config } from '../config'
import { healthRouter, type Readiness } from '../health'
import type { Logger } from '../log'
import { wasmRouter } from '../wasm/router'
import type { WasmStore } from '../wasm/store'
import { makeErrorHandler, notFoundHandler } from './errors'

export interface AppDeps {
  config: Config
  logger: Logger
  store: WasmStore
  readiness?: Readiness
}

export const createApp = ({ config, logger, store, readiness }: AppDeps): Express => {
  const app = express()
  // Behind nginx: derive `req.ip` from X-Forwarded-For only for the trusted hops (ADR-0018 §8).
  app.set('trust proxy', config.trustProxy)
  app.disable('x-powered-by')

  app.use(
    helmet({
      // Not an HTML app — no page CSP to set; the payload is a public, cross-origin-fetchable binary
      // (Zellij pulls it directly), so allow cross-origin reads.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      hsts: config.isProd ? undefined : false,
    }),
  )

  app.use(healthRouter(readiness))
  app.use(wasmRouter(store, config))

  app.use(notFoundHandler)
  app.use(makeErrorHandler(logger))
  return app
}
