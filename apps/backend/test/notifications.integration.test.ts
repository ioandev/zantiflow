// Durable notification delivery against a REAL MariaDB (testcontainers, ADR-0006/0009): a fired
// attention creates a Notification + per-device webpush Delivery; the dispatcher (with a MOCK sender —
// no real push service) delivers/retries/fails; dead subscriptions are pruned; pending rows replay on
// a fresh sweep (restart durability); retention prunes the queue.
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MariaDbContainer, type StartedMariaDbContainer } from '@testcontainers/mariadb'
import { PrismaClient } from '@prisma/client'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import type { FiredAttention } from '../src/attentions/service'
import { dispatchPending, MAX_ATTEMPTS } from '../src/delivery/dispatcher'
import type { SendResult, WebPushSender } from '../src/delivery/webpush'
import {
  createForFired,
  listRecentNotifications,
  notificationText,
  pruneNotifications,
} from '../src/notifications/service'
import { containerRuntimeUp, socketPath } from './helpers/runtime'

const runtimeUp = await containerRuntimeUp()
if (!runtimeUp) {
  console.warn(`[notifications.integration] no container runtime at ${socketPath} — skipping`)
}
const suite = runtimeUp ? describe : describe.skip

const sender = (result: SendResult): WebPushSender & { calls: number } => {
  const s = {
    calls: 0,
    async send() {
      s.calls += 1
      return result
    },
  }
  return s
}

const fired = (type = 'claude.needs-input'): FiredAttention[] => [{ machineId: 'm-1', type, targetKey: 's1:0:1' }]

suite('notification delivery (testcontainers MariaDB)', () => {
  let container: StartedMariaDbContainer
  let prisma: PrismaClient
  let seq = 0

  const withSubscription = async (tier = 'free') => {
    const acc = await prisma.account.create({
      data: { oauthProvider: 'google', oauthId: `a-${seq++}`, name: 'O', tier },
    })
    const sub = await prisma.pushSubscription.create({
      data: { accountId: acc.id, endpoint: `https://push.test/${seq++}`, p256dh: 'p', auth: 'a' },
    })
    return { accountId: acc.id, subId: sub.id }
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

  // The dispatcher is a global sweep, so isolate each test's queue.
  beforeEach(async () => {
    await prisma.notificationDelivery.deleteMany({})
    await prisma.notification.deleteMany({})
    await prisma.pushSubscription.deleteMany({})
  })

  it('composes name-free text (privacy)', () => {
    expect(notificationText('claude.needs-input')).toBe('Claude needs your input')
    expect(notificationText('session.detached')).toBe('A session detached')
    expect(notificationText('anything.else')).not.toMatch(/s1|m-1|:/)
  })

  it('a fired attention creates a notification + a pending delivery per device', async () => {
    const { accountId } = await withSubscription()
    const created = await createForFired(prisma, accountId, 'free', fired())
    expect(created).toBe(1)
    const deliveries = await prisma.notificationDelivery.findMany({ where: { accountId } })
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({ channel: 'webpush', status: 'pending' })
    const notif = await prisma.notification.findFirst({ where: { accountId } })
    expect(notif?.text).toBe('Claude needs your input')
  })

  it('dispatches pending deliveries and does not re-send delivered ones (idempotent replay)', async () => {
    const { accountId } = await withSubscription()
    await createForFired(prisma, accountId, 'free', fired())
    const s = sender({ ok: true })

    const stats = await dispatchPending(prisma, s)
    expect(stats.delivered).toBe(1)
    expect(s.calls).toBe(1)
    const row = await prisma.notificationDelivery.findFirst({ where: { accountId } })
    expect(row?.status).toBe('delivered')
    expect(row?.ackedAt).not.toBeNull()

    // A second sweep (as after a restart) must NOT re-send the delivered row.
    await dispatchPending(prisma, s)
    expect(s.calls).toBe(1)
  })

  it('prunes a dead subscription on 404/410 (gone) and fails the delivery', async () => {
    const { accountId, subId } = await withSubscription()
    await createForFired(prisma, accountId, 'free', fired())
    await dispatchPending(prisma, sender({ ok: false, gone: true }))
    expect(await prisma.pushSubscription.findUnique({ where: { id: subId } })).toBeNull()
    expect((await prisma.notificationDelivery.findFirst({ where: { accountId } }))?.status).toBe('failed')
  })

  it('retries on transient failure and gives up after MAX_ATTEMPTS', async () => {
    const { accountId } = await withSubscription()
    await createForFired(prisma, accountId, 'free', fired())
    const s = sender({ ok: false, error: 'timeout' })
    for (let i = 0; i < MAX_ATTEMPTS; i++) await dispatchPending(prisma, s)
    const row = await prisma.notificationDelivery.findFirst({ where: { accountId } })
    expect(row?.status).toBe('failed')
    expect(row?.attempts).toBe(MAX_ATTEMPTS)
    // No further sends once terminal.
    const before = s.calls
    await dispatchPending(prisma, s)
    expect(s.calls).toBe(before)
  })

  // --- "Sent notifications" read view (last 10 + their channels) ---
  const seedNotif = async (
    accountId: string,
    text: string,
    chans: { channel: string; status: string; recipientRef?: string }[],
    createdAt?: Date,
  ) => {
    const n = await prisma.notification.create({
      data: { accountId, source: {}, text, ...(createdAt ? { createdAt } : {}) },
    })
    for (const [i, c] of chans.entries()) {
      const recipientRef = c.recipientRef ?? `r${i}`
      await prisma.notificationDelivery.create({
        data: {
          notificationId: n.id,
          accountId,
          channel: c.channel,
          recipientRef,
          status: c.status,
          deliveryId: `${n.id}:${c.channel}:${recipientRef}`,
        },
      })
    }
    return n
  }
  const newAccount = (over: Record<string, unknown> = {}) =>
    prisma.account.create({ data: { oauthProvider: 'google', oauthId: `a-${seq++}`, name: 'O', ...over } })

  it('lists recent notifications newest-first with per-channel status (webpush devices collapsed)', async () => {
    const acc = await newAccount({ tier: 'pro' })
    const t0 = new Date('2026-07-12T00:00:00Z')
    await seedNotif(acc.id, 'older', [{ channel: 'webpush', status: 'delivered' }], t0)
    await seedNotif(
      acc.id,
      'newer',
      [
        { channel: 'webpush', status: 'delivered', recipientRef: 'd1' },
        { channel: 'webpush', status: 'pending', recipientRef: 'd2' }, // 2 devices → one badge, best status
        { channel: 'discord', status: 'failed' },
        { channel: 'telegram', status: 'delivered' },
      ],
      new Date(t0.getTime() + 1000),
    )
    const list = await listRecentNotifications(prisma, acc.id, 10)
    expect(list.map((n) => n.text)).toEqual(['newer', 'older']) // newest first
    const chanMap = Object.fromEntries(list[0].channels.map((c) => [c.channel, c.status]))
    expect(chanMap).toEqual({ webpush: 'delivered', discord: 'failed', telegram: 'delivered' })
  })

  it('caps at the requested limit (last 10)', async () => {
    const acc = await newAccount()
    for (let i = 0; i < 12; i++) {
      await seedNotif(
        acc.id,
        `n${i}`,
        [{ channel: 'webpush', status: 'delivered' }],
        new Date(Date.UTC(2026, 6, 12, 0, 0, i)),
      )
    }
    const list = await listRecentNotifications(prisma, acc.id, 10)
    expect(list).toHaveLength(10)
    expect(list[0].text).toBe('n11') // newest kept, oldest two dropped
  })

  it('is account-scoped', async () => {
    const a = await newAccount()
    const b = await newAccount()
    await seedNotif(a.id, 'a-only', [{ channel: 'webpush', status: 'delivered' }])
    expect(await listRecentNotifications(prisma, b.id, 10)).toHaveLength(0)
  })

  it('prunes the queue past the retention window', async () => {
    const { accountId } = await withSubscription()
    await createForFired(prisma, accountId, 'free', fired())
    await dispatchPending(prisma, sender({ ok: true })) // → delivered

    // Nothing older than 6h yet.
    expect((await pruneNotifications(prisma, 6)).deleted).toBe(0)
    // Pretend 7h passed → the delivered row is pruned.
    const future = new Date(Date.now() + 7 * 3600_000)
    const res = await pruneNotifications(prisma, 6, future)
    expect(res.deleted).toBeGreaterThanOrEqual(1)
    expect(await prisma.notificationDelivery.count({ where: { accountId } })).toBe(0)
  })
})
