// The always-on control channel (ADR-0026) against a REAL MariaDB (testcontainers). Proves the
// liveness TOUCH (a quiet-but-live session stays fresh under the read-filter while a closed one ages
// out), machine-scoped pending output, viewer presence + refresh-sequence, and both auth guards
// (IDOR/hijack on the token plane, IDOR + rate-limit on the owner refresh button).
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { MariaDbContainer, type StartedMariaDbContainer } from '@testcontainers/mariadb'
import { PrismaClient } from '@prisma/client'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import type { Express } from 'express'
import { signSession } from '../src/auth/tokens'
import { parseConfig, type Config } from '../src/config'
import { createControlWaiters, type ControlWaiters } from '../src/control/waiters'
import { createApp } from '../src/http/app'
import { nullLogger } from '../src/log'
import { generateToken } from '../src/tokens/secret'
import { containerRuntimeUp, socketPath } from './helpers/runtime'

// Wrap the real waiters so a long-poll test can await the exact moment ITS control poll parks, then
// signal — removing the compute→park race entirely (a signal is only "lost" if it fires before the
// poll is parked; here we guarantee it fires after). Tracking is keyed by machineId (each test uses a
// unique one) so a slow poll in one test can't have its `waitForPark` satisfied by another test's
// park. `signal` still delegates to the real registry, so the actual wake path is exercised.
const makeObservableWaiters = (): { waiters: ControlWaiters; waitForPark: (machineId: string) => Promise<void> } => {
  const inner = createControlWaiters()
  const parked = new Set<string>() // machineIds with a poll currently parked
  const awaiting = new Map<string, Array<() => void>>() // machineId → resolvers waiting for its park
  return {
    waiters: {
      wait(machineId, timeoutMs) {
        parked.add(machineId)
        const fns = awaiting.get(machineId)
        if (fns) {
          awaiting.delete(machineId)
          fns.forEach((fn) => fn())
        }
        return inner.wait(machineId, timeoutMs).finally(() => parked.delete(machineId))
      },
      signal(machineId) {
        inner.signal(machineId)
      },
    },
    waitForPark(machineId) {
      if (parked.has(machineId)) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const arr = awaiting.get(machineId) ?? []
        arr.push(resolve)
        awaiting.set(machineId, arr)
      })
    },
  }
}

const runtimeUp = await containerRuntimeUp()
if (!runtimeUp) {
  console.warn(`[control.integration] no container runtime at ${socketPath} — skipping`)
}
const suite = runtimeUp ? describe : describe.skip

suite('control channel (testcontainers MariaDB)', () => {
  let container: StartedMariaDbContainer
  let prisma: PrismaClient
  let app: Express
  let config: Config
  let obs: ReturnType<typeof makeObservableWaiters>
  let seq = 0

  const actor = async () => {
    const acc = await prisma.account.create({ data: { oauthProvider: 'google', oauthId: `a-${seq++}`, name: 'O' } })
    const cookie = `ztf_session=${signSession(config.tokenSecret, { accountId: acc.id, epoch: 0 }, 14)}`
    const t = generateToken()
    await prisma.token.create({ data: { accountId: acc.id, lookupPrefix: t.lookupPrefix, secretHash: t.secretHash } })
    return { accountId: acc.id, cookie, secret: t.secret }
  }

  const seedMachine = async (accountId: string, lastSeenAt: Date): Promise<string> => {
    const id = `m-${seq++}`
    await prisma.machine.create({ data: { id, accountId, lastSeenAt, firstSeenAt: lastSeenAt } })
    return id
  }

  const seedSlice = (machineId: string, accountId: string, sid: string, receivedAt: Date) =>
    prisma.snapshot.create({
      data: {
        machineId,
        sid,
        accountId,
        version: 4,
        capturedAtTick: 1,
        data: { sessions: [{ sid, tabs: [] }] },
        receivedAt,
      },
    })

  const control = (secret: string, machineId: string, liveSids: string[], waitMs?: number) =>
    request(app)
      .post('/api/v1/control')
      .set('Authorization', `Bearer ${secret}`)
      .send({ machineId, liveSids, ...(waitMs === undefined ? {} : { waitMs }) })

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
    obs = makeObservableWaiters()
    app = createApp({ config, logger: nullLogger, prisma, waiters: obs.waiters })
  }, 240_000)

  afterAll(async () => {
    await prisma?.$disconnect()
    await container?.stop()
  })

  it('touches lastSeenAt + the reported sessions, leaving a closed session to age out', async () => {
    const a = await actor()
    const old = new Date(Date.now() - 2 * 60 * 60_000) // 2 h ago
    const machineId = await seedMachine(a.accountId, old)
    await seedSlice(machineId, a.accountId, 'live', old)
    await seedSlice(machineId, a.accountId, 'gone', old)
    // A pane-activity row for the live session so the @updatedAt touch runs against a real row.
    await prisma.paneActivity.create({ data: { machineId, sid: 'live', accountId: a.accountId, activity: {} } })

    const res = await control(a.secret, machineId, ['live'])
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ pendingOutput: [], viewers: { active: false }, refreshSeq: 0, heartbeatSec: 300 })

    const machine = await prisma.machine.findUnique({ where: { id: machineId } })
    expect(machine!.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000) // freshly stamped

    const live = await prisma.snapshot.findUnique({ where: { machineId_sid: { machineId, sid: 'live' } } })
    const gone = await prisma.snapshot.findUnique({ where: { machineId_sid: { machineId, sid: 'gone' } } })
    expect(live!.receivedAt.getTime()).toBeGreaterThan(Date.now() - 60_000) // touched → stays visible
    expect(gone!.receivedAt.getTime()).toBeLessThan(Date.now() - 60 * 60_000) // untouched → ~2 h old → ages out
  })

  it('returns only this machine’s pending output requests', async () => {
    const a = await actor()
    const now = new Date()
    const m1 = await seedMachine(a.accountId, now)
    const m2 = await seedMachine(a.accountId, now)
    // Stored keys are the full pane identity `sessionSid:tabId:paneId` (see output/service).
    await prisma.outputRequest.create({
      data: { accountId: a.accountId, machineId: m1, paneKey: 'sA:0:5', status: 'pending' },
    })
    await prisma.outputRequest.create({
      data: { accountId: a.accountId, machineId: m2, paneKey: 'sB:1:7', status: 'pending' },
    })

    const res = await control(a.secret, m1, [])
    expect(res.status).toBe(200)
    expect(res.body.pendingOutput).toEqual([{ machineId: m1, sessionSid: 'sA', tabId: 0, paneId: 5 }])
  })

  it('prices the heartbeat interval by tier — 300 s free, 30 s pro (ADR-0051)', async () => {
    const a = await actor()
    const machineId = await seedMachine(a.accountId, new Date())
    expect((await control(a.secret, machineId, [])).body.heartbeatSec).toBe(300)
    // effectiveTier is pro while tierExpiresAt is in the future — the next poll reprices itself.
    await prisma.account.update({
      where: { id: a.accountId },
      data: { tier: 'pro', tierExpiresAt: new Date(Date.now() + 86_400_000) },
    })
    expect((await control(a.secret, machineId, [])).body.heartbeatSec).toBe(30)
  })

  it('reflects viewer presence (a dashboard read) and the refresh button bumps refreshSeq', async () => {
    const a = await actor()
    const machineId = await seedMachine(a.accountId, new Date())

    const before = await control(a.secret, machineId, [])
    expect(before.body.viewers.active).toBe(false)
    expect(before.body.refreshSeq).toBe(0)

    // A dashboard read marks the viewer (covers the SSE-less polling fallback).
    await request(app).get('/api/v1/machines').set('Cookie', a.cookie)
    expect((await control(a.secret, machineId, [])).body.viewers.active).toBe(true)

    // The refresh button bumps the machine's refresh sequence.
    const refresh = await request(app).post(`/api/v1/machines/${machineId}/refresh`).set('Cookie', a.cookie)
    expect(refresh.status).toBe(202)
    expect((await control(a.secret, machineId, [])).body.refreshSeq).toBe(1)
  })

  it('blocks a token control-polling another account’s machine (IDOR → 403)', async () => {
    const a = await actor()
    const b = await actor()
    const machineId = await seedMachine(a.accountId, new Date())
    expect((await control(b.secret, machineId, [])).status).toBe(403)
  })

  it('rate-limits the refresh button (≥5 s) and 404s a non-owned machine', async () => {
    const a = await actor()
    const b = await actor()
    const machineId = await seedMachine(a.accountId, new Date())

    expect((await request(app).post(`/api/v1/machines/${machineId}/refresh`).set('Cookie', a.cookie)).status).toBe(202)
    // Second refresh within 5 s → rate-limited.
    expect((await request(app).post(`/api/v1/machines/${machineId}/refresh`).set('Cookie', a.cookie)).status).toBe(429)
    // B (fresh bucket for B+machine) passes the limiter but doesn't own it → 404.
    expect((await request(app).post(`/api/v1/machines/${machineId}/refresh`).set('Cookie', b.cookie)).status).toBe(404)
  })

  it('requires a token on the control plane and rejects an invalid body', async () => {
    const a = await actor()
    const machineId = await seedMachine(a.accountId, new Date())
    expect((await request(app).post('/api/v1/control').send({ machineId, liveSids: [] })).status).toBe(401)
    const bad = await request(app).post('/api/v1/control').set('Authorization', `Bearer ${a.secret}`).send({ nope: 1 })
    expect(bad.status).toBe(400)
  })

  // --- Long-poll (ADR-0029): opt-in `waitMs` holds the response until a view-request/refresh wakes it. ---

  it('long-poll does NOT hold when output is already pending (returns it immediately)', async () => {
    const a = await actor()
    const machineId = await seedMachine(a.accountId, new Date())
    await prisma.outputRequest.create({
      data: { accountId: a.accountId, machineId, paneKey: 'sX:0:5', status: 'pending' },
    })
    const started = Date.now()
    const res = await control(a.secret, machineId, [], 5000)
    expect(res.status).toBe(200)
    expect(res.body.pendingOutput).toEqual([{ machineId, sessionSid: 'sX', tabId: 0, paneId: 5 }])
    expect(Date.now() - started).toBeLessThan(2000) // never parked — there was work waiting
  })

  it('long-poll holds, then a website view-request wakes it with the pending pane', async () => {
    const a = await actor()
    const machineId = await seedMachine(a.accountId, new Date())

    const started = Date.now()
    // `.then()` forces superagent to actually DISPATCH the request now (it otherwise defers sending
    // until awaited) — so the poll reaches the backend and parks while we set up the wake below.
    const held = control(a.secret, machineId, [], 8000).then((r) => r) // long-poll; nothing pending yet → parks
    await obs.waitForPark(machineId) // deterministically wait until THIS machine's poll is parked

    // The website asks to view a pane → registerRequest → signals the parked poll.
    const req = await request(app)
      .post(`/api/v1/machines/${machineId}/sessions/sX/tabs/0/panes/5/output/request`)
      .set('Cookie', a.cookie)
    expect(req.status).toBe(202)

    const res = await held
    expect(res.status).toBe(200)
    expect(res.body.pendingOutput).toEqual([{ machineId, sessionSid: 'sX', tabId: 0, paneId: 5 }])
    expect(Date.now() - started).toBeLessThan(8000) // woke on the signal, not the 8 s timeout
  })

  it('long-poll holds, then the refresh button wakes it with a bumped refreshSeq', async () => {
    const a = await actor()
    const machineId = await seedMachine(a.accountId, new Date())

    const started = Date.now()
    const held = control(a.secret, machineId, [], 8000).then((r) => r) // force dispatch (see view test)
    await obs.waitForPark(machineId)

    const refresh = await request(app).post(`/api/v1/machines/${machineId}/refresh`).set('Cookie', a.cookie)
    expect(refresh.status).toBe(202)

    const res = await held
    expect(res.status).toBe(200)
    expect(res.body.refreshSeq).toBe(1)
    expect(Date.now() - started).toBeLessThan(8000)
  })

  it('long-poll returns (empty) on timeout when nothing happens', async () => {
    const a = await actor()
    const machineId = await seedMachine(a.accountId, new Date())
    const started = Date.now()
    const res = await control(a.secret, machineId, [], 400) // short hold, no signal → times out
    expect(res.status).toBe(200)
    expect(res.body.pendingOutput).toEqual([])
    expect(Date.now() - started).toBeGreaterThanOrEqual(350) // actually held, not immediate
  })
})
