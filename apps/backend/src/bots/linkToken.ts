// One-time account-linking tokens (ADR-0007 §linking). The website mints a short-lived, scoped token
// for a platform; the user runs the bot's `/link <token>` command; the bot relays it and the backend
// binds that platform user to the account. Hashed at rest (SHA-256) and single-use.
import { createHash, randomBytes } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'

export const LINK_TTL_MS = 10 * 60_000
const hashToken = (t: string): string => createHash('sha256').update(t).digest('hex')

export const mintLinkToken = async (
  prisma: PrismaClient,
  accountId: string,
  platform: string,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> => {
  // 8-char code (base64url of 6 bytes = exactly 8 chars, alphabet A–Za–z0–9_-). ~48 bits of entropy,
  // which is ample for a SINGLE-USE, 10-minute, owner-minted token that can only be redeemed through
  // the real (platform-rate-limited) Telegram/Discord bot — short enough to type by hand.
  const token = randomBytes(6).toString('base64url')
  const expiresAt = new Date(now.getTime() + LINK_TTL_MS)
  // Replace-on-remint: a fresh code supersedes this account's prior UNUSED codes for the platform, so
  // pressing "Connect" again never accumulates rows — at most one outstanding link token per platform.
  await prisma.$transaction([
    prisma.linkToken.deleteMany({ where: { accountId, platform, usedAt: null } }),
    prisma.linkToken.create({ data: { tokenHash: hashToken(token), accountId, platform, expiresAt } }),
  ])
  return { token, expiresAt }
}

/**
 * Prune link tokens that can never be redeemed again: single-use ones already consumed, or any past
 * their TTL. Bounds row growth from repeated mints; run by the retention cron (ADR-0018 §retention).
 */
export const pruneLinkTokens = async (prisma: PrismaClient, now: Date = new Date()): Promise<number> => {
  const res = await prisma.linkToken.deleteMany({
    where: { OR: [{ usedAt: { not: null } }, { expiresAt: { lte: now } }] },
  })
  return res.count
}

/** Verify + CONSUME a link token for the given platform. Returns the accountId, or null. Single-use. */
export const verifyLinkToken = async (
  prisma: PrismaClient,
  token: string,
  platform: string,
  now: Date = new Date(),
): Promise<string | null> => {
  const tokenHash = hashToken(token.trim())
  const found = await prisma.linkToken.findUnique({ where: { tokenHash } })
  if (!found || found.platform !== platform || found.usedAt || found.expiresAt.getTime() <= now.getTime()) return null
  // Atomically claim it (only the first consumer wins).
  const res = await prisma.linkToken.updateMany({ where: { tokenHash, usedAt: null }, data: { usedAt: now } })
  return res.count === 1 ? found.accountId : null
}
