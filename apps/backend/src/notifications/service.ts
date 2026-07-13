// Notifications (ADR-0006/0009). When an attention FIRES, we create one logical `Notification` and a
// durable `NotificationDelivery` row PER channel/recipient (idempotent `deliveryId`). Delivery text is
// composed to honor privacy — it NEVER contains session/tab/pane names or pane content (ADR-0002/0006),
// only the generic attention kind. Everything is scoped by `accountId`.
import type { PrismaClient } from '@prisma/client'
import type { FiredAttention } from '../attentions/service'

/** Privacy-safe, name-free notification text for a fired attention. */
export const notificationText = (type: string): string => {
  switch (type) {
    case 'claude.needs-input':
      return 'Claude needs your input'
    case 'claude.thinking':
      return 'Claude is thinking'
    case 'session.detached':
      return 'A session detached'
    case 'session.stopped':
      return 'A session stopped'
    case 'claude.idle':
      return 'All Claude sessions are idle'
    case 'machine.offline':
      return 'A machine went offline'
    default:
      return 'A session needs your attention'
  }
}

/** Which channels a fired attention MAY be delivered to. Web Push for everyone; chat channels
 *  (discord/telegram) are pro-only and only used when the account has an active link (ADR-0006/0007). */
export const eligibleChannels = (tier: string): string[] =>
  tier === 'pro' ? ['webpush', 'discord', 'telegram'] : ['webpush']

/**
 * Create a Notification + its per-channel Delivery rows for each fired attention. Web-push deliveries
 * are fanned out one-per-device (`PushSubscription`). Idempotent: the deterministic `deliveryId`
 * (`notificationId:channel:recipientRef`) means a replay can't double-insert.
 */
export const createForFired = async (
  prisma: PrismaClient,
  accountId: string,
  tier: string,
  fired: FiredAttention[],
): Promise<number> => {
  if (fired.length === 0) return 0
  const channels = eligibleChannels(tier)
  const subs = channels.includes('webpush') ? await prisma.pushSubscription.findMany({ where: { accountId } }) : []
  // Pro + linked chat channels (discord/telegram) ride the same durable queue (ADR-0007/0009).
  const links = tier === 'pro' ? await prisma.channelLink.findMany({ where: { accountId, status: 'active' } }) : []

  let created = 0
  const add = async (notificationId: string, channel: string, recipientRef: string) => {
    // Deterministic idempotency key so a retry/replay is a no-op rather than a duplicate.
    const deliveryId = `${notificationId}:${channel}:${recipientRef}`
    await prisma.notificationDelivery
      .create({ data: { notificationId, accountId, channel, recipientRef, deliveryId, status: 'pending' } })
      .then(() => (created += 1))
      .catch(() => {
        /* unique deliveryId collision → already created; ignore */
      })
  }

  for (const f of fired) {
    const notification = await prisma.notification.create({
      data: {
        accountId,
        source: { type: f.type, targetKey: f.targetKey, machineId: f.machineId },
        text: notificationText(f.type),
      },
    })
    for (const sub of subs) await add(notification.id, 'webpush', sub.id)
    for (const link of links) {
      if (channels.includes(link.platform)) await add(notification.id, link.platform, link.platformUserId)
    }
  }
  return created
}

/** One channel a notification was sent on, with its best-known delivery status. */
export interface NotificationChannelView {
  channel: string // webpush | discord | telegram
  status: string // pending | delivered | failed | expired
}
/** A sent notification for the owner's "Sent notifications" view (ADR-0006/0009). */
export interface NotificationView {
  id: string
  text: string
  createdAt: Date
  channels: NotificationChannelView[]
}

// When a channel fanned out to several deliveries (e.g. web-push to N devices) we collapse it to one
// badge showing the "best" outcome reached — a delivery anywhere beats a still-pending or failed one.
const STATUS_RANK: Record<string, number> = { delivered: 3, pending: 2, failed: 1, expired: 0 }
const betterStatus = (prev: string | undefined, next: string): string =>
  prev === undefined || (STATUS_RANK[next] ?? -1) > (STATUS_RANK[prev] ?? -1) ? next : prev

/**
 * The account's most recent notifications (default 10, newest first), each annotated with the distinct
 * channels it was sent on and their status. Account-scoped; bounded by the ADR-0009 retention window
 * (older rows are pruned). Two reads, joined in memory — no per-notification N+1.
 */
export const listRecentNotifications = async (
  prisma: PrismaClient,
  accountId: string,
  limit = 10,
): Promise<NotificationView[]> => {
  const notifs = await prisma.notification.findMany({
    where: { accountId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  if (notifs.length === 0) return []
  const deliveries = await prisma.notificationDelivery.findMany({
    where: { accountId, notificationId: { in: notifs.map((n) => n.id) } },
    select: { notificationId: true, channel: true, status: true },
  })
  const byNotif = new Map<string, Map<string, string>>() // notificationId → channel → best status
  for (const d of deliveries) {
    let chans = byNotif.get(d.notificationId)
    if (!chans) {
      chans = new Map()
      byNotif.set(d.notificationId, chans)
    }
    chans.set(d.channel, betterStatus(chans.get(d.channel), d.status))
  }
  return notifs.map((n) => ({
    id: n.id,
    text: n.text,
    createdAt: n.createdAt,
    channels: [...(byNotif.get(n.id) ?? new Map<string, string>())].map(([channel, status]) => ({ channel, status })),
  }))
}

/** Prune the delivery queue (ADR-0009 §cron): expire stale-pending, delete terminal rows past TTL. */
export const pruneNotifications = async (
  prisma: PrismaClient,
  retentionHours: number,
  now: Date = new Date(),
): Promise<{ expired: number; deleted: number }> => {
  const cutoff = new Date(now.getTime() - retentionHours * 3600_000)
  const expired = await prisma.notificationDelivery.updateMany({
    where: { status: 'pending', createdAt: { lt: cutoff } },
    data: { status: 'expired' },
  })
  const deleted = await prisma.notificationDelivery.deleteMany({
    where: { status: { in: ['delivered', 'failed', 'expired'] }, createdAt: { lt: cutoff } },
  })
  // Notifications with no remaining deliveries are orphans → prune them too.
  await prisma.notification.deleteMany({
    where: { createdAt: { lt: cutoff }, accountId: { not: '' } },
  })
  return { expired: expired.count, deleted: deleted.count }
}
