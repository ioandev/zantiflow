// Full owner-auth flow against a REAL MariaDB (testcontainers) with Google mocked (ADR-0014 /
// plan Phase 1 Tests): mocked-Google login → ztf_session → /auth/me; /auth/me 401 without a
// session; logout-all bumps sessionEpoch so an outstanding cookie is rejected.
import { execFileSync } from 'node:child_process'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { MariaDbContainer, type StartedMariaDbContainer } from '@testcontainers/mariadb'
import { PrismaClient } from '@prisma/client'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import { generateKeyPair, SignJWT, type KeyLike } from 'jose'
import { GoogleProvider } from '@zantiflow/oauth'
import type { Express } from 'express'
import { parseConfig } from '../src/config'
import { createApp } from '../src/http/app'
import { nullLogger } from '../src/log'
import { containerRuntimeUp, socketPath } from './helpers/runtime'

const runtimeUp = await containerRuntimeUp()
if (!runtimeUp) {
  console.warn(`[auth.integration] no container runtime at ${socketPath} — skipping auth integration tests`)
}
const suite = runtimeUp ? describe : describe.skip

const AUD = 'cid.apps.googleusercontent.com'

const cookieFrom = (setCookie: string[] | undefined, name: string): string | undefined =>
  setCookie?.map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`))

suite('auth integration (Google mocked, testcontainers MariaDB)', () => {
  let container: StartedMariaDbContainer
  let prisma: PrismaClient
  let app: Express
  let priv: KeyLike
  let pub: KeyLike

  const signIdToken = (claims: Record<string, unknown>): Promise<string> =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('https://accounts.google.com')
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime('2h')
      .sign(priv)

  // Drive login through the router; returns the ztf_session cookie string.
  const login = async (agent: ReturnType<typeof request.agent>, profile: Record<string, unknown>): Promise<string> => {
    const start = await agent.get('/api/v1/auth/google')
    expect(start.status).toBe(302)
    const state = new URL(start.headers.location).searchParams.get('state')
    expect(state).toBeTruthy()

    const idToken = await signIdToken(profile)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id_token: idToken }) })),
    )
    const cb = await agent.get(`/api/v1/auth/google/callback?code=CODE&state=${encodeURIComponent(state!)}`)
    vi.unstubAllGlobals()

    expect(cb.status).toBe(302)
    const cookie = cookieFrom(cb.headers['set-cookie'], 'ztf_session')
    expect(cookie).toBeTruthy()
    return cookie!
  }

  beforeAll(async () => {
    container = await new MariaDbContainer('mariadb:11.4')
      .withDatabase('zantiflow')
      .withUsername('zantiflow')
      .withUserPassword('zantiflow')
      .start()
    const url = `mysql://zantiflow:zantiflow@${container.getHost()}:${container.getPort()}/zantiflow`
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ adapter: new PrismaMariaDb(url) })
    await prisma.$connect()
    ;({ privateKey: priv, publicKey: pub } = await generateKeyPair('RS256'))

    const config = parseConfig({ DATABASE_URL: url, TOKEN_SECRET: 'x'.repeat(40), COOKIE_SECURE: 'false' })
    const google = new GoogleProvider({
      clientId: AUD,
      clientSecret: 'secret',
      redirectUri: 'https://app.example/api/v1/auth/google/callback',
      tokenUrl: 'https://oauth2.test/token',
      keyResolver: pub,
    })
    app = createApp({ config, logger: nullLogger, prisma, authProviders: [google] })
  }, 240_000)

  afterEach(() => vi.unstubAllGlobals())
  afterAll(async () => {
    await prisma?.$disconnect()
    await container?.stop()
  })

  it('logs a user in (mocked Google), creates the account, and serves /auth/me', async () => {
    const agent = request.agent(app)
    await login(agent, {
      sub: 'g-1',
      email: 'ann@example.com',
      email_verified: true,
      name: 'Ann',
      picture: 'https://x/p',
    })

    const me = await agent.get('/api/v1/auth/me')
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ email: 'ann@example.com', name: 'Ann', tier: 'free' })
    expect(me.headers['cache-control']).toBe('no-store')

    const acc = await prisma.account.findUnique({
      where: { oauthProvider_oauthId: { oauthProvider: 'google', oauthId: 'g-1' } },
    })
    expect(acc?.email).toBe('ann@example.com')
  })

  it('a second login with the same identity updates rather than duplicates', async () => {
    const agent = request.agent(app)
    await login(agent, { sub: 'g-dup', email: 'first@example.com', name: 'First' })
    await login(agent, { sub: 'g-dup', email: 'second@example.com', name: 'Second' })
    const rows = await prisma.account.findMany({ where: { oauthProvider: 'google', oauthId: 'g-dup' } })
    expect(rows).toHaveLength(1)
    expect(rows[0].email).toBe('second@example.com')
  })

  it('rejects /auth/me without a session (401)', async () => {
    const res = await request(app).get('/api/v1/auth/me')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('unauthorized')
  })

  it('rejects a callback with an invalid/forged state (400)', async () => {
    const res = await request(app).get('/api/v1/auth/google/callback?code=CODE&state=forged.sig')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_state')
  })

  it('logout-all bumps sessionEpoch so an outstanding cookie is rejected', async () => {
    const agent = request.agent(app)
    const cookie = await login(agent, { sub: 'g-lo', email: 'lo@example.com', name: 'Lo' })

    // The cookie works before logout-all.
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(200)

    const lo = await agent.post('/api/v1/auth/logout-all')
    expect(lo.status).toBe(204)

    // The SAME cookie is now invalid (epoch mismatch on the DB re-check).
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(401)
  })
})
