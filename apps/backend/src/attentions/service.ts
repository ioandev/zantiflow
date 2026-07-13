// The attention episode engine (ADR-0005 §5). On each ingest we reconcile the machine's current
// attentions against what the plugin just reported: new active attentions start an episode (backend
// clock `activeSince`), continuing ones keep it, and any the plugin no longer reports are cleared
// (current-only, no history). An active attention whose duration ≥ the tier threshold and which is
// outside its cooldown FIRES (records `lastFiredAt`; notification dispatch is Phase 6). All scoped
// by `accountId` — machineId already belongs to exactly one account (enforced at ingest).
import type { PrismaClient } from '@prisma/client'
import type { Attention as WireAttention } from '@zantiflow/protocol'
import { cooldownSeconds, targetKeyOf, thresholdSeconds } from './policy'

export interface FiredAttention {
  machineId: string
  type: string
  targetKey: string
}

export interface ProcessResult {
  changed: boolean
  fired: FiredAttention[]
}

export const processAttentions = async (
  prisma: PrismaClient,
  accountId: string,
  machineId: string,
  wireAttentions: WireAttention[],
  tier: string,
  now: Date = new Date(),
  // The sids this ingest reported. When given, the end-of-tick clear only touches attentions for THESE
  // sessions — other sessions on the machine are reported by their own plugin instance and owned by
  // them. When omitted, the clear is machine-wide (single-reporter callers / tests).
  reportedSids?: Set<string>,
): Promise<ProcessResult> => {
  let changed = false
  const fired: FiredAttention[] = []
  const seen = new Set<string>() // `${targetKey}:${type}` still-active this tick

  for (const a of wireAttentions) {
    const targetKey = targetKeyOf(a.target)
    const type = a.type

    if (a.state === 'cleared') {
      const del = await prisma.attention.deleteMany({ where: { accountId, machineId, targetKey, type } })
      if (del.count > 0) changed = true
      continue
    }

    seen.add(`${targetKey}:${type}`)
    let row = await prisma.attention.findUnique({
      where: { machineId_targetKey_type: { machineId, targetKey, type } },
    })
    if (!row) {
      row = await prisma.attention.create({
        data: { accountId, machineId, type, targetKey, state: 'active', activeSince: now },
      })
      changed = true
    } else if (row.state !== 'active') {
      // A re-activated target starts a fresh episode.
      row = await prisma.attention.update({
        where: { id: row.id },
        data: { state: 'active', activeSince: now, lastFiredAt: null },
      })
      changed = true
    }

    // Fire when the episode is old enough AND outside its cooldown (tier-gated, server-side).
    const durationSec = (now.getTime() - row.activeSince.getTime()) / 1000
    const outsideCooldown =
      !row.lastFiredAt || (now.getTime() - row.lastFiredAt.getTime()) / 1000 >= cooldownSeconds(type)
    if (durationSec >= thresholdSeconds(type, tier) && outsideCooldown) {
      await prisma.attention.update({ where: { id: row.id }, data: { lastFiredAt: now } })
      fired.push({ machineId, type, targetKey })
      changed = true
    }
  }

  // Clear any active attention this ingest's sessions no longer report (episode ended without an
  // explicit `cleared`, e.g. the pane closed). Scoped to reportedSids: an attention whose session
  // wasn't in this ingest belongs to another plugin instance and is left untouched (no clobber).
  const active = await prisma.attention.findMany({ where: { accountId, machineId, state: 'active' } })
  for (const row of active) {
    if (reportedSids) {
      const rowSid = row.targetKey.slice(0, row.targetKey.indexOf(':'))
      if (!reportedSids.has(rowSid)) continue // owned by a different session's plugin instance
    }
    if (!seen.has(`${row.targetKey}:${row.type}`)) {
      await prisma.attention.delete({ where: { id: row.id } })
      changed = true
    }
  }

  return { changed, fired }
}
