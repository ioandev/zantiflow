// Chat-integration link-token minting against a REAL MariaDB (testcontainers, ADR-0007): the 8-char
// code shape, the per-account mint rate limit (flood guard), replace-on-remint (no row accretion),
// and pruning of used/expired tokens. Owner sessions are crafted directly via signSession.
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { MariaDbContainer, type StartedMariaDbContainer } from '@testcontainers/mariadb'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import { PrismaClient } from '@prisma/client'
import type { Express } from 'express'
import { signSession } from '../src/auth/tokens'
import { LINK_TTL_MS, pruneLinkTokens } from '../src/bots/linkToken'
import { parseConfig, type Config } from '../src/config'
import { createApp } from '../src/http/app'
import { nullLogger } from '../src/log'
import { containerRuntimeUp, socketPath } from './helpers/runtime'

const runtimeUp = await containerRuntimeUp()
if (!runtimeUp) {
  console.warn(`[integrations.integration] no container runtime at ${socketPath} — skipping`)
}
const suite = runtimeUp ? describe : describe.skip

suite('integrations link-token (testcontainers MariaDB)', () => {
  let container: StartedMariaDbContainer
  let prisma: PrismaClient
  let app: Express
  let config: Config
  let seq = 0

  const newAccount = async (): Promise<{ id: string; cookie: string }> => {
    const acc = await prisma.account.create({
      data: { oauthProvider: 'google', oauthId: `sub-${seq++}`, name: 'Owner' },
    })
    const cookie = `ztf_session=${signSession(config.tokenSecret, { accountId: acc.id, epoch: acc.sessionEpoch }, 14)}`
    return { id: acc.id, cookie }
  }
  const mint = (cookie: string, platform = 'telegram') =>
    request(app).post(`/api/v1/integrations/${platform}/link-token`).set('Cookie', cookie).send({})

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
    expect((await request(app).post('/api/v1/integrations/telegram/link-token').send({})).status).toBe(401)
  })

  it('mints an 8-char /link command', async () => {
    const { cookie } = await newAccount()
    const res = await mint(cookie)
    expect(res.status).toBe(200)
    expect(res.body.command).toMatch(/^\/link \S{8}$/)
  })

  it('replace-on-remint: repeated presses never accumulate unused tokens (one per platform)', async () => {
    const { id, cookie } = await newAccount()
    for (let i = 0; i < 3; i++) expect((await mint(cookie, 'telegram')).status).toBe(200)
    await mint(cookie, 'discord') // a different platform is independent
    const unusedTelegram = await prisma.linkToken.count({
      where: { accountId: id, platform: 'telegram', usedAt: null },
    })
    expect(unusedTelegram).toBe(1)
    const unusedTotal = await prisma.linkToken.count({ where: { accountId: id, usedAt: null } })
    expect(unusedTotal).toBe(2) // telegram + discord
  })

  it('rate-limits minting per account (burst 5 → 6th is 429)', async () => {
    const { cookie } = await newAccount()
    const results = []
    for (let i = 0; i < 6; i++) results.push((await mint(cookie)).status)
    expect(results.slice(0, 5)).toEqual([200, 200, 200, 200, 200])
    expect(results[5]).toBe(429)
  })

  it('prunes used and expired link tokens, keeping fresh unused ones', async () => {
    const { id } = await newAccount()
    const past = new Date(Date.now() - 60_000)
    const future = new Date(Date.now() + LINK_TTL_MS)
    await prisma.linkToken.createMany({
      data: [
        { tokenHash: `used-${id}`, accountId: id, platform: 'telegram', expiresAt: future, usedAt: new Date() },
        { tokenHash: `expired-${id}`, accountId: id, platform: 'telegram', expiresAt: past },
        { tokenHash: `fresh-${id}`, accountId: id, platform: 'telegram', expiresAt: future },
      ],
    })
    const deleted = await pruneLinkTokens(prisma)
    expect(deleted).toBeGreaterThanOrEqual(2)
    const remaining = await prisma.linkToken.findMany({ where: { accountId: id } })
    expect(remaining.map((r) => r.tokenHash)).toEqual([`fresh-${id}`])
  })
})
