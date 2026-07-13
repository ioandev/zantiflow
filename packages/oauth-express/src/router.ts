// A framework adapter: turn any set of `@zantiflow/oauth` providers into a
// mountable Express router. It owns only the HTTP plumbing that's the same for every
// provider — building the state, reading the callback (query for GET providers, the
// urlencoded body for POST/form_post providers like Apple), exchanging the code, and
// the error responses. Everything app-specific — CSRF signing, sessions, user
// persistence, popup-vs-redirect — is delegated to hooks you pass in.
import express, { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express'
import type { OAuthProfile, OAuthProvider } from '@zantiflow/oauth'

/** Context handed to `onLogin` after a successful code exchange. */
export interface OAuthLoginContext {
  /** The provider the user signed in with. */
  provider: OAuthProvider
  /** The verified state claims (whatever `startState` put in, e.g. mode/redirect). */
  state: Record<string, unknown>
  req: Request
  res: Response
}

export interface OAuthRouterOptions {
  /** The providers to mount. Each gets `/auth/<id>` + `/auth/<id>/callback`. */
  providers: OAuthProvider[]
  /** Sign an opaque state token carrying these claims (your CSRF protection). */
  signState(claims: Record<string, unknown>): string
  /** Verify + decode a state token; return the claims, or null if invalid/expired. */
  verifyState(token: string): Record<string, unknown> | null
  /** Complete the login: persist the user and write the response (set a cookie and
   *  redirect, or send popup HTML, etc.). The code exchange already succeeded. */
  onLogin(profile: OAuthProfile, ctx: OAuthLoginContext): void | Promise<void>
  /** Extra claims to fold into the state at login start (e.g. `{ mode, redirect }`
   *  read from the query). The provider id is always added automatically. */
  startState?(req: Request): Record<string, unknown>
  /** Middleware to run on the start route(s) only — e.g. a rate limiter. */
  startMiddleware?: RequestHandler | RequestHandler[]
}

const toArray = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v])

// Adapt an async handler to Express, forwarding rejections to the error middleware
// (works on both Express 4 and 5).
const wrap =
  (h: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    void h(req, res).catch(next)
  }

/**
 * Build an Express router that mounts OAuth login + callback routes for each
 * provider. Mount it wherever you like: `app.use('/api/v1', createOAuthRouter(...))`.
 * Routes are registered per provider (concrete paths, not a `:provider` param) so
 * they never shadow your other `/auth/*` routes (logout, me, …).
 */
export function createOAuthRouter(options: OAuthRouterOptions): Router {
  const router = Router()
  const startMiddleware = toArray(options.startMiddleware)

  for (const provider of options.providers) {
    // Start: redirect to the provider's consent screen with a signed state.
    router.get(`/auth/${provider.id}`, ...startMiddleware, (req: Request, res: Response) => {
      const claims = { ...(options.startState?.(req) ?? {}), provider: provider.id }
      res.redirect(provider.buildAuthUrl(options.signState(claims)))
    })

    // Callback: verify state, exchange the code, hand off to onLogin.
    const handleCallback = async (req: Request, res: Response): Promise<void> => {
      const src = (provider.callbackMethod === 'POST' ? req.body : req.query) as Record<string, unknown> | undefined
      if (src?.error) {
        res.status(400).json({ error: `${provider.id}_denied`, detail: String(src.error) })
        return
      }
      const state = options.verifyState(typeof src?.state === 'string' ? src.state : '')
      if (!state) {
        res.status(400).json({ error: 'invalid_state' })
        return
      }
      if (typeof src?.code !== 'string') {
        res.status(400).json({ error: 'missing_code' })
        return
      }

      let profile: OAuthProfile
      try {
        profile = await provider.exchangeCode(src.code, src)
      } catch {
        res.status(502).json({ error: `${provider.id}_exchange_failed` })
        return
      }
      await options.onLogin(profile, { provider, state, req, res })
    }

    // Apple posts the callback (form_post) → parse the urlencoded body; Google GETs it.
    if (provider.callbackMethod === 'POST') {
      router.post(`/auth/${provider.id}/callback`, express.urlencoded({ extended: false }), wrap(handleCallback))
    } else {
      router.get(`/auth/${provider.id}/callback`, wrap(handleCallback))
    }
  }

  return router
}
