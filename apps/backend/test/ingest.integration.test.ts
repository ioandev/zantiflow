// Ingest endpoint against a REAL MariaDB (testcontainers): token-authed write → latest-only store,
// wire-v4 validation, and the cross-account machine-hijack guard (B7).
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { MariaDbContainer, type StartedMariaDbContainer } from '@testcontainers/mariadb'
import { PrismaClient } from '@prisma/client'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import type { Express } from 'express'
import { parseConfig } from '../src/config'
import { createApp } from '../src/http/app'
import { nullLogger } from '../src/log'
import { generateToken } from '../src/tokens/secret'
import { containerRuntimeUp, socketPath } from './helpers/runtime'

const runtimeUp = await containerRuntimeUp()
if (!runtimeUp) {
  console.warn(`[ingest.integration] no container runtime at ${socketPath} — skipping ingest integration tests`)
}
const suite = runtimeUp ? describe : describe.skip

// A minimal valid wire-v4 snapshot.
const snapshot = (machineId: string, over: Record<string, unknown> = {}) => ({
  version: 4,
  machineId,
  capturedAtTick: 1,
  privacy: { full: true, machine: 'alias', sessionNames: 'send', tabNames: 'send', paneNames: 'hidden' },
  machine: { source: 'alias', name: 'red-laptop' },
  attentions: [],
  sessions: [
    {
      sid: 's1',
      name: 'main',
      isCurrent: true,
      state: 'live',
      diedSecondsAgo: null,
      tabs: [
        {
          tabId: 0,
          name: 'editor',
          position: 0,
          active: true,
          panes: [{ id: 1, name: null, command: null, isFocused: true, exited: false, contentFingerprint: 'ab12' }],
        },
      ],
    },
  ],
  ...over,
})

suite('ingest integration (testcontainers MariaDB)', () => {
  let container: StartedMariaDbContainer
  let prisma: PrismaClient
  let app: Express
  let seq = 0

  const newAccount = () =>
    prisma.account.create({ data: { oauthProvider: 'google', oauthId: `s-${seq++}`, name: 'O' } })
  const mkToken = async (accountId: string, over: Record<string, unknown> = {}): Promise<string> => {
    const t = generateToken()
    await prisma.token.create({ data: { accountId, lookupPrefix: t.lookupPrefix, secretHash: t.secretHash, ...over } })
    return t.secret
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
    const config = parseConfig({ DATABASE_URL: url, TOKEN_SECRET: 'x'.repeat(40) })
    app = createApp({ config, logger: nullLogger, prisma })
  }, 240_000)

  afterAll(async () => {
    await prisma?.$disconnect()
    await container?.stop()
  })

  it('stores a snapshot and auto-registers the machine (scoped to the account)', async () => {
    const acc = await newAccount()
    const secret = await mkToken(acc.id)
    const res = await request(app).post('/api/v1/ingest').set('Authorization', `Bearer ${secret}`).send(snapshot('m-1'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })

    const machine = await prisma.machine.findUnique({ where: { id: 'm-1' } })
    expect(machine).toMatchObject({ accountId: acc.id, displayName: 'red-laptop' })
    const snap = await prisma.snapshot.findFirst({ where: { machineId: 'm-1' } })
    expect(snap).toMatchObject({ accountId: acc.id, version: 4, capturedAtTick: 1, sid: 's1' })

    // token.lastUsedAt is stamped.
    const tok = await prisma.token.findFirst({ where: { accountId: acc.id } })
    expect(tok?.lastUsedAt).not.toBeNull()
  })

  it('drops session.detached but keeps other attentions (ADR-0028)', async () => {
    const acc = await newAccount()
    const secret = await mkToken(acc.id)
    const snap = snapshot('m-detach', {
      attentions: [
        { type: 'session.detached', target: { sessionSid: 's1' }, state: 'active', since: 0 },
        { type: 'claude.needs-input', target: { sessionSid: 's1', tabId: 0, paneId: 1 }, state: 'active', since: 0 },
      ],
    })
    const res = await request(app).post('/api/v1/ingest').set('Authorization', `Bearer ${secret}`).send(snap)
    expect(res.status).toBe(200)
    const rows = await prisma.attention.findMany({ where: { machineId: 'm-detach' } })
    expect(rows.map((r) => r.type)).toEqual(['claude.needs-input'])
  })

  it('rejects ingest without a token (401) and with a revoked token (401)', async () => {
    const acc = await newAccount()
    expect((await request(app).post('/api/v1/ingest').send(snapshot('m-x'))).status).toBe(401)

    const secret = await mkToken(acc.id, { revokedAt: new Date() })
    const res = await request(app).post('/api/v1/ingest').set('Authorization', `Bearer ${secret}`).send(snapshot('m-x'))
    expect(res.status).toBe(401)
  })

  it('rejects an unknown-newer wire version and a malformed body (400)', async () => {
    const acc = await newAccount()
    const secret = await mkToken(acc.id)
    const auth = { Authorization: `Bearer ${secret}` }

    const newer = await request(app)
      .post('/api/v1/ingest')
      .set(auth)
      .send(snapshot('m-2', { version: 5 }))
    expect(newer.status).toBe(400)
    expect(newer.body.error.code).toBe('unknown_wire_version')

    const bad = await request(app)
      .post('/api/v1/ingest')
      .set(auth)
      .send(snapshot('m-2', { machineId: 123 }))
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe('invalid_body')
  })

  it('keeps only the latest snapshot per machine (replace, not append)', async () => {
    const acc = await newAccount()
    const secret = await mkToken(acc.id)
    const auth = { Authorization: `Bearer ${secret}` }
    await request(app)
      .post('/api/v1/ingest')
      .set(auth)
      .send(snapshot('m-3', { capturedAtTick: 1 }))
    await request(app)
      .post('/api/v1/ingest')
      .set(auth)
      .send(snapshot('m-3', { capturedAtTick: 99 }))

    const rows = await prisma.snapshot.findMany({ where: { machineId: 'm-3' } })
    expect(rows).toHaveLength(1)
    expect(rows[0].capturedAtTick).toBe(99)
  })

  it('refuses to let one account hijack another account’s machineId (B7 → 403)', async () => {
    const a = await newAccount()
    const b = await newAccount()
    const aSecret = await mkToken(a.id)
    const bSecret = await mkToken(b.id)

    await request(app).post('/api/v1/ingest').set('Authorization', `Bearer ${aSecret}`).send(snapshot('shared-m'))
    const hijack = await request(app)
      .post('/api/v1/ingest')
      .set('Authorization', `Bearer ${bSecret}`)
      .send(snapshot('shared-m', { capturedAtTick: 777 }))
    expect(hijack.status).toBe(403)
    expect(hijack.body.error.code).toBe('forbidden')

    // A still owns the machine and its snapshot is untouched.
    const machine = await prisma.machine.findUnique({ where: { id: 'shared-m' } })
    expect(machine?.accountId).toBe(a.id)
    const snap = await prisma.snapshot.findFirst({ where: { machineId: 'shared-m' } })
    expect(snap?.capturedAtTick).toBe(1)
  })
})
