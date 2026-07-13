// Read/manage the owner's machines (ADR-0008). EVERY query is scoped by `accountId` at the data
// layer — a caller can only ever see or forget their own machines (IDOR is the top bug class).
// The list is enriched to what the dashboard card needs (ADR-0008 §2 / ADR-0016 §A): live/stale,
// hostname mode + privacy level, sessions/tabs/panes counts, and an active-attention count. The
// detail adds the derived per-pane activity map (paneKey → last-changed ISO).
import type { PrismaClient } from '@prisma/client'
import { notFound } from '../http/errors'
import type { PaneOutputStore } from '../output/store'
import { type ActivityMap, activityToWire, asActivityMap } from './activity'

/** A machine is "live" if we've received a snapshot within this window, else "stale" (ADR-0008 §2).
 *  The plugin reports ~every second, so a minute of silence is a closed laptop or a network gap. */
export const STALE_AFTER_MS = 60_000

const isOnline = (lastSeenAt: Date, now: Date): boolean => now.getTime() - lastSeenAt.getTime() <= STALE_AFTER_MS

export interface MachinePrivacy {
  source: 'real' | 'alias' | 'hidden'
  level: 'full' | 'restricted'
}
export interface MachineCounts {
  sessions: number
  tabs: number
  panes: number
}

// Tolerant readers over the stored wire-v4 snapshot blob (JSON column, typed `unknown`).
interface StoredPrivacy {
  full?: boolean
  machine?: string
  sessionNames?: string
  tabNames?: string
  paneNames?: string
}
interface StoredSnapshot {
  privacy?: StoredPrivacy
  machine?: { source?: string }
  sessions?: { tabs?: { panes?: unknown[] }[] }[]
  attentions?: unknown[]
}

/** One stored per-session slice as read back for merging. */
interface SnapshotSlice {
  data: StoredSnapshot | null
  receivedAt: Date
  capturedAtTick: number
}

/**
 * Reconstruct a machine's wire-v4 view from its per-session slices (ADR-0008): UNION every slice's
 * `sessions` (and `attentions`), and take the machine-level fields (privacy, machine identity, version)
 * from the FRESHEST slice. Callers pass only non-stale rows, so a session gone quiet simply drops out.
 */
export const mergeSlices = (
  rows: SnapshotSlice[],
): { data: StoredSnapshot | null; receivedAt: Date | null; capturedAtTick: number | null } => {
  if (rows.length === 0) return { data: null, receivedAt: null, capturedAtTick: null }
  const sorted = [...rows].sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
  const freshest = sorted[0]
  const sessions = sorted.flatMap((r) => r.data?.sessions ?? [])
  const attentions = sorted.flatMap((r) => r.data?.attentions ?? [])
  const data: StoredSnapshot = { ...(freshest.data ?? {}), sessions, attentions }
  return { data, receivedAt: freshest.receivedAt, capturedAtTick: freshest.capturedAtTick }
}

const privacyOf = (data: StoredSnapshot | null): MachinePrivacy | null => {
  const p = data?.privacy
  const source = (data?.machine?.source ?? p?.machine) as MachinePrivacy['source'] | undefined
  if (source !== 'real' && source !== 'alias' && source !== 'hidden') return null
  // "full" only when the master flag is on AND no name category is redacted; anything else is
  // "restricted" (the design's "privacy: restricted (all names)" badge).
  const level: MachinePrivacy['level'] =
    p?.full && p.sessionNames === 'send' && p.tabNames === 'send' && p.paneNames === 'send' ? 'full' : 'restricted'
  return { source, level }
}

const countsOf = (data: StoredSnapshot | null): MachineCounts | null => {
  const sessions = data?.sessions
  if (!Array.isArray(sessions)) return null
  let tabs = 0
  let panes = 0
  for (const s of sessions) {
    for (const t of s.tabs ?? []) {
      tabs++
      panes += t.panes?.length ?? 0
    }
  }
  return { sessions: sessions.length, tabs, panes }
}

// `claude.thinking` means "Claude is busy", not "needs you" (ADR-0025) → counted on its own axis and
// kept out of the needs-attention total.
const THINKING_TYPE = 'claude.thinking'
// `machine.offline` (ADR-0028) is already surfaced as the machine's stale/offline state, so it is kept
// out of the "N need attention" total (it would just double-report the disconnect).
const OFFLINE_TYPE = 'machine.offline'

export interface MachineSummary {
  id: string
  displayName: string | null
  tokenId: string | null // ingest token that last pushed for this machine; null = unlinked
  firstSeenAt: Date
  lastSeenAt: Date
  online: boolean
  privacy: MachinePrivacy | null
  counts: MachineCounts | null
  attentionCount: number // active attentions that need the user (excludes thinking)
  thinkingCount: number // active claude.thinking attentions
}

export const listMachines = async (prisma: PrismaClient, accountId: string): Promise<MachineSummary[]> => {
  const now = new Date()
  const staleAt = new Date(now.getTime() - STALE_AFTER_MS)
  // Three account-scoped reads instead of N+1: machines, their non-stale per-session snapshot slices,
  // and active attentions grouped by (machine, type) so we can split "needs you" from "thinking".
  const [machines, snaps, attn] = await Promise.all([
    prisma.machine.findMany({ where: { accountId }, orderBy: { lastSeenAt: 'desc' } }),
    prisma.snapshot.findMany({
      where: { accountId, receivedAt: { gt: staleAt } },
      select: { machineId: true, data: true, receivedAt: true, capturedAtTick: true },
    }),
    prisma.attention.groupBy({
      by: ['machineId', 'type'],
      where: { accountId, state: 'active' },
      _count: { _all: true },
    }),
  ])
  // Group the per-session slices by machine, then merge each into one machine view.
  const rowsByMachine = new Map<string, SnapshotSlice[]>()
  for (const s of snaps) {
    const arr = rowsByMachine.get(s.machineId) ?? []
    arr.push({ data: s.data as StoredSnapshot | null, receivedAt: s.receivedAt, capturedAtTick: s.capturedAtTick })
    rowsByMachine.set(s.machineId, arr)
  }
  const snapById = new Map([...rowsByMachine].map(([id, rows]) => [id, mergeSlices(rows).data]))
  const needsById = new Map<string, number>()
  const thinkingById = new Map<string, number>()
  for (const a of attn) {
    if (a.type === OFFLINE_TYPE) continue
    const map = a.type === THINKING_TYPE ? thinkingById : needsById
    map.set(a.machineId, (map.get(a.machineId) ?? 0) + a._count._all)
  }

  return machines.map((m) => {
    const data = snapById.get(m.id) ?? null
    return {
      id: m.id,
      displayName: m.displayName,
      tokenId: m.tokenId,
      firstSeenAt: m.firstSeenAt,
      lastSeenAt: m.lastSeenAt,
      online: isOnline(m.lastSeenAt, now),
      privacy: privacyOf(data),
      counts: countsOf(data),
      attentionCount: needsById.get(m.id) ?? 0,
      thinkingCount: thinkingById.get(m.id) ?? 0,
    }
  })
}

export interface MachineDetail extends MachineSummary {
  snapshot: unknown | null // latest wire-v4 snapshot payload, or null if none received yet
  capturedAtTick: number | null
  receivedAt: Date | null
  activity: Record<string, string> // paneKey (sid:tabId:paneId) → last-changed ISO; absent = Unknown
}

export const getMachine = async (prisma: PrismaClient, accountId: string, id: string): Promise<MachineDetail> => {
  // Scope by BOTH id and accountId → a machine owned by another account reads as "not found".
  const machine = await prisma.machine.findFirst({ where: { id, accountId } })
  if (!machine) throw notFound('machine_not_found')
  const staleAt = new Date(Date.now() - STALE_AFTER_MS)
  const [snapRows, actRows, attn] = await Promise.all([
    prisma.snapshot.findMany({
      where: { machineId: id, accountId, receivedAt: { gt: staleAt } },
      select: { data: true, receivedAt: true, capturedAtTick: true },
    }),
    // `accountId` is redundant with the ownership check above (machineId is a global PK), but we scope
    // it explicitly so tenant isolation never depends on an upstream guard — every sibling query does.
    prisma.paneActivity.findMany({
      where: { machineId: id, accountId, updatedAt: { gt: staleAt } },
      select: { activity: true },
    }),
    prisma.attention.groupBy({
      by: ['type'],
      where: { accountId, machineId: id, state: 'active' },
      _count: { _all: true },
    }),
  ])
  let attentionCount = 0
  let thinkingCount = 0
  for (const g of attn) {
    if (g.type === OFFLINE_TYPE) continue
    if (g.type === THINKING_TYPE) thinkingCount += g._count._all
    else attentionCount += g._count._all
  }
  // Reconstruct the machine's view from its live sessions' slices; union their per-session activity
  // maps (paneKeys are globally unique — sid:tabId:paneId — so a plain merge is safe).
  const merged = mergeSlices(
    snapRows.map((r) => ({
      data: r.data as StoredSnapshot | null,
      receivedAt: r.receivedAt,
      capturedAtTick: r.capturedAtTick,
    })),
  )
  const data = merged.data
  const activityMap: ActivityMap = {}
  for (const a of actRows) Object.assign(activityMap, asActivityMap(a.activity))
  return {
    id: machine.id,
    displayName: machine.displayName,
    tokenId: machine.tokenId,
    firstSeenAt: machine.firstSeenAt,
    lastSeenAt: machine.lastSeenAt,
    online: isOnline(machine.lastSeenAt, new Date()),
    privacy: privacyOf(data),
    counts: countsOf(data),
    attentionCount,
    thinkingCount,
    snapshot: data,
    capturedAtTick: merged.capturedAtTick,
    receivedAt: merged.receivedAt,
    activity: activityToWire(activityMap),
  }
}

/** Forget a machine and all of its derived data. Scoped by accountId (IDOR); 404 if not owned. */
export const forgetMachine = async (
  prisma: PrismaClient,
  outputStore: PaneOutputStore,
  accountId: string,
  id: string,
): Promise<void> => {
  const machine = await prisma.machine.findFirst({ where: { id, accountId } })
  if (!machine) throw notFound('machine_not_found')
  await prisma.$transaction([
    prisma.snapshot.deleteMany({ where: { machineId: id, accountId } }),
    prisma.paneActivity.deleteMany({ where: { machineId: id, accountId } }),
    prisma.attention.deleteMany({ where: { machineId: id, accountId } }),
    prisma.outputRequest.deleteMany({ where: { machineId: id, accountId } }),
    prisma.machine.deleteMany({ where: { id, accountId } }),
  ])
  // Pane output lives only in memory (ADR-0032) — purge this machine's captures immediately so a
  // forget leaves nothing behind, rather than waiting for the retention sweep.
  outputStore.deleteMachine(accountId, id)
}
