// Spotlight roster API against a REAL MariaDB (testcontainers, ADR-0016/0033): the PRO-only
// `GET /api/v1/spotlight` returns the account's ACTIVE Claude sessions across all its machines —
// live, non-exited, Claude-detected panes only — and hard-gates non-PRO with 403 `requires_pro`.
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
import { containerRuntimeUp, socketPath } from './helpers/runtime'

const runtimeUp = await containerRuntimeUp()
if (!runtimeUp) {
  console.warn(`[spotlight.integration] no container runtime at ${socketPath} — skipping`)
}
const suite = runtimeUp ? describe : describe.skip

/** A wire-v4-ish snapshot slice: only the fields the Spotlight roster reads (sessions → tabs → panes). */
const pane = (id: number, name: string | null, command: string | null, exited = false) => ({
  id,
  name,
  command,
  isFocused: false,
  exited,
  contentFingerprint: `fp${id}`,
})
const sliceData = (machineId: string) => ({
  version: 4,
  machineId,
  capturedAtTick: 1,
  privacy: { full: true, machine: 'real', sessionNames: 'send', tabNames: 'send', paneNames: 'send' },
  machine: { source: 'real', name: 'host' },
  attentions: [],
  sessions: [
    {
      sid: 's1',
      name: 'work',
      isCurrent: true,
      state: 'live',
      diedSecondsAgo: null,
      tabs: [
        {
          tabId: 0,
          name: 'Tab #1',
          position: 0,
          active: true,
          panes: [
            pane(1, '⠙ claude', 'claude'), // active Claude (thinking spinner)
            pane(2, 'bash', 'bash'), // not Claude → excluded
            pane(3, '✳ claude', 'claude', true), // exited → excluded
          ],
        },
      ],
    },
    {
      sid: 'd1',
      name: 'dead',
      isCurrent: false,
      state: 'resurrectable', // not live → excluded
      diedSecondsAgo: 10,
      tabs: [],
    },
  ],
})

suite('spotlight roster (testcontainers MariaDB)', () => {
  let container: StartedMariaDbContainer
  let prisma: PrismaClient
  let app: Express
  let config: Config
  let seq = 0

  /** Create an account (PRO or free), an owner cookie, and one machine. */
  const actor = async (pro: boolean) => {
    const acc = await prisma.account.create({
      data: {
        oauthProvider: 'google',
        oauthId: `a-${seq++}`,
        name: 'O',
        tier: pro ? 'pro' : 'free',
        tierExpiresAt: pro ? new Date(Date.now() + 3_600_000) : null,
      },
    })
    const cookie = `ztf_session=${signSession(config.tokenSecret, { accountId: acc.id, epoch: 0 }, 14)}`
    const machine = await prisma.machine.create({
      data: { id: `m-${seq++}`, accountId: acc.id, displayName: 'red-laptop' },
    })
    return { accountId: acc.id, cookie, machineId: machine.id }
  }

  /** Seed a snapshot slice for a machine's session `s1` (+ dead `d1`), optionally aged out (stale),
   *  plus a matching per-pane activity row so the spinner-marked pane reads as "still producing
   *  output" — the freshness the `thinking` flag now requires (ADR-0034). */
  const seedSnapshot = async (accountId: string, machineId: string, receivedAt?: Date) => {
    await prisma.snapshot.create({
      data: {
        machineId,
        sid: 's1',
        accountId,
        version: 4,
        capturedAtTick: 1,
        data: sliceData(machineId),
        ...(receivedAt ? { receivedAt } : {}),
      },
    })
    await prisma.paneActivity.create({
      data: {
        machineId,
        sid: 's1',
        accountId,
        activity: { 's1:0:1': { fp: 'fp1', updatedAt: (receivedAt ?? new Date()).toISOString() } },
      },
    })
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

  it('returns only ACTIVE Claude panes for a PRO account', async () => {
    const a = await actor(true)
    await seedSnapshot(a.accountId, a.machineId)

    const res = await request(app).get('/api/v1/spotlight').set('Cookie', a.cookie)
    expect(res.status).toBe(200)
    expect(res.body.activeCount).toBe(1)
    expect(res.body.sessions).toHaveLength(1)
    const s = res.body.sessions[0]
    expect(s).toMatchObject({
      key: `${a.machineId}:s1:0:1`,
      machineId: a.machineId,
      machineName: 'red-laptop',
      sessionSid: 's1',
      tabId: 0,
      paneId: 1,
      thinking: true, // Braille spinner marker
    })
    // The bash pane, the exited claude pane, and the resurrectable session are all excluded.
    expect(res.body.sessions.map((x: { paneId: number }) => x.paneId)).toEqual([1])
  })

  it('hard-gates non-PRO with 403 requires_pro', async () => {
    const a = await actor(false)
    await seedSnapshot(a.accountId, a.machineId)
    const res = await request(app).get('/api/v1/spotlight').set('Cookie', a.cookie)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('requires_pro')
  })

  it('requires an owner session (401 without a cookie)', async () => {
    expect((await request(app).get('/api/v1/spotlight')).status).toBe(401)
  })

  it('excludes stale machines and never leaks another tenant', async () => {
    const a = await actor(true)
    const other = await actor(true)
    // `a` has a stale snapshot (aged past the 60s window) → nothing active.
    await seedSnapshot(a.accountId, a.machineId, new Date(Date.now() - 120_000))
    // `other` has a fresh one, but it must never appear for `a`.
    await seedSnapshot(other.accountId, other.machineId)

    const res = await request(app).get('/api/v1/spotlight').set('Cookie', a.cookie)
    expect(res.status).toBe(200)
    expect(res.body.activeCount).toBe(0)
    expect(res.body.sessions).toEqual([])
  })
})
