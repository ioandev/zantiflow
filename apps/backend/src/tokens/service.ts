// Ingest-token lifecycle (ADR-0003 §2/§3). All operations are scoped by `accountId`. The ≤10-active
// cap is enforced ATOMICALLY inside a Serializable transaction (+ retry on write-conflict) so
// concurrent creates can't exceed it. Listing never exposes secrets; ingest auth is constant-time.
import type { PrismaClient } from '@prisma/client'
import { AppError, notFound } from '../http/errors'
import type { PaneOutputStore } from '../output/store'
import { generateToken, lookupPrefixOf, parseBearer, secretHashMatches } from './secret'
import { parseTtl } from './ttl'

export const MAX_ACTIVE_TOKENS = 10

const activeWhere = (accountId: string) => ({
  accountId,
  revokedAt: null,
  OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
})

export interface MintedToken {
  id: string
  secret: string // shown ONCE
  label: string | null
  expiresAt: Date | null
  createdAt: Date
}

export const mintToken = async (
  prisma: PrismaClient,
  accountId: string,
  input: { label?: string; ttl?: unknown },
): Promise<MintedToken> => {
  const expiresAt = parseTtl(input.ttl ?? 'infinite')
  const label = input.label ?? null
  const { secret, lookupPrefix, secretHash } = generateToken()

  // Serialize this account's mints by taking an exclusive lock on its Account row first, so the
  // count→insert is atomic under concurrency (no phantom, no serialization retries). Mints for
  // different accounts lock different rows and never contend. (ADR-0003 §2 atomic cap.)
  const created = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM Account WHERE id = ${accountId} FOR UPDATE`
    const active = await tx.token.count({ where: activeWhere(accountId) })
    if (active >= MAX_ACTIVE_TOKENS) {
      throw new AppError(409, 'token_limit_reached', 'Active token limit reached', { max: MAX_ACTIVE_TOKENS })
    }
    return tx.token.create({ data: { accountId, lookupPrefix, secretHash, label, expiresAt } })
  })
  return { id: created.id, secret, label: created.label, expiresAt: created.expiresAt, createdAt: created.createdAt }
}

export type TokenStatus = 'active' | 'revoked' | 'expired'
export interface TokenMeta {
  id: string
  label: string | null
  createdAt: Date
  expiresAt: Date | null
  lastUsedAt: Date | null
  status: TokenStatus
}

export const listTokens = async (prisma: PrismaClient, accountId: string): Promise<TokenMeta[]> => {
  const rows = await prisma.token.findMany({ where: { accountId }, orderBy: { createdAt: 'desc' } })
  const now = Date.now()
  return rows.map((t) => ({
    id: t.id,
    label: t.label,
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
    lastUsedAt: t.lastUsedAt,
    status: t.revokedAt ? 'revoked' : t.expiresAt && t.expiresAt.getTime() <= now ? 'expired' : 'active',
  }))
}

/** Revoke immediately. Scoped by accountId (IDOR guard); idempotent; 404 if not owned/absent. */
export const revokeToken = async (prisma: PrismaClient, accountId: string, id: string): Promise<void> => {
  const res = await prisma.token.updateMany({
    where: { id, accountId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  if (res.count === 0) {
    const exists = await prisma.token.findFirst({ where: { id, accountId } })
    if (!exists) throw notFound('token_not_found')
    // else already revoked → idempotent no-op
  }
}

/**
 * Revoke ALL of an account's not-yet-revoked ingest tokens in one shot (the owner "unlink everything"
 * action). Scoped by accountId (IDOR guard); idempotent; returns how many were revoked (0 if none).
 * After this, every plugin using any of the account's tokens stops being able to push.
 */
export const revokeAllTokens = async (prisma: PrismaClient, accountId: string): Promise<number> => {
  const res = await prisma.token.updateMany({
    where: { accountId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  return res.count
}

/** Rename (relabel) a token. Scoped by accountId (IDOR guard); 404 if not owned/absent. Empty → null. */
export const renameToken = async (
  prisma: PrismaClient,
  accountId: string,
  id: string,
  label: string | null,
): Promise<void> => {
  const res = await prisma.token.updateMany({ where: { id, accountId }, data: { label } })
  if (res.count === 0) throw notFound('token_not_found')
}

/**
 * Revoke a token AND forget every machine it last pushed for, in one transaction (the combined
 * "kick a machine and remove its token" action — ADR-0003). Scoped by accountId (IDOR guard); 404 if
 * the token isn't owned. Forgetting a machine deletes it and all its derived data (mirrors
 * `forgetMachine`'s cleanup set). Machines with no recorded token (tokenId=null) are untouched — they
 * are cleaned individually from the /tokens page. Returns how many machines were forgotten.
 */
export const revokeTokenAndForgetMachines = async (
  prisma: PrismaClient,
  outputStore: PaneOutputStore,
  accountId: string,
  id: string,
): Promise<{ forgotten: number }> => {
  const token = await prisma.token.findFirst({ where: { id, accountId } })
  if (!token) throw notFound('token_not_found')
  const machines = await prisma.machine.findMany({ where: { tokenId: id, accountId }, select: { id: true } })
  const ids = machines.map((m) => m.id)
  await prisma.$transaction([
    // Revoke is idempotent (a no-op if already revoked); the machine cleanup still runs.
    prisma.token.updateMany({ where: { id, accountId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ...(ids.length > 0
      ? [
          prisma.snapshot.deleteMany({ where: { machineId: { in: ids }, accountId } }),
          prisma.paneActivity.deleteMany({ where: { machineId: { in: ids }, accountId } }),
          prisma.attention.deleteMany({ where: { machineId: { in: ids }, accountId } }),
          prisma.outputRequest.deleteMany({ where: { machineId: { in: ids }, accountId } }),
          prisma.machine.deleteMany({ where: { id: { in: ids }, accountId } }),
        ]
      : []),
  ])
  // Pane output is memory-only (ADR-0032) — purge every forgotten machine's captures immediately.
  for (const mid of ids) outputStore.deleteMachine(accountId, mid)
  return { forgotten: ids.length }
}

export interface IngestPrincipal {
  accountId: string
  tokenId: string
}

/**
 * Authenticate an ingest request from its `Authorization: Bearer ztf_…` header. Returns the
 * principal, or null (→ 401 upstream). Server-side expiry + revocation checks on EVERY ingest.
 */
export const authenticateIngest = async (
  prisma: PrismaClient,
  authHeader: string | undefined,
): Promise<IngestPrincipal | null> => {
  const secret = parseBearer(authHeader)
  if (!secret) return null
  const prefix = lookupPrefixOf(secret)
  if (!prefix) return null

  const token = await prisma.token.findUnique({ where: { lookupPrefix: prefix } })
  if (!token) return null
  if (!secretHashMatches(secret, token.secretHash)) return null
  if (token.revokedAt) return null
  if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) return null
  return { accountId: token.accountId, tokenId: token.id }
}

/** Best-effort `lastUsedAt` touch after a successful ingest (never blocks the response path). */
export const markTokenUsed = async (prisma: PrismaClient, tokenId: string): Promise<void> => {
  await prisma.token.update({ where: { id: tokenId }, data: { lastUsedAt: new Date() } }).catch(() => {})
}
