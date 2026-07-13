import { describe, it, expect, vi, afterEach } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { OAuthProfile, OAuthProvider } from '@zantiflow/oauth'
import { createOAuthRouter, type OAuthRouterOptions } from '../src/router'

const PROFILE: OAuthProfile = { sub: 'g-sub', email: 'e@x.com', name: 'Ann', picture: null }

type FakeProvider = OAuthProvider & {
  buildAuthUrl: ReturnType<typeof vi.fn>
  exchangeCode: ReturnType<typeof vi.fn>
}

// A fake provider: implements the OAuthProvider contract with spies for the two calls
// the router makes (buildAuthUrl on start, exchangeCode on callback).
const fakeProvider = (id: string, callbackMethod: 'GET' | 'POST', over: Partial<OAuthProvider> = {}): FakeProvider =>
  ({
    id,
    callbackMethod,
    buildAuthUrl: vi.fn((state: string) => `https://consent.test/${id}?state=${encodeURIComponent(state)}`),
    exchangeCode: vi.fn(async () => PROFILE),
    ...over,
  }) as FakeProvider

const defaults = (over: Partial<OAuthRouterOptions> = {}): OAuthRouterOptions => ({
  providers: [],
  signState: vi.fn((claims: Record<string, unknown>) => 'signed:' + JSON.stringify(claims)),
  verifyState: vi.fn((token: string) => (token === 'good' ? { mode: 'session' } : null)),
  onLogin: vi.fn((profile: OAuthProfile, ctx) => {
    ctx.res.json({ ok: true, sub: profile.sub, state: ctx.state })
  }),
  ...over,
})

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
})

async function mount(opts: OAuthRouterOptions) {
  const app = express()
  app.use(createOAuthRouter(opts))
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  servers.push(server)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    get: (path: string) => fetch(base + path, { redirect: 'manual' }),
    postForm: (path: string, form: Record<string, string>) =>
      fetch(base + path, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
      }),
  }
}

describe('createOAuthRouter — start route', () => {
  it('GET /auth/<id> → 302 to the provider consent URL with a signed state', async () => {
    const google = fakeProvider('google', 'GET')
    const opts = defaults({ providers: [google], startState: (req) => ({ mode: req.query.mode }) })
    const app = await mount(opts)
    const res = await app.get('/auth/google?mode=popup')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('https://consent.test/google')
    // startState claims are folded together with the always-added provider id
    expect(opts.signState).toHaveBeenCalledWith({ mode: 'popup', provider: 'google' })
    expect(google.buildAuthUrl).toHaveBeenCalledWith('signed:' + JSON.stringify({ mode: 'popup', provider: 'google' }))
  })

  it('always folds the provider id into the state, even without a startState', async () => {
    const google = fakeProvider('google', 'GET')
    const opts = defaults({ providers: [google] })
    const app = await mount(opts)
    await app.get('/auth/google')
    expect(opts.signState).toHaveBeenCalledWith({ provider: 'google' })
  })

  it('runs startMiddleware on the start route (a 401 there blocks the redirect)', async () => {
    const google = fakeProvider('google', 'GET')
    const startMiddleware = vi.fn((_req: express.Request, res: express.Response) => {
      res.status(401).json({ error: 'rate_limited' })
    })
    const opts = defaults({ providers: [google], startMiddleware })
    const app = await mount(opts)
    const res = await app.get('/auth/google')
    expect(res.status).toBe(401)
    expect(startMiddleware).toHaveBeenCalledTimes(1)
    expect(google.buildAuthUrl).not.toHaveBeenCalled()
  })

  it('does NOT run startMiddleware on the callback route', async () => {
    const google = fakeProvider('google', 'GET')
    const startMiddleware = vi.fn((_req: express.Request, _res: express.Response, next: express.NextFunction) => next())
    const opts = defaults({ providers: [google], startMiddleware })
    const app = await mount(opts)
    await app.get('/auth/google/callback?code=abc&state=good')
    expect(startMiddleware).not.toHaveBeenCalled()
    expect(google.exchangeCode).toHaveBeenCalledTimes(1)
  })
})

describe('createOAuthRouter — GET callback (query params)', () => {
  it('verifies state, exchanges the code with the query bag, and hands off to onLogin', async () => {
    const google = fakeProvider('google', 'GET')
    const opts = defaults({ providers: [google] })
    const app = await mount(opts)
    const res = await app.get('/auth/google/callback?code=abc&state=good')
    expect(opts.verifyState).toHaveBeenCalledWith('good')
    expect(google.exchangeCode).toHaveBeenCalledTimes(1)
    expect(google.exchangeCode.mock.calls[0][0]).toBe('abc')
    expect(google.exchangeCode.mock.calls[0][1]).toMatchObject({ code: 'abc', state: 'good' }) // the query bag
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, sub: 'g-sub', state: { mode: 'session' } })
  })

  it('?error → 400 <id>_denied and never exchanges the code', async () => {
    const google = fakeProvider('google', 'GET')
    const opts = defaults({ providers: [google] })
    const app = await mount(opts)
    const res = await app.get('/auth/google/callback?error=access_denied&state=good')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'google_denied', detail: 'access_denied' })
    expect(google.exchangeCode).not.toHaveBeenCalled()
  })

  it('invalid state → 400 invalid_state (no exchange)', async () => {
    const google = fakeProvider('google', 'GET')
    const opts = defaults({ providers: [google] })
    const app = await mount(opts)
    const res = await app.get('/auth/google/callback?code=abc&state=bad')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_state' })
    expect(google.exchangeCode).not.toHaveBeenCalled()
  })

  it('missing code → 400 missing_code', async () => {
    const google = fakeProvider('google', 'GET')
    const opts = defaults({ providers: [google] })
    const app = await mount(opts)
    const res = await app.get('/auth/google/callback?state=good')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'missing_code' })
  })

  it('a failed code exchange → 502 <id>_exchange_failed (onLogin not called)', async () => {
    const google = fakeProvider('google', 'GET', {
      exchangeCode: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    const opts = defaults({ providers: [google] })
    const app = await mount(opts)
    const res = await app.get('/auth/google/callback?code=abc&state=good')
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'google_exchange_failed' })
    expect(opts.onLogin).not.toHaveBeenCalled()
  })
})

describe('createOAuthRouter — POST callback (form_post providers like Apple)', () => {
  it('reads code/state from the urlencoded body and forwards the whole bag as params', async () => {
    const apple = fakeProvider('apple', 'POST')
    const opts = defaults({ providers: [apple] })
    const app = await mount(opts)
    const res = await app.postForm('/auth/apple/callback', {
      code: 'abc',
      state: 'good',
      user: JSON.stringify({ name: { firstName: 'Jane' } }),
    })
    expect(apple.exchangeCode).toHaveBeenCalledTimes(1)
    expect(apple.exchangeCode.mock.calls[0][0]).toBe('abc')
    expect(apple.exchangeCode.mock.calls[0][1]).toMatchObject({ code: 'abc', state: 'good' })
    expect(String(apple.exchangeCode.mock.calls[0][1].user)).toContain('Jane') // one-time name field
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, sub: 'g-sub', state: { mode: 'session' } })
  })

  it('an error field in the body → 400 apple_denied', async () => {
    const apple = fakeProvider('apple', 'POST')
    const opts = defaults({ providers: [apple] })
    const app = await mount(opts)
    const res = await app.postForm('/auth/apple/callback', { error: 'user_cancelled_authorize', state: 'good' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'apple_denied', detail: 'user_cancelled_authorize' })
    expect(apple.exchangeCode).not.toHaveBeenCalled()
  })

  it('the GET route is not registered for a POST-callback provider', async () => {
    const apple = fakeProvider('apple', 'POST')
    const opts = defaults({ providers: [apple] })
    const app = await mount(opts)
    // GET on a form_post provider's callback → no matching route → 404
    const res = await app.get('/auth/apple/callback?code=abc&state=good')
    expect(res.status).toBe(404)
    expect(apple.exchangeCode).not.toHaveBeenCalled()
  })
})
