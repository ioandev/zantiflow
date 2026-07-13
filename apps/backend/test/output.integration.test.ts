// Pane-output on-demand channel against a REAL MariaDB (testcontainers, ADR-0016): owner registers a
// request → plugin (token plane) polls + delivers → owner reads the scrubbed ANSI lines. Plus the
// three read states and cross-tenant guards (IDOR + machine ownership). A pane is addressed by its
// FULL identity — sessionSid/tabId/paneId — so panes that merely share a numeric id in different
// tabs/sessions never collide (the bug this suite now pins). The captured CONTENT is held only in the
// in-process `PaneOutputStore` (ADR-0032) — never the DB — so the content assertions read the store
// directly; only the request lifecycle lives in MariaDB (`OutputRequest`).
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
import { createAutoRefreshLimiter, FREE_AUTO_REFRESH_SEC } from '../src/output/autoRefresh'
import { createPaneOutputStore, PANE_OUTPUT_RETENTION_SEC, type PaneOutputStore } from '../src/output/store'
import { generateToken } from '../src/tokens/secret'
import { containerRuntimeUp, socketPath } from './helpers/runtime'

const runtimeUp = await containerRuntimeUp()
if (!runtimeUp) {
  console.warn(`[output.integration] no container runtime at ${socketPath} — skipping`)
}
const suite = runtimeUp ? describe : describe.skip

/** Owner-plane pane-output URL — the pane's full sessionSid/tabId/paneId path. */
const outPath = (machineId: string, sid: string, tab: number, pane: number) =>
  `/api/v1/machines/${machineId}/sessions/${sid}/tabs/${tab}/panes/${pane}/output`

suite('pane-output channel (testcontainers MariaDB)', () => {
  let container: StartedMariaDbContainer
  let prisma: PrismaClient
  let app: Express
  let config: Config
  let store: PaneOutputStore
  let seq = 0

  const actor = async () => {
    const acc = await prisma.account.create({ data: { oauthProvider: 'google', oauthId: `a-${seq++}`, name: 'O' } })
    const cookie = `ztf_session=${signSession(config.tokenSecret, { accountId: acc.id, epoch: 0 }, 14)}`
    const t = generateToken()
    await prisma.token.create({ data: { accountId: acc.id, lookupPrefix: t.lookupPrefix, secretHash: t.secretHash } })
    const machine = await prisma.machine.create({ data: { id: `m-${seq++}`, accountId: acc.id } })
    return { accountId: acc.id, cookie, secret: t.secret, machineId: machine.id }
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
    // Share ONE store with the app so the content assertions below can read what the plugin delivered
    // (pane content lives only in memory now — ADR-0032, not the DB).
    store = createPaneOutputStore()
    app = createApp({ config, logger: nullLogger, prisma, outputStore: store })
  }, 240_000)

  afterAll(async () => {
    await prisma?.$disconnect()
    await container?.stop()
  })

  it('runs register → poll → deliver → read, returning the three states', async () => {
    const a = await actor()
    const bearer = { Authorization: `Bearer ${a.secret}` }
    const sid = 'sess1'
    const ref = { machineId: a.machineId, sessionSid: sid, tabId: 0, paneId: 1 }

    // Nothing requested yet → not shared.
    const before = await request(app)
      .get(outPath(a.machineId, sid, 0, 1))
      .set('Cookie', a.cookie)
    expect(before.body).toEqual({ shared: false })

    // Owner registers a request.
    const reg = await request(app)
      .post(`${outPath(a.machineId, sid, 0, 1)}/request`)
      .set('Cookie', a.cookie)
    expect(reg.status).toBe(202)

    // Now pending.
    const pending = await request(app)
      .get(outPath(a.machineId, sid, 0, 1))
      .set('Cookie', a.cookie)
    expect(pending.body).toEqual({ pending: true })

    // Plugin (token plane) polls the control channel and sees it, with the FULL identity (ADR-0026).
    const poll = await request(app).post('/api/v1/control').set(bearer).send({ machineId: a.machineId, liveSids: [] })
    expect(poll.status).toBe(200)
    expect(poll.body.pendingOutput).toContainEqual(ref)

    // Plugin delivers scrubbed ANSI lines, echoing the pane identity.
    const capturedAt = new Date().toISOString()
    const lines = ['[31mError:[0m «redacted»', 'done']
    const submit = await request(app)
      .post('/api/v1/output')
      .set(bearer)
      .send({ ...ref, lines, capturedAt })
    expect(submit.status).toBe(204)

    // Owner reads the output.
    const read = await request(app)
      .get(outPath(a.machineId, sid, 0, 1))
      .set('Cookie', a.cookie)
    expect(read.body.lines).toEqual(lines)
    expect(read.body.capturedAt).toBe(capturedAt)

    // The request is fulfilled → no longer pending for the plugin.
    const poll2 = await request(app).post('/api/v1/control').set(bearer).send({ machineId: a.machineId, liveSids: [] })
    expect(poll2.body.pendingOutput).not.toContainEqual(ref)
  })

  it('never serves a previous capture on re-open — fresh-on-open (ADR-0030)', async () => {
    const a = await actor()
    const bearer = { Authorization: `Bearer ${a.secret}` }
    const sid = 'fresh1'
    const ref = { machineId: a.machineId, sessionSid: sid, tabId: 0, paneId: 9 }
    const read = () =>
      request(app)
        .get(outPath(a.machineId, sid, 0, 9))
        .set('Cookie', a.cookie)

    // First open: request → deliver → read shows the capture.
    await request(app)
      .post(`${outPath(a.machineId, sid, 0, 9)}/request`)
      .set('Cookie', a.cookie)
    await request(app)
      .post('/api/v1/output')
      .set(bearer)
      .send({ ...ref, lines: ['OLD output'], capturedAt: new Date().toISOString() })
    expect((await read()).body.lines).toEqual(['OLD output'])

    // Re-open the SAME pane: registering must drop the old capture and report `pending` — the stale
    // "OLD output" must NOT be shown, and its held capture must be gone until a fresh one lands.
    await request(app)
      .post(`${outPath(a.machineId, sid, 0, 9)}/request`)
      .set('Cookie', a.cookie)
    expect((await read()).body).toEqual({ pending: true })
    expect(store.get(a.accountId, a.machineId, `${sid}:0:9`)).toBeUndefined()

    // A fresh delivery for the new request cycle is what the owner finally sees.
    await request(app)
      .post('/api/v1/output')
      .set(bearer)
      .send({ ...ref, lines: ['NEW output'], capturedAt: new Date().toISOString() })
    expect((await read()).body.lines).toEqual(['NEW output'])
  })

  it('does not fall back to a stale capture when a fresh request goes unfulfilled (ADR-0030)', async () => {
    const a = await actor()
    const bearer = { Authorization: `Bearer ${a.secret}` }
    const sid = 'fresh2'
    const ref = { machineId: a.machineId, sessionSid: sid, tabId: 0, paneId: 4 }
    const read = () =>
      request(app)
        .get(outPath(a.machineId, sid, 0, 4))
        .set('Cookie', a.cookie)

    await request(app)
      .post(`${outPath(a.machineId, sid, 0, 4)}/request`)
      .set('Cookie', a.cookie)
    await request(app)
      .post('/api/v1/output')
      .set(bearer)
      .send({ ...ref, lines: ['stale'], capturedAt: new Date().toISOString() })
    expect((await read()).body.lines).toEqual(['stale'])

    // Re-open, but the plugin never delivers (pane_output off / plugin gone). The read is `pending`
    // and, crucially, never regresses to the old "stale" capture — it was dropped on re-request.
    await request(app)
      .post(`${outPath(a.machineId, sid, 0, 4)}/request`)
      .set('Cookie', a.cookie)
    expect((await read()).body).toEqual({ pending: true })
  })

  it('prunes captured output past the ephemeral retention window (ADR-0030/0032)', async () => {
    const a = await actor()
    const bearer = { Authorization: `Bearer ${a.secret}` }
    const sid = 'eph1'
    const paneKey = `${sid}:0:5`
    const ref = { machineId: a.machineId, sessionSid: sid, tabId: 0, paneId: 5 }
    await request(app)
      .post(`${outPath(a.machineId, sid, 0, 5)}/request`)
      .set('Cookie', a.cookie)
    await request(app)
      .post('/api/v1/output')
      .set(bearer)
      .send({ ...ref, lines: ['ephemeral'], capturedAt: new Date().toISOString() })
    expect(store.get(a.accountId, a.machineId, paneKey)).toBeDefined()

    // A sweep whose clock is past the retention window drops the held capture — content doesn't linger.
    store.prune(new Date(Date.now() + (PANE_OUTPUT_RETENTION_SEC + 10) * 1000))
    expect(store.get(a.accountId, a.machineId, paneKey)).toBeUndefined()
    // A fresh capture (within the window) is retained by the same sweep.
    await request(app)
      .post(`${outPath(a.machineId, sid, 0, 5)}/request`)
      .set('Cookie', a.cookie)
    await request(app)
      .post('/api/v1/output')
      .set(bearer)
      .send({ ...ref, lines: ['kept'], capturedAt: new Date().toISOString() })
    store.prune(new Date())
    expect(store.get(a.accountId, a.machineId, paneKey)?.lines).toEqual(['kept'])
  })

  it('keeps panes that share a numeric id in different sessions/tabs from colliding', async () => {
    const a = await actor()
    const bearer = { Authorization: `Bearer ${a.secret}` }
    // Two DIFFERENT panes that both happen to be paneId 0 — one in session A tab 0, one in session B
    // tab 1. Before the fix these shared the key "0" and overwrote each other's output.
    const paneA = { machineId: a.machineId, sessionSid: 'sA', tabId: 0, paneId: 0 }
    const paneB = { machineId: a.machineId, sessionSid: 'sB', tabId: 1, paneId: 0 }

    await request(app)
      .post(`${outPath(a.machineId, 'sA', 0, 0)}/request`)
      .set('Cookie', a.cookie)
    await request(app)
      .post(`${outPath(a.machineId, 'sB', 1, 0)}/request`)
      .set('Cookie', a.cookie)

    const capturedAt = new Date().toISOString()
    await request(app)
      .post('/api/v1/output')
      .set(bearer)
      .send({ ...paneA, lines: ['from session A'], capturedAt })
    await request(app)
      .post('/api/v1/output')
      .set(bearer)
      .send({ ...paneB, lines: ['from session B'], capturedAt })

    // Each pane reads back its OWN output — no bleed across the shared numeric id.
    const readA = await request(app)
      .get(outPath(a.machineId, 'sA', 0, 0))
      .set('Cookie', a.cookie)
    const readB = await request(app)
      .get(outPath(a.machineId, 'sB', 1, 0))
      .set('Cookie', a.cookie)
    expect(readA.body.lines).toEqual(['from session A'])
    expect(readB.body.lines).toEqual(['from session B'])

    // Two distinct captures held under the composite key, not one that overwrote the other.
    expect(store.get(a.accountId, a.machineId, 'sA:0:0')?.lines).toEqual(['from session A'])
    expect(store.get(a.accountId, a.machineId, 'sB:1:0')?.lines).toEqual(['from session B'])
  })

  it('re-registering keeps a single pending row and dedupes the plugin poll', async () => {
    const a = await actor()
    const bearer = { Authorization: `Bearer ${a.secret}` }
    const sid = 'sess2'

    // Open the same pane's drawer several times (e.g. React StrictMode double-fires, or the user
    // re-opens it) — the pending set must not grow, and the poll must list the pane once.
    for (let i = 0; i < 4; i++) {
      const reg = await request(app)
        .post(`${outPath(a.machineId, sid, 0, 2)}/request`)
        .set('Cookie', a.cookie)
      expect(reg.status).toBe(202)
    }
    const rows = await prisma.outputRequest.count({ where: { machineId: a.machineId, paneKey: `${sid}:0:2` } })
    expect(rows).toBe(1)

    const poll = await request(app).post('/api/v1/control').set(bearer).send({ machineId: a.machineId, liveSids: [] })
    const forPane2 = poll.body.pendingOutput.filter(
      (r: { machineId: string; paneId: number }) => r.machineId === a.machineId && r.paneId === 2,
    )
    expect(forPane2).toHaveLength(1)
  })

  it('handles concurrent deliveries for the same pane without a 500', async () => {
    const a = await actor()
    const bearer = { Authorization: `Bearer ${a.secret}` }
    const sid = 'sess3'
    const ref = { machineId: a.machineId, sessionSid: sid, tabId: 0, paneId: 3 }
    await request(app)
      .post(`${outPath(a.machineId, sid, 0, 3)}/request`)
      .set('Cookie', a.cookie)

    // Fire several deliveries for the SAME pane at once — a Map put is last-write-wins, so concurrent
    // deliveries just leave one capture (no unique-constraint race to 500 on any more).
    const capturedAt = new Date().toISOString()
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        request(app)
          .post('/api/v1/output')
          .set(bearer)
          .send({ ...ref, lines: [`delivery ${i}`], capturedAt }),
      ),
    )
    for (const r of results) expect(r.status).toBe(204)

    // A single capture held for the pane (Map semantics), and the owner can read it.
    expect(store.get(a.accountId, a.machineId, `${sid}:0:3`)?.lines).toHaveLength(1)
    const read = await request(app)
      .get(outPath(a.machineId, sid, 0, 3))
      .set('Cookie', a.cookie)
    expect(read.status).toBe(200)
    expect(read.body.lines).toHaveLength(1)
    expect(read.body.lines[0]).toMatch(/^delivery \d$/)
  })

  it('enforces the FREE auto-refresh window server-side; PRO is unbounded (ADR-0016)', async () => {
    // A controllable clock drives the limiter so the 60s window is crossed without waiting real time.
    // (`effectiveTier` still reads real time, so PRO just needs a future `tierExpiresAt`.)
    let clock = 10_000_000
    const gated = createApp({
      config,
      logger: nullLogger,
      prisma,
      autoRefresh: createAutoRefreshLimiter({ now: () => clock }),
    })
    const reqUrl = (base: string, mode: string) => `${base}/request?mode=${mode}`

    // --- FREE account: a human `start` opens the window; `auto` ticks are allowed until it is spent. ---
    const free = await actor()
    const freeBase = outPath(free.machineId, 'ar', 0, 1)
    const s = await request(gated).post(reqUrl(freeBase, 'start')).set('Cookie', free.cookie)
    expect(s.status).toBe(202)
    expect(s.body).toEqual({ autoRefresh: true })

    clock += (FREE_AUTO_REFRESH_SEC - 5) * 1000 // still inside the window
    const within = await request(gated).post(reqUrl(freeBase, 'auto')).set('Cookie', free.cookie)
    expect(within.body).toEqual({ autoRefresh: true })

    clock += 10 * 1000 // now past the window
    const spent = await request(gated).post(reqUrl(freeBase, 'auto')).set('Cookie', free.cookie)
    expect(spent.body).toEqual({ autoRefresh: false })

    // A human resume (`start`) opens a fresh window → `auto` is allowed again.
    await request(gated).post(reqUrl(freeBase, 'start')).set('Cookie', free.cookie)
    const resumed = await request(gated).post(reqUrl(freeBase, 'auto')).set('Cookie', free.cookie)
    expect(resumed.body).toEqual({ autoRefresh: true })

    // --- PRO account: `auto` is never refused, even long past the FREE window. ---
    const proAcc = await prisma.account.create({
      data: {
        oauthProvider: 'google',
        oauthId: `pro-${seq++}`,
        name: 'P',
        tier: 'pro',
        tierExpiresAt: new Date(Date.now() + 3_600_000),
      },
    })
    const proCookie = `ztf_session=${signSession(config.tokenSecret, { accountId: proAcc.id, epoch: 0 }, 14)}`
    const proMachine = await prisma.machine.create({ data: { id: `m-${seq++}`, accountId: proAcc.id } })
    const proBase = outPath(proMachine.id, 'ar', 0, 1)
    await request(gated).post(reqUrl(proBase, 'start')).set('Cookie', proCookie)
    clock += (FREE_AUTO_REFRESH_SEC + 300) * 1000
    const proTick = await request(gated).post(reqUrl(proBase, 'auto')).set('Cookie', proCookie)
    expect(proTick.body).toEqual({ autoRefresh: true })
  })

  it('blocks cross-tenant register/read (IDOR) and cross-account delivery', async () => {
    const a = await actor()
    const b = await actor()
    const sid = 'sess1'

    // B cannot register a request against A's machine.
    const reg = await request(app)
      .post(`${outPath(a.machineId, sid, 0, 1)}/request`)
      .set('Cookie', b.cookie)
    expect(reg.status).toBe(404)

    // B reading A's pane sees nothing (scoped by accountId).
    const read = await request(app)
      .get(outPath(a.machineId, sid, 0, 1))
      .set('Cookie', b.cookie)
    expect(read.body).toEqual({ shared: false })

    // B's token cannot deliver output for A's machine.
    const submit = await request(app)
      .post('/api/v1/output')
      .set('Authorization', `Bearer ${b.secret}`)
      .send({
        machineId: a.machineId,
        sessionSid: sid,
        tabId: 0,
        paneId: 1,
        lines: ['x'],
        capturedAt: new Date().toISOString(),
      })
    expect(submit.status).toBe(403)
  })

  it('requires auth on both planes', async () => {
    const a = await actor()
    expect((await request(app).get(outPath(a.machineId, 'sess1', 0, 1))).status).toBe(401) // no session
    expect((await request(app).post('/api/v1/output').send({})).status).toBe(401) // no token (delivery plane)
  })
})
