// Self-host owner secret sign-in (ADR-0035) against a REAL MariaDB (testcontainers). Verifies the
// `POST /auth/local` + `GET /auth/methods` surface: correct secret → ztf_session → /auth/me as the
// single 'local'/'owner' account; wrong/missing secret; no-duplicate upsert; logout-all revocation;
// methods reflect config; the route is absent (404) without a secret; and the stricter rate limit.
// A fresh app is built per test so each gets a fresh rate-limit bucket (no cross-test depletion).
import { execFileSync } from 'node:child_process'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { MariaDbContainer, type StartedMariaDbContainer } from '@testcontainers/mariadb'
import { PrismaClient } from '@prisma/client'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import { generateKeyPair } from 'jose'
import { GoogleProvider, type OAuthProvider } from '@zantiflow/oauth'
import type { Express } from 'express'
import { type Config, parseConfig } from '../src/config'
import { LOCAL_PROVIDER } from '../src/auth/local'
import { createApp } from '../src/http/app'
import { nullLogger } from '../src/log'
import { containerRuntimeUp, socketPath } from './helpers/runtime'

const runtimeUp = await containerRuntimeUp()
if (!runtimeUp) {
  console.warn(`[auth-local.integration] no container runtime at ${socketPath} — skipping local-auth tests`)
}
const suite = runtimeUp ? describe : describe.skip

const SECRET = 'z'.repeat(40)
const WRONG = 'w'.repeat(40)
const AUD = 'cid.apps.googleusercontent.com'

const cookieFrom = (setCookie: string[] | undefined, name: string): string | undefined =>
  setCookie?.map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`))

suite('auth-local integration (self-host secret, testcontainers MariaDB)', () => {
  let container: StartedMariaDbContainer
  let prisma: PrismaClient
  let configSecret: Config
  let configNoSecret: Config
  let google: OAuthProvider

  const makeApp = (config: Config, providers: OAuthProvider[]): Express =>
    createApp({ config, logger: nullLogger, prisma, authProviders: providers })

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

    const { publicKey } = await generateKeyPair('RS256')
    google = new GoogleProvider({
      clientId: AUD,
      clientSecret: 'secret',
      redirectUri: 'https://app.example/api/v1/auth/google/callback',
      tokenUrl: 'https://oauth2.test/token',
      keyResolver: publicKey,
    })
    const boilerplate = { DATABASE_URL: url, TOKEN_SECRET: 'x'.repeat(40), COOKIE_SECURE: 'false' }
    configSecret = parseConfig({ ...boilerplate, SELF_HOST_SECRET: SECRET })
    configNoSecret = parseConfig(boilerplate)
  }, 240_000)

  // Isolate tests: hard-delete the single local owner between them so upsert/one-row assertions hold.
  afterEach(async () => {
    await prisma.account.deleteMany({ where: { oauthProvider: LOCAL_PROVIDER } })
  })
  afterAll(async () => {
    await prisma?.$disconnect()
    await container?.stop()
  })

  it('signs the owner in with the correct secret and serves /auth/me as Owner', async () => {
    const app = makeApp(configSecret, [])
    const res = await request(app).post('/api/v1/auth/local').send({ secret: SECRET })
    expect(res.status).toBe(204)
    const cookie = cookieFrom(res.headers['set-cookie'], 'ztf_session')
    expect(cookie).toBeTruthy()

    const me = await request(app).get('/api/v1/auth/me').set('Cookie', cookie!)
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ name: 'Owner', email: null, avatarUrl: null, tier: 'free' })

    const row = await prisma.account.findUnique({
      where: { oauthProvider_oauthId: { oauthProvider: LOCAL_PROVIDER, oauthId: 'owner' } },
    })
    expect(row?.name).toBe('Owner')
  })

  it('rejects a wrong secret with 401 invalid_secret and sets no cookie', async () => {
    const res = await request(makeApp(configSecret, [])).post('/api/v1/auth/local').send({ secret: WRONG })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('invalid_secret')
    expect(cookieFrom(res.headers['set-cookie'], 'ztf_session')).toBeUndefined()
  })

  it('rejects a missing or non-string secret with 400', async () => {
    const app = makeApp(configSecret, [])
    expect((await request(app).post('/api/v1/auth/local').send({})).status).toBe(400)
    expect((await request(app).post('/api/v1/auth/local').send({ secret: 12345 })).status).toBe(400)
  })

  it('a second login does not duplicate the owner row (upsert)', async () => {
    const app = makeApp(configSecret, [])
    expect((await request(app).post('/api/v1/auth/local').send({ secret: SECRET })).status).toBe(204)
    expect((await request(app).post('/api/v1/auth/local').send({ secret: SECRET })).status).toBe(204)
    const rows = await prisma.account.findMany({ where: { oauthProvider: LOCAL_PROVIDER } })
    expect(rows).toHaveLength(1)
  })

  it('logout-all invalidates an outstanding local session cookie', async () => {
    const app = makeApp(configSecret, [])
    const login = await request(app).post('/api/v1/auth/local').send({ secret: SECRET })
    const cookie = cookieFrom(login.headers['set-cookie'], 'ztf_session')!
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(200)

    expect((await request(app).post('/api/v1/auth/logout-all').set('Cookie', cookie)).status).toBe(204)
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(401)
  })

  it('GET /auth/methods reflects which methods are configured', async () => {
    const both = await request(makeApp(configSecret, [google])).get('/api/v1/auth/methods')
    expect(both.body).toEqual({ google: true, local: true })

    const localOnly = await request(makeApp(configSecret, [])).get('/api/v1/auth/methods')
    expect(localOnly.body).toEqual({ google: false, local: true })

    const none = await request(makeApp(configNoSecret, [])).get('/api/v1/auth/methods')
    expect(none.body).toEqual({ google: false, local: false })
  })

  it('does not mount /auth/local when no secret is configured (404)', async () => {
    const res = await request(makeApp(configNoSecret, [])).post('/api/v1/auth/local').send({ secret: SECRET })
    expect(res.status).toBe(404)
  })

  it('rate-limits repeated secret attempts (429 with Retry-After after the bucket empties)', async () => {
    const app = makeApp(configSecret, []) // fresh bucket: capacity 5
    for (let i = 0; i < 5; i++) {
      expect((await request(app).post('/api/v1/auth/local').send({ secret: WRONG })).status).toBe(401)
    }
    const sixth = await request(app).post('/api/v1/auth/local').send({ secret: WRONG })
    expect(sixth.status).toBe(429)
    expect(sixth.headers['retry-after']).toBeTruthy()
  })
})
