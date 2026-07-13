// Backend↔bot hub against a REAL MariaDB (testcontainers, ADR-0007/0010) using FAKE connections (no
// real WS): hello auth, one-time link tokens, pro delivery routing with offline queue + reconnect
// replay + ack, and unlink. The WS transport (bots/ws.ts) is thin glue over this hub.
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MariaDbContainer, type StartedMariaDbContainer } from '@testcontainers/mariadb'
import { PrismaClient } from '@prisma/client'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import type { BackendToBot } from '@zantiflow/protocol'
import { BotHub, type BotConnection, type Platform } from '../src/bots/hub'
import { mintLinkToken } from '../src/bots/linkToken'
import { dispatchBotDeliveries } from '../src/delivery/dispatcher'
import { createForFired } from '../src/notifications/service'
import { containerRuntimeUp, socketPath } from './helpers/runtime'

const runtimeUp = await containerRuntimeUp()
if (!runtimeUp) {
  console.warn(`[bots.integration] no container runtime at ${socketPath} — skipping`)
}
const suite = runtimeUp ? describe : describe.skip

const SECRET = 'bot-service-secret'

interface FakeConn extends BotConnection {
  sent: BackendToBot[]
}
const fakeConn = (): FakeConn => {
  const c: FakeConn = {
    authed: false,
    platform: null as Platform | null,
    sent: [],
    send(m) {
      c.sent.push(m)
    },
  }
  return c
}

suite('bot hub (testcontainers MariaDB)', () => {
  let container: StartedMariaDbContainer
  let prisma: PrismaClient
  let seq = 0
  const newAccount = (tier = 'free') =>
    prisma.account.create({ data: { oauthProvider: 'google', oauthId: `a-${seq++}`, name: 'O', tier } })

  const hello = async (hub: BotHub, platform: Platform, secret = SECRET) => {
    const c = fakeConn()
    await hub.handleMessage(c, { kind: 'hello', platform, serviceSecret: secret, version: 1 })
    return c
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
  }, 240_000)

  afterAll(async () => {
    await prisma?.$disconnect()
    await container?.stop()
  })

  it('authenticates a bot via hello (rejects a wrong secret)', async () => {
    const hub = new BotHub(prisma, SECRET)
    const ok = await hello(hub, 'discord')
    expect(ok.sent[0]).toEqual({ kind: 'hello_ack', ok: true })
    expect(ok.authed).toBe(true)
    expect(hub.isConnected('discord')).toBe(true)

    const bad = await hello(hub, 'discord', 'wrong')
    expect(bad.sent[0]).toEqual({ kind: 'hello_ack', ok: false })
    expect(bad.authed).toBe(false)
  })

  it('links a platform user via a single-use token', async () => {
    const acc = await newAccount()
    const { token } = await mintLinkToken(prisma, acc.id, 'discord')
    expect(token).toHaveLength(8) // short, hand-typeable /link code
    const hub = new BotHub(prisma, SECRET)
    const c = await hello(hub, 'discord')
    await hub.handleMessage(c, {
      kind: 'link_request',
      platform: 'discord',
      platformUserId: 'u1',
      platformUsername: 'me',
      token,
    })
    expect(c.sent.at(-1)).toMatchObject({ kind: 'link_result', ok: true, platformUserId: 'u1' })
    const link = await prisma.channelLink.findUnique({
      where: { platform_platformUserId: { platform: 'discord', platformUserId: 'u1' } },
    })
    expect(link?.accountId).toBe(acc.id)

    // The token is single-use.
    const c2 = await hello(hub, 'discord')
    await hub.handleMessage(c2, { kind: 'link_request', platform: 'discord', platformUserId: 'u2', token })
    expect(c2.sent.at(-1)).toMatchObject({ kind: 'link_result', ok: false })
  })

  it('queues a pro delivery while offline, then delivers on reconnect and acks', async () => {
    const acc = await prisma.account.create({
      data: {
        oauthProvider: 'google',
        oauthId: `p-${seq++}`,
        name: 'P',
        tier: 'pro',
        tierExpiresAt: new Date(Date.now() + 86_400_000),
      },
    })
    await prisma.channelLink.create({
      data: { accountId: acc.id, platform: 'discord', platformUserId: 'u-deliver', status: 'active' },
    })
    await createForFired(prisma, acc.id, 'pro', [{ machineId: 'm', type: 'claude.needs-input', targetKey: 's:0:1' }])
    const delivery = await prisma.notificationDelivery.findFirst({ where: { accountId: acc.id, channel: 'discord' } })
    expect(delivery).not.toBeNull()

    const hub = new BotHub(prisma, SECRET)
    // Offline → nothing sent, still pending.
    expect(await dispatchBotDeliveries(prisma, hub)).toBe(0)
    expect((await prisma.notificationDelivery.findUnique({ where: { id: delivery!.id } }))?.status).toBe('pending')

    // Bot connects → replayed.
    const c = await hello(hub, 'discord')
    expect(await dispatchBotDeliveries(prisma, hub)).toBe(1)
    const deliverMsg = c.sent.find((m) => m.kind === 'deliver')
    expect(deliverMsg).toMatchObject({ kind: 'deliver', platformUserId: 'u-deliver', deliveryId: delivery!.deliveryId })

    // Bot acks → delivered.
    await hub.handleMessage(c, { kind: 'delivery_result', deliveryId: delivery!.deliveryId, status: 'delivered' })
    expect((await prisma.notificationDelivery.findUnique({ where: { id: delivery!.id } }))?.status).toBe('delivered')
  })

  it('marks a link stale on unlink_notice', async () => {
    const acc = await newAccount()
    await prisma.channelLink.create({
      data: { accountId: acc.id, platform: 'telegram', platformUserId: 't-1', status: 'active' },
    })
    const hub = new BotHub(prisma, SECRET)
    const c = await hello(hub, 'telegram')
    await hub.handleMessage(c, {
      kind: 'unlink_notice',
      platform: 'telegram',
      platformUserId: 't-1',
      reason: 'blocked',
    })
    expect(
      (
        await prisma.channelLink.findUnique({
          where: { platform_platformUserId: { platform: 'telegram', platformUserId: 't-1' } },
        })
      )?.status,
    ).toBe('stale')
  })

  it('hard-revokes a link on a user-initiated /unlink (reason user_command)', async () => {
    const acc = await newAccount()
    await prisma.channelLink.create({
      data: { accountId: acc.id, platform: 'telegram', platformUserId: 't-2', status: 'active' },
    })
    const hub = new BotHub(prisma, SECRET)
    const c = await hello(hub, 'telegram')
    await hub.handleMessage(c, {
      kind: 'unlink_notice',
      platform: 'telegram',
      platformUserId: 't-2',
      reason: 'user_command',
    })
    expect(
      (
        await prisma.channelLink.findUnique({
          where: { platform_platformUserId: { platform: 'telegram', platformUserId: 't-2' } },
        })
      )?.status,
    ).toBe('revoked')
  })
})
