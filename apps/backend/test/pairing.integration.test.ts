// Device-pairing flow against a REAL MariaDB (testcontainers): start → poll(pending) → owner
// approve → poll(approved→token, once) → the token authenticates ingest → poll(consumed). Plus the
// guards: approve needs a session, a wrong code 404s, brute-force is capped, unknown session 404s.
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { MariaDbContainer, type StartedMariaDbContainer } from '@testcontainers/mariadb'
import { PrismaClient } from '@prisma/client'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import type { Express } from 'express'
import { signSession } from '../src/auth/tokens'
import { parseConfig, type Config } from '../src/config'
import { createApp } from '../src/http/app'
import { nullLogger } from '../src/log'
import { authenticateIngest } from '../src/tokens/service'
import { containerRuntimeUp, socketPath } from './helpers/runtime'

const runtimeUp = await containerRuntimeUp()
if (!runtimeUp) {
  console.warn(`[pairing.integration] no container runtime at ${socketPath} — skipping pairing tests`)
}
const suite = runtimeUp ? describe : describe.skip

suite('pairing integration (testcontainers MariaDB)', () => {
  let container: StartedMariaDbContainer
  let prisma: PrismaClient
  let app: Express
  let config: Config
  let seq = 0

  const newOwner = async () => {
    const acc = await prisma.account.create({ data: { oauthProvider: 'google', oauthId: `o-${seq++}`, name: 'Owner' } })
    return { id: acc.id, cookie: `ztf_session=${signSession(config.tokenSecret, { accountId: acc.id, epoch: 0 }, 14)}` }
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
    config = parseConfig({ DATABASE_URL: url, TOKEN_SECRET: 'x'.repeat(40), COOKIE_SECURE: 'false' })
    app = createApp({ config, logger: nullLogger, prisma })
  }, 240_000)

  afterAll(async () => {
    await prisma?.$disconnect()
    await container?.stop()
  })

  it('runs the full pair → approve → poll(token) → ingest flow, delivering the token once', async () => {
    const owner = await newOwner()

    const start = await request(app).post('/api/v1/pair/start').send({ machineHint: 'laptop' })
    expect(start.status).toBe(201)
    const { sessionId, userCode, interval } = start.body
    expect(userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    expect(interval).toBe(5)

    // Before approval, polling is pending.
    const pending = await request(app).post('/api/v1/pair/poll').send({ sessionId })
    expect(pending.body.status).toBe('authorization_pending')

    // Owner approves the code.
    const approve = await request(app).post('/api/v1/pair/approve').set('Cookie', owner.cookie).send({ userCode })
    expect(approve.status).toBe(204)

    // Next poll delivers the token exactly once.
    const approved = await request(app).post('/api/v1/pair/poll').send({ sessionId })
    expect(approved.body.status).toBe('approved')
    expect(approved.body.token).toMatch(/^ztf_/)

    // The delivered token authenticates ingest for the owner's account.
    const principal = await authenticateIngest(prisma, `Bearer ${approved.body.token}`)
    expect(principal?.accountId).toBe(owner.id)

    // A second poll no longer returns the token (consumed).
    const again = await request(app).post('/api/v1/pair/poll').send({ sessionId })
    expect(again.body.status).toBe('consumed')
    expect(again.body.token).toBeUndefined()
  })

  it('requires an owner session to approve (401)', async () => {
    const start = await request(app).post('/api/v1/pair/start').send({})
    const res = await request(app).post('/api/v1/pair/approve').send({ userCode: start.body.userCode })
    expect(res.status).toBe(401)
  })

  it('404s an unknown code on approve and an unknown session on poll', async () => {
    const owner = await newOwner()
    const badCode = await request(app)
      .post('/api/v1/pair/approve')
      .set('Cookie', owner.cookie)
      .send({ userCode: 'ZZZZ-ZZZZ' })
    expect(badCode.status).toBe(404)
    expect(badCode.body.error.code).toBe('invalid_code')

    const badSession = await request(app).post('/api/v1/pair/poll').send({ sessionId: 'nonexistent-session-id-value' })
    expect(badSession.status).toBe(404)
  })

  it('rate-limits code-entry brute force (429 after 5 tries)', async () => {
    const owner = await newOwner()
    const statuses: number[] = []
    for (let i = 0; i < 7; i++) {
      const r = await request(app)
        .post('/api/v1/pair/approve')
        .set('Cookie', owner.cookie)
        .send({ userCode: 'AAAA-BBBB' })
      statuses.push(r.status)
    }
    // First 5 attempts reach the handler (404 invalid_code); further attempts are throttled (429).
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0)
    expect(statuses.slice(0, 5).every((s) => s === 404)).toBe(true)
  })
})
