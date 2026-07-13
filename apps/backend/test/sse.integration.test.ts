// SSE wiring against a REAL MariaDB (testcontainers): ingest publishes a machine.update to the
// account bus, and /stream is owner-gated + capped. The full HTTP event stream is exercised at the
// Playwright layer (Phase 4); here we prove the publish wiring + the auth/cap guards.
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { MariaDbContainer, type StartedMariaDbContainer } from '@testcontainers/mariadb'
import { PrismaClient } from '@prisma/client'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import type { SseEvent } from '@zantiflow/protocol'
import { signSession } from '../src/auth/tokens'
import { parseConfig, type Config } from '../src/config'
import { createApp } from '../src/http/app'
import { nullLogger } from '../src/log'
import { createBus } from '../src/sse/bus'
import { MAX_SSE_PER_ACCOUNT } from '../src/sse/router'
import { generateToken } from '../src/tokens/secret'
import { containerRuntimeUp, socketPath } from './helpers/runtime'

const runtimeUp = await containerRuntimeUp()
if (!runtimeUp) {
  console.warn(`[sse.integration] no container runtime at ${socketPath} — skipping SSE integration tests`)
}
const suite = runtimeUp ? describe : describe.skip

const snapshot = (machineId: string) => ({
  version: 4,
  machineId,
  capturedAtTick: 1,
  privacy: { full: true, machine: 'alias', sessionNames: 'send', tabNames: 'send', paneNames: 'hidden' },
  machine: { source: 'alias', name: 'box' },
  attentions: [],
  sessions: [],
})

suite('sse integration (testcontainers MariaDB)', () => {
  let container: StartedMariaDbContainer
  let prisma: PrismaClient
  let config: Config
  let seq = 0

  const newAccount = () =>
    prisma.account.create({ data: { oauthProvider: 'google', oauthId: `s-${seq++}`, name: 'O' } })
  const mkToken = async (accountId: string): Promise<string> => {
    const t = generateToken()
    await prisma.token.create({ data: { accountId, lookupPrefix: t.lookupPrefix, secretHash: t.secretHash } })
    return t.secret
  }
  const cookieFor = (accountId: string) => `ztf_session=${signSession(config.tokenSecret, { accountId, epoch: 0 }, 14)}`

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
    config = parseConfig({ DATABASE_URL: url, TOKEN_SECRET: 'x'.repeat(40), COOKIE_SECURE: 'false' })
  }, 240_000)

  afterAll(async () => {
    await prisma?.$disconnect()
    await container?.stop()
  })

  it('publishes machine.update to the account bus on ingest', async () => {
    const bus = createBus()
    const app = createApp({ config, logger: nullLogger, prisma, bus })
    const acc = await newAccount()
    const secret = await mkToken(acc.id)

    const events: SseEvent[] = []
    bus.subscribe(acc.id, (e) => events.push(e))

    const res = await request(app)
      .post('/api/v1/ingest')
      .set('Authorization', `Bearer ${secret}`)
      .send(snapshot('m-sse'))
    expect(res.status).toBe(200)
    expect(events).toContainEqual({ event: 'machine.update', data: { machineId: 'm-sse' } })
  })

  it('does not leak events across accounts', async () => {
    const bus = createBus()
    const app = createApp({ config, logger: nullLogger, prisma, bus })
    const a = await newAccount()
    const b = await newAccount()
    const aSecret = await mkToken(a.id)

    const bEvents: SseEvent[] = []
    bus.subscribe(b.id, (e) => bEvents.push(e))
    await request(app).post('/api/v1/ingest').set('Authorization', `Bearer ${aSecret}`).send(snapshot('a-machine'))
    expect(bEvents).toHaveLength(0) // B never sees A's ingest
  })

  it('/stream requires an owner session (401)', async () => {
    const app = createApp({ config, logger: nullLogger, prisma })
    expect((await request(app).get('/api/v1/stream')).status).toBe(401)
  })

  it('/stream caps concurrent streams per account (429)', async () => {
    const bus = createBus()
    const app = createApp({ config, logger: nullLogger, prisma, bus })
    const acc = await newAccount()
    // Fill the cap with direct subscriptions so the next /stream is rejected without hanging.
    for (let i = 0; i < MAX_SSE_PER_ACCOUNT; i++) bus.subscribe(acc.id, () => {})

    const res = await request(app).get('/api/v1/stream').set('Cookie', cookieFor(acc.id))
    expect(res.status).toBe(429)
    expect(res.body.error.code).toBe('too_many_streams')
    expect(res.headers['retry-after']).toBe('10')
  })
})
