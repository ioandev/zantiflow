// Read API against a REAL MariaDB (testcontainers): the owner reads their own ingested machines +
// snapshot; cross-tenant reads/forgets are blocked (IDOR); forget removes the data. Closes the
// Phase-2 loop (ingest → store → tenant-scoped read).
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
import { generateToken } from '../src/tokens/secret'
import { containerRuntimeUp, socketPath } from './helpers/runtime'

const runtimeUp = await containerRuntimeUp()
if (!runtimeUp) {
  console.warn(`[machines.integration] no container runtime at ${socketPath} — skipping read-API tests`)
}
const suite = runtimeUp ? describe : describe.skip

// A minimal but realistic snapshot: one live session (a real plugin instance always reports its own
// current session, so a 0-session snapshot never occurs on the wire).
const snapshot = (machineId: string) => ({
  version: 4,
  machineId,
  capturedAtTick: 7,
  privacy: { full: true, machine: 'alias', sessionNames: 'send', tabNames: 'send', paneNames: 'hidden' },
  machine: { source: 'alias', name: 'box' },
  attentions: [],
  sessions: [
    {
      sid: 's0',
      name: 'main',
      isCurrent: true,
      state: 'live',
      diedSecondsAgo: null,
      tabs: [
        {
          tabId: 0,
          name: 't',
          position: 0,
          active: true,
          panes: [{ id: 1, name: null, command: null, isFocused: true, exited: false, contentFingerprint: 'aa' }],
        },
      ],
    },
  ],
})

// A snapshot with a real sessions→tabs→panes tree, one pane whose fingerprint we can vary, and an
// optional attention — exercises counts, privacy level, and per-pane activity derivation.
const tree = (machineId: string, fp: string, attentions: unknown[] = []) => ({
  version: 4,
  machineId,
  capturedAtTick: 7,
  privacy: { full: true, machine: 'real', sessionNames: 'send', tabNames: 'send', paneNames: 'send' },
  machine: { source: 'real', name: 'host' },
  attentions,
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
          panes: [{ id: 7, name: 'nvim', command: 'nvim', isFocused: true, exited: false, contentFingerprint: fp }],
        },
      ],
    },
  ],
})

suite('read API integration (testcontainers MariaDB)', () => {
  let container: StartedMariaDbContainer
  let prisma: PrismaClient
  let app: Express
  let config: Config
  let seq = 0

  // A fresh account with both an owner-session cookie and an ingest token.
  const newActor = async () => {
    const acc = await prisma.account.create({ data: { oauthProvider: 'google', oauthId: `s-${seq++}`, name: 'O' } })
    const cookie = `ztf_session=${signSession(config.tokenSecret, { accountId: acc.id, epoch: acc.sessionEpoch }, 14)}`
    const t = generateToken()
    const token = await prisma.token.create({
      data: { accountId: acc.id, lookupPrefix: t.lookupPrefix, secretHash: t.secretHash },
    })
    return { id: acc.id, cookie, secret: t.secret, tokenId: token.id }
  }
  const ingest = (secret: string, machineId: string) =>
    request(app).post('/api/v1/ingest').set('Authorization', `Bearer ${secret}`).send(snapshot(machineId))
  const ingestBody = (secret: string, body: unknown) =>
    request(app).post('/api/v1/ingest').set('Authorization', `Bearer ${secret}`).send(body)

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

  it('requires an owner session (401 without one)', async () => {
    expect((await request(app).get('/api/v1/machines')).status).toBe(401)
    expect((await request(app).get('/api/v1/attentions')).status).toBe(401)
  })

  it('lets the owner list and read their own machine + snapshot', async () => {
    const a = await newActor()
    await ingest(a.secret, 'read-1')

    const list = await request(app).get('/api/v1/machines').set('Cookie', a.cookie)
    expect(list.status).toBe(200)
    expect(list.body.machines.map((m: { id: string }) => m.id)).toContain('read-1')
    expect(list.headers['cache-control']).toBe('no-store')

    const detail = await request(app).get('/api/v1/machines/read-1').set('Cookie', a.cookie)
    expect(detail.status).toBe(200)
    expect(detail.body).toMatchObject({ id: 'read-1', displayName: 'box', capturedAtTick: 7 })
    expect(detail.body.snapshot.machineId).toBe('read-1')
  })

  it('enriches the machine list with live/stale, counts, privacy level and attention count (ADR-0008 §2)', async () => {
    const a = await newActor()
    await ingestBody(
      a.secret,
      tree('rich-1', 'fp1', [
        { type: 'claude.needs-input', target: { sessionSid: 's1', tabId: 0, paneId: 7 }, state: 'active', since: 0 },
        // A thinking attention must NOT inflate "needs attention" — it's counted separately (ADR-0025).
        { type: 'claude.thinking', target: { sessionSid: 's1', tabId: 0, paneId: 8 }, state: 'active', since: 0 },
      ]),
    )
    const list = await request(app).get('/api/v1/machines').set('Cookie', a.cookie)
    const m = list.body.machines.find((x: { id: string }) => x.id === 'rich-1')
    expect(m.online).toBe(true) // just ingested → within the stale window
    expect(m.counts).toEqual({ sessions: 1, tabs: 1, panes: 1 })
    expect(m.privacy).toEqual({ source: 'real', level: 'full' })
    expect(m.attentionCount).toBe(1) // needs-input only; thinking excluded
    expect(m.thinkingCount).toBe(1)

    // The detail endpoint splits the same way.
    const detail = await request(app).get('/api/v1/machines/rich-1').set('Cookie', a.cookie)
    expect(detail.body.attentionCount).toBe(1)
    expect(detail.body.thinkingCount).toBe(1)
  })

  it('reports privacy: restricted when any name category is redacted', async () => {
    const a = await newActor()
    await ingest(a.secret, 'restricted-1') // snapshot() has paneNames: 'hidden'
    const list = await request(app).get('/api/v1/machines').set('Cookie', a.cookie)
    const m = list.body.machines.find((x: { id: string }) => x.id === 'restricted-1')
    expect(m.privacy).toEqual({ source: 'alias', level: 'restricted' })
  })

  it('derives per-pane activity across ingests: Unknown first, then a backend timestamp on change', async () => {
    const a = await newActor()
    await ingestBody(a.secret, tree('act-1', 'fp1'))
    let d = await request(app).get('/api/v1/machines/act-1').set('Cookie', a.cookie)
    expect(d.body.activity).toEqual({}) // first observation → no change seen → Unknown

    await ingestBody(a.secret, tree('act-1', 'fp2'))
    d = await request(app).get('/api/v1/machines/act-1').set('Cookie', a.cookie)
    expect(typeof d.body.activity['s1:0:7']).toBe('string') // fingerprint changed → stamped
    expect(d.body.online).toBe(true)
  })

  it('unions sessions reported separately by per-session plugin instances (no clobber)', async () => {
    const a = await newActor()
    // Two Zellij sessions on ONE machine, each reported by its own plugin instance under a distinct
    // sid (load_plugins-per-session). They must not overwrite each other — the machine shows BOTH.
    const withSession = (machineId: string, sid: string, fp: string) => ({
      ...tree(machineId, fp),
      sessions: [
        {
          sid,
          name: sid,
          isCurrent: true,
          state: 'live',
          diedSecondsAgo: null,
          tabs: [
            {
              tabId: 0,
              name: 'e',
              position: 0,
              active: true,
              panes: [{ id: 1, name: null, command: null, isFocused: true, exited: false, contentFingerprint: fp }],
            },
          ],
        },
      ],
    })
    await ingestBody(a.secret, withSession('multi-1', 's1', 'fpA'))
    await ingestBody(a.secret, withSession('multi-1', 's2', 'fpB'))

    const detail = await request(app).get('/api/v1/machines/multi-1').set('Cookie', a.cookie)
    expect(detail.status).toBe(200)
    const sids = detail.body.snapshot.sessions.map((s: { sid: string }) => s.sid).sort()
    expect(sids).toEqual(['s1', 's2'])

    const list = await request(app).get('/api/v1/machines').set('Cookie', a.cookie)
    const m = list.body.machines.find((x: { id: string }) => x.id === 'multi-1')
    expect(m.counts.sessions).toBe(2)
  })

  it('blocks cross-tenant reads and forgets (IDOR → 404)', async () => {
    const a = await newActor()
    const b = await newActor()
    await ingest(a.secret, 'owned-by-a')

    // B cannot see A's machine in the list, nor read or forget it.
    const bList = await request(app).get('/api/v1/machines').set('Cookie', b.cookie)
    expect(bList.body.machines.map((m: { id: string }) => m.id)).not.toContain('owned-by-a')
    expect((await request(app).get('/api/v1/machines/owned-by-a').set('Cookie', b.cookie)).status).toBe(404)
    expect((await request(app).delete('/api/v1/machines/owned-by-a').set('Cookie', b.cookie)).status).toBe(404)

    // A's machine survived B's forget attempt.
    expect((await request(app).get('/api/v1/machines/owned-by-a').set('Cookie', a.cookie)).status).toBe(200)
  })

  it('forgets a machine and its snapshot', async () => {
    const a = await newActor()
    await ingest(a.secret, 'to-forget')
    expect((await request(app).delete('/api/v1/machines/to-forget').set('Cookie', a.cookie)).status).toBe(204)
    expect((await request(app).get('/api/v1/machines/to-forget').set('Cookie', a.cookie)).status).toBe(404)
    expect(await prisma.snapshot.findFirst({ where: { machineId: 'to-forget' } })).toBeNull()
  })

  it('records the ingest token that last pushed for each machine (tokenId) so /tokens can group them', async () => {
    const a = await newActor()
    await ingest(a.secret, 'tok-link-1')
    const list = await request(app).get('/api/v1/machines').set('Cookie', a.cookie)
    const m = list.body.machines.find((x: { id: string }) => x.id === 'tok-link-1')
    expect(m.tokenId).toBe(a.tokenId)
    // The detail endpoint carries it too (MachineDetail extends MachineSummary).
    const detail = await request(app).get('/api/v1/machines/tok-link-1').set('Cookie', a.cookie)
    expect(detail.body.tokenId).toBe(a.tokenId)
  })

  it('revoking a token forgets the machines it last pushed for (combined revoke + forget)', async () => {
    const a = await newActor()
    await ingest(a.secret, 'combined-1')
    await ingest(a.secret, 'combined-2')

    const del = await request(app).delete(`/api/v1/tokens/${a.tokenId}`).set('Cookie', a.cookie)
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ forgotten: 2 })

    // Both machines and all their derived rows are gone; the token is revoked.
    const list = await request(app).get('/api/v1/machines').set('Cookie', a.cookie)
    expect(list.body.machines).toHaveLength(0)
    expect(await prisma.snapshot.findFirst({ where: { machineId: 'combined-1' } })).toBeNull()
    expect(await prisma.token.findUnique({ where: { id: a.tokenId } }).then((t) => t?.revokedAt)).not.toBeNull()

    // Idempotent: revoking again forgets nothing (machines already gone), still 200.
    const again = await request(app).delete(`/api/v1/tokens/${a.tokenId}`).set('Cookie', a.cookie)
    expect(again.status).toBe(200)
    expect(again.body).toEqual({ forgotten: 0 })
  })

  it('a combined revoke leaves machines pushed by OTHER tokens untouched', async () => {
    const a = await newActor()
    // A second token for the same account, pushing a different machine.
    const t2 = generateToken()
    const token2 = await prisma.token.create({
      data: { accountId: a.id, lookupPrefix: t2.lookupPrefix, secretHash: t2.secretHash },
    })
    await ingest(a.secret, 'keep-mine')
    await ingest(t2.secret, 'keep-other')

    const del = await request(app).delete(`/api/v1/tokens/${a.tokenId}`).set('Cookie', a.cookie)
    expect(del.body).toEqual({ forgotten: 1 })

    const list = await request(app).get('/api/v1/machines').set('Cookie', a.cookie)
    const ids = list.body.machines.map((m: { id: string; tokenId: string | null }) => m.id)
    expect(ids).toContain('keep-other')
    expect(ids).not.toContain('keep-mine')
    // The other token's machine still points at it.
    const other = list.body.machines.find((m: { id: string }) => m.id === 'keep-other')
    expect(other.tokenId).toBe(token2.id)
  })

  it('404s an unknown machine and returns empty attentions', async () => {
    const a = await newActor()
    expect((await request(app).get('/api/v1/machines/nope').set('Cookie', a.cookie)).status).toBe(404)
    const att = await request(app).get('/api/v1/attentions').set('Cookie', a.cookie)
    expect(att.status).toBe(200)
    expect(att.body).toEqual({ attentions: [] })
  })
})
