// Device-pairing flow (ADR-0012; RFC-8628 adapted). start → (owner) approve → poll delivers the
// ingest token ONCE. The token is minted at POLL time (not stored anywhere in plaintext — the model
// has no secret field), atomically counting against the account's ≤10-token cap. Polling is keyed by
// the unguessable sessionId; the userCode is single-use and only ever compared by hash.
import type { PrismaClient } from '@prisma/client'
import { AppError } from '../http/errors'
import { generateToken } from '../tokens/secret'
import { MAX_ACTIVE_TOKENS } from '../tokens/service'
import { generateSessionId, generateUserCode, hashUserCode, normalizeUserCode } from './code'

export const PAIRING_TTL_SEC = 600 // ~10 min
export const POLL_INTERVAL_SEC = 5

export interface StartedPairing {
  sessionId: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export const startPairing = async (
  prisma: PrismaClient,
  verificationUri: string,
  machineHint?: string,
): Promise<StartedPairing> => {
  const sessionId = generateSessionId()
  const userCode = generateUserCode()
  await prisma.pairingSession.create({
    data: {
      id: sessionId,
      userCodeHash: hashUserCode(normalizeUserCode(userCode)),
      status: 'pending',
      machineHint: machineHint ?? null,
      expiresAt: new Date(Date.now() + PAIRING_TTL_SEC * 1000),
    },
  })
  return { sessionId, userCode, verificationUri, expiresIn: PAIRING_TTL_SEC, interval: POLL_INTERVAL_SEC }
}

/** Owner approves a code → binds the pairing to their account (atomic; single-use). */
export const approvePairing = async (prisma: PrismaClient, accountId: string, userCodeInput: string): Promise<void> => {
  const hash = hashUserCode(normalizeUserCode(userCodeInput))
  const session = await prisma.pairingSession.findUnique({ where: { userCodeHash: hash } })
  if (!session) throw new AppError(404, 'invalid_code', 'Unknown or expired pairing code')
  if (session.expiresAt < new Date()) throw new AppError(400, 'code_expired', 'Pairing code expired')
  // Only a still-pending code can be approved (guards double-approval / replay).
  const res = await prisma.pairingSession.updateMany({
    where: { id: session.id, status: 'pending' },
    data: { status: 'approved', accountId },
  })
  if (res.count === 0) throw new AppError(400, 'code_not_pending', 'Pairing code is no longer pending')
}

export type PollResult =
  | { status: 'authorization_pending'; interval: number }
  | { status: 'slow_down'; interval: number }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'consumed' }
  | { status: 'cap_reached' }
  | { status: 'approved'; token: string }
  | { status: 'unknown' }

export const pollPairing = async (prisma: PrismaClient, sessionId: string): Promise<PollResult> => {
  return prisma.$transaction(async (tx) => {
    // Serialize concurrent polls for this session so the token is minted at most once.
    await tx.$queryRaw`SELECT id FROM PairingSession WHERE id = ${sessionId} FOR UPDATE`
    const s = await tx.pairingSession.findUnique({ where: { id: sessionId } })
    if (!s) return { status: 'unknown' }

    const now = new Date()
    const tooFast = s.lastPolledAt !== null && now.getTime() - s.lastPolledAt.getTime() < (POLL_INTERVAL_SEC - 1) * 1000
    await tx.pairingSession.update({ where: { id: sessionId }, data: { lastPolledAt: now } })

    if (s.status === 'consumed') return { status: 'consumed' }
    if (s.status === 'denied') return { status: 'denied' }
    if (s.expiresAt < now) {
      if (s.status !== 'expired')
        await tx.pairingSession.update({ where: { id: sessionId }, data: { status: 'expired' } })
      return { status: 'expired' }
    }
    if (s.status === 'pending' || s.status === 'expired') {
      return tooFast
        ? { status: 'slow_down', interval: POLL_INTERVAL_SEC * 2 }
        : { status: 'authorization_pending', interval: POLL_INTERVAL_SEC }
    }
    if (s.status === 'approved' && s.accountId) {
      // Mint the token now, bound to the approving account, atomic against the ≤10 cap.
      await tx.$queryRaw`SELECT id FROM Account WHERE id = ${s.accountId} FOR UPDATE`
      const active = await tx.token.count({
        where: { accountId: s.accountId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      })
      if (active >= MAX_ACTIVE_TOKENS) return { status: 'cap_reached' }
      const { secret, lookupPrefix, secretHash } = generateToken()
      const token = await tx.token.create({
        data: { accountId: s.accountId, lookupPrefix, secretHash, label: s.machineHint ?? 'paired device' },
      })
      await tx.pairingSession.update({
        where: { id: sessionId },
        data: { status: 'consumed', issuedTokenId: token.id },
      })
      return { status: 'approved', token: secret }
    }
    return { status: 'unknown' }
  })
}
