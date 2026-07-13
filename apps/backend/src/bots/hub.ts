// The backend↔bot hub (ADR-0007/0010). Bots dial OUT to `/internal/bots` (no public bot ingress) and
// authenticate with a shared service secret. This class is transport-agnostic — a `BotConnection` just
// needs a `send` callback — so it's unit-testable with fake connections. It routes the `botws`
// protocol: hello→hello_ack, link_request→ChannelLink, delivery_result→ack, unlink_notice→stale, and
// can `deliver` a notification to a connected bot.
import { timingSafeEqual } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import type { BackendToBot, BotToBackend } from '@zantiflow/protocol'
import { verifyLinkToken } from './linkToken'

export type Platform = 'discord' | 'telegram'

export interface BotConnection {
  authed: boolean
  platform: Platform | null
  send: (msg: BackendToBot) => void
}

const timingSafe = (a: string, b: string): boolean => {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

export class BotHub {
  private conns = new Map<Platform, Set<BotConnection>>()

  constructor(
    private readonly prisma: PrismaClient,
    private readonly serviceSecret: string | undefined,
  ) {}

  isConnected(platform: Platform): boolean {
    return (this.conns.get(platform)?.size ?? 0) > 0
  }

  /** Send a delivery to a connected bot for the platform. Returns false if none is connected. */
  deliver(platform: Platform, platformUserId: string, deliveryId: string, text: string): boolean {
    const set = this.conns.get(platform)
    if (!set || set.size === 0) return false
    for (const conn of set) {
      conn.send({ kind: 'deliver', deliveryId, platformUserId, text })
      return true // one connection per platform is enough
    }
    return false
  }

  /** Drop a connection (on socket close). */
  unregister(conn: BotConnection): void {
    for (const set of this.conns.values()) set.delete(conn)
  }

  async handleMessage(conn: BotConnection, msg: BotToBackend): Promise<void> {
    if (msg.kind === 'hello') {
      const ok = Boolean(this.serviceSecret) && timingSafe(msg.serviceSecret, this.serviceSecret!)
      if (!ok) {
        conn.send({ kind: 'hello_ack', ok: false })
        return
      }
      conn.authed = true
      conn.platform = msg.platform
      let set = this.conns.get(msg.platform)
      if (!set) {
        set = new Set()
        this.conns.set(msg.platform, set)
      }
      set.add(conn)
      conn.send({ kind: 'hello_ack', ok: true })
      return
    }

    if (!conn.authed || conn.platform === null) return // every other message requires a successful hello first
    // The platform this bot authenticated as. `const` so the non-null narrowing survives the awaits
    // below, and so EVERY write in this method is scoped to it — a discord bot can never touch a
    // telegram account's rows (and vice-versa), even if a compromised bot forges the `platform` field.
    const platform = conn.platform
    // Defence-in-depth: ignore any frame whose own `platform` contradicts the authenticated connection.
    if ('platform' in msg && msg.platform !== platform) return

    switch (msg.kind) {
      case 'link_request': {
        const accountId = await verifyLinkToken(this.prisma, msg.token, platform)
        if (!accountId) {
          conn.send({
            kind: 'link_result',
            token: msg.token,
            ok: false,
            platformUserId: msg.platformUserId,
            error: 'invalid_or_expired_token',
          })
          return
        }
        await this.prisma.channelLink.upsert({
          where: { platform_platformUserId: { platform, platformUserId: msg.platformUserId } },
          create: {
            accountId,
            platform,
            platformUserId: msg.platformUserId,
            platformUsername: msg.platformUsername ?? null,
            status: 'active',
          },
          update: { accountId, platformUsername: msg.platformUsername ?? null, status: 'active' },
        })
        conn.send({ kind: 'link_result', token: msg.token, ok: true, platformUserId: msg.platformUserId })
        return
      }
      case 'delivery_result': {
        // Ack the durable delivery (idempotent by deliveryId). Scoped to THIS bot's channel so a bot
        // can only settle its own platform's deliveries — never another channel's rows on any account
        // (a `delivery_result` frame carries no platform of its own, so we pin it to the connection).
        await this.prisma.notificationDelivery.updateMany({
          where: { deliveryId: msg.deliveryId, channel: platform },
          data:
            msg.status === 'delivered'
              ? { status: 'delivered', ackedAt: new Date() }
              : { status: 'failed', lastError: (msg.error ?? 'bot_failed').slice(0, 512) },
        })
        return
      }
      case 'unlink_notice': {
        // A user-initiated unlink (the bot's `/unlink` command, reason 'user_command') is deliberate
        // and terminal — mirror the website's DELETE /integrations/:id ('revoked'). Any other reason
        // (e.g. the bot detecting it can no longer DM the user) is a soft 'stale' that can re-activate
        // on the next successful link. Scoped to this bot's own platform.
        const status = msg.reason === 'user_command' ? 'revoked' : 'stale'
        await this.prisma.channelLink.updateMany({
          where: { platform, platformUserId: msg.platformUserId },
          data: { status },
        })
        return
      }
    }
  }
}
