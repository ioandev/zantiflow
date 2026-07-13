// The durable dispatcher (ADR-0009 §3). Sweeps pending web-push deliveries and sends each via the
// injected `WebPushSender`, recording per-row status/attempts/ack. Pending rows are simply re-processed
// on the next sweep — so a backend restart replays the queue automatically (at-least-once). A 404/410
// prunes the dead subscription. Idempotency lives in the `deliveryId` unique constraint at creation.
import type { PrismaClient } from '@prisma/client'
import type { BotHub, Platform } from '../bots/hub'
import type { WebPushSender } from './webpush'

export const MAX_ATTEMPTS = 5
const BATCH = 100
const REDELIVER_AFTER_MS = 30_000 // wait this long for a bot ack before re-sending (bot dedups by deliveryId)

export interface DispatchStats {
  delivered: number
  failed: number
  retried: number
}

export const dispatchPending = async (
  prisma: PrismaClient,
  sender: WebPushSender,
  now: Date = new Date(),
): Promise<DispatchStats> => {
  const stats: DispatchStats = { delivered: 0, failed: 0, retried: 0 }

  const pending = await prisma.notificationDelivery.findMany({
    where: { channel: 'webpush', status: 'pending', attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  })

  for (const d of pending) {
    const sub = await prisma.pushSubscription.findUnique({ where: { id: d.recipientRef } })
    if (!sub) {
      await prisma.notificationDelivery.update({
        where: { id: d.id },
        data: { status: 'failed', attempts: d.attempts + 1, lastError: 'subscription_gone', dispatchedAt: now },
      })
      stats.failed += 1
      continue
    }

    const notification = await prisma.notification.findUnique({ where: { id: d.notificationId } })
    const result = await sender.send(
      { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
      { title: 'zantiflow', body: notification?.text ?? 'You have a notification' },
    )

    if (result.ok) {
      await prisma.notificationDelivery.update({
        where: { id: d.id },
        data: { status: 'delivered', attempts: d.attempts + 1, dispatchedAt: now, ackedAt: now },
      })
      stats.delivered += 1
    } else if (result.gone) {
      // The push subscription is dead — remove it and fail this delivery.
      await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {})
      await prisma.notificationDelivery.update({
        where: { id: d.id },
        data: { status: 'failed', attempts: d.attempts + 1, lastError: 'gone', dispatchedAt: now },
      })
      stats.failed += 1
    } else {
      const attempts = d.attempts + 1
      const terminal = attempts >= MAX_ATTEMPTS
      await prisma.notificationDelivery.update({
        where: { id: d.id },
        data: {
          status: terminal ? 'failed' : 'pending',
          attempts,
          dispatchedAt: now,
          lastError: (result.error ?? 'send_failed').slice(0, 512),
        },
      })
      if (terminal) stats.failed += 1
      else stats.retried += 1
    }
  }

  return stats
}

/**
 * Route pending chat (discord/telegram) deliveries to the connected bot over the hub. Offline bots
 * leave rows pending → they flush on reconnect. A delivery stays pending until the bot acks it via
 * `delivery_result` (ADR-0007/0009); we only re-send once the ack window has lapsed (bot dedups by
 * deliveryId, so a re-send is safe).
 */
export const dispatchBotDeliveries = async (
  prisma: PrismaClient,
  hub: BotHub,
  now: Date = new Date(),
): Promise<number> => {
  const staleBefore = new Date(now.getTime() - REDELIVER_AFTER_MS)
  const pending = await prisma.notificationDelivery.findMany({
    where: {
      channel: { in: ['discord', 'telegram'] },
      status: 'pending',
      attempts: { lt: MAX_ATTEMPTS },
      OR: [{ dispatchedAt: null }, { dispatchedAt: { lt: staleBefore } }],
    },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  })

  let sent = 0
  for (const d of pending) {
    const platform = d.channel as Platform
    if (!hub.isConnected(platform)) continue // offline → stays pending, flushed on reconnect
    const notification = await prisma.notification.findUnique({ where: { id: d.notificationId } })
    const ok = hub.deliver(platform, d.recipientRef, d.deliveryId, notification?.text ?? 'You have a notification')
    if (ok) {
      await prisma.notificationDelivery.update({
        where: { id: d.id },
        data: { attempts: d.attempts + 1, dispatchedAt: now },
      })
      sent += 1
    }
  }
  return sent
}
