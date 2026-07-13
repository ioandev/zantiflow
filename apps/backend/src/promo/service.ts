// Promo codes — the PRO-granting mechanism (ADR-0011 §2, ADR-0020). Codes are auto-generated every
// couple of weeks (no admin), posted on the homepage, and redeemed by logged-in users to extend their
// PRO window. Redemption is atomic (per-account row lock), capped, and returns GENERIC errors so codes
// can't be enumerated.
import { randomBytes } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { AppError } from '../http/errors'

export const DURATION_DAYS = 30
export const VALIDITY_DAYS = 30
export const TIER_CAP_DAYS = 60
const DAY_MS = 86_400_000

// Unambiguous base32 (no 0/O/1/I/L) — same family as pairing codes.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export const generatePromoCode = (): string => {
  let raw = ''
  for (const b of randomBytes(8)) raw += ALPHABET[b % ALPHABET.length]
  return `ZTF-${raw}`
}

/** Mint a fresh homepage code valid for VALIDITY_DAYS. */
export const generateAutoCode = (prisma: PrismaClient, now: Date = new Date()) =>
  prisma.promoCode.create({
    data: {
      code: generatePromoCode(),
      grantsTier: 'pro',
      durationDays: DURATION_DAYS,
      perAccountLimit: 1,
      expiresAt: new Date(now.getTime() + VALIDITY_DAYS * DAY_MS),
      createdBy: 'auto',
    },
  })

export interface CurrentCode {
  code: string
  grantsTier: string
  durationDays: number
  expiresAt: string
}

/** The active homepage code = the newest non-expired auto code, or null. */
export const currentCode = async (prisma: PrismaClient, now: Date = new Date()): Promise<CurrentCode | null> => {
  const c = await prisma.promoCode.findFirst({
    where: { createdBy: 'auto', expiresAt: { gt: now } },
    orderBy: { createdAt: 'desc' },
  })
  return c
    ? { code: c.code, grantsTier: c.grantsTier, durationDays: c.durationDays, expiresAt: c.expiresAt.toISOString() }
    : null
}

/** Ensure there's always a current homepage code (called on boot + periodically). */
export const ensureCurrentCode = async (prisma: PrismaClient, now: Date = new Date()): Promise<void> => {
  if (!(await currentCode(prisma, now))) await generateAutoCode(prisma, now)
}

/** Redeem a code for the account → PRO extended by durationDays (capped now+60d). Returns the expiry. */
export const redeem = async (
  prisma: PrismaClient,
  accountId: string,
  codeInput: string,
  now: Date = new Date(),
): Promise<Date> => {
  const code = codeInput.trim().toUpperCase()
  return prisma.$transaction(async (tx) => {
    // Serialize this account's redemptions (prevents concurrent double-redeem).
    await tx.$queryRaw`SELECT id FROM Account WHERE id = ${accountId} FOR UPDATE`

    const promo = await tx.promoCode.findUnique({ where: { code } })
    // Generic error for not-found / expired / exhausted → no enumeration signal.
    if (!promo || promo.expiresAt.getTime() <= now.getTime()) {
      throw new AppError(400, 'invalid_code', 'Invalid or expired code')
    }
    if (promo.maxRedemptions !== null) {
      const total = await tx.promoRedemption.count({ where: { code } })
      if (total >= promo.maxRedemptions) throw new AppError(400, 'invalid_code', 'Invalid or expired code')
    }
    const mine = await tx.promoRedemption.count({ where: { code, accountId } })
    if (mine >= promo.perAccountLimit)
      throw new AppError(409, 'already_redeemed', 'You have already redeemed this code')

    await tx.promoRedemption.create({ data: { code, accountId } })

    const account = await tx.account.findUnique({ where: { id: accountId } })
    const base = account?.tierExpiresAt && account.tierExpiresAt.getTime() > now.getTime() ? account.tierExpiresAt : now
    const cap = new Date(now.getTime() + TIER_CAP_DAYS * DAY_MS)
    let expiry = new Date(base.getTime() + promo.durationDays * DAY_MS)
    if (expiry.getTime() > cap.getTime()) expiry = cap
    await tx.account.update({ where: { id: accountId }, data: { tier: 'pro', tierExpiresAt: expiry } })
    return expiry
  })
}
