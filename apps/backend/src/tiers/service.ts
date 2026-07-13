// Effective-tier resolution (ADR-0011 §1). `tier` is a time-bounded hook: an account is effectively
// PRO iff `tierExpiresAt` is in the future. A periodic sweep also lapses the STORED `tier` back to
// free so downstream reads (attentions/notifications) stay correct even without recomputing.
import type { PrismaClient } from '@prisma/client'

export type Tier = 'free' | 'pro'

export const effectiveTier = (account: { tier: string; tierExpiresAt: Date | null }, now: Date = new Date()): Tier =>
  account.tierExpiresAt && account.tierExpiresAt.getTime() > now.getTime() ? 'pro' : 'free'

/** Downgrade any PRO account whose window has passed. Returns how many lapsed. */
export const lapseExpiredTiers = async (prisma: PrismaClient, now: Date = new Date()): Promise<number> => {
  const res = await prisma.account.updateMany({
    where: { tier: 'pro', OR: [{ tierExpiresAt: null }, { tierExpiresAt: { lte: now } }] },
    data: { tier: 'free' },
  })
  return res.count
}
