// Spotlight roster (ADR-0016) — the account's ACTIVE Claude sessions across ALL its machines, for the
// PRO-only live album. "Active" = a pane in a LIVE session that is not `exited` and runs Claude
// (shared marker/command detection — @zantiflow/protocol, the reliable NAME marker, because a pane's
// `command` is often null). The backend is STATELESS here: it returns only what's active right now;
// "completed" sessions (kept in the album until cleared) are tracked client-side by diffing successive
// rosters. Every query is scoped by `accountId` (IDOR is the top bug class). A machine's slices age out
// of the read past STALE_AFTER_MS, so an offline machine's Claudes drop from the roster (→ completed).
import type { PrismaClient } from '@prisma/client'
import { isClaudePane, isThinkingMarker, type Session } from '@zantiflow/protocol'
import { activityToWire, asActivityMap } from '../machines/activity'
import { STALE_AFTER_MS } from '../machines/service'

// A spinner glyph alone can't mean "thinking": Claude Code leaves the last frame FROZEN in a finished
// background pane's title, so `isThinkingMarker` stays true long after the turn ends. We gate it on
// recent output — a marked pane counts as thinking only while its last observed change is fresh. The
// window is generous vs the ADR-0026 send floor (a live turn's output coalesces to ≤~15 s/send, so it
// won't flicker between sends) yet under STALE_AFTER_MS, so a finished pane's "thinking" clears before
// it ages out of the roster.
const THINKING_FRESH_MS = 45_000
const recentlyActive = (iso: string | null, now: Date): boolean =>
  iso !== null && now.getTime() - new Date(iso).getTime() < THINKING_FRESH_MS

export interface SpotlightSession {
  key: string // stable pane identity: machineId:sid:tabId:paneId
  machineId: string
  machineName: string | null // machine displayName; null = hidden
  sessionSid: string
  sessionName: string | null
  tabId: number
  tabName: string | null
  paneId: number
  paneName: string | null
  command: string | null
  thinking: boolean // Braille spinner marker → a turn is in flight (immediate, unlike the gated attention)
  updatedAt: string | null // last observed output change (ISO), or null = never observed ("Unknown")
}

export const activeClaudeSessions = async (
  prisma: PrismaClient,
  accountId: string,
  now: Date = new Date(),
): Promise<SpotlightSession[]> => {
  const staleAt = new Date(now.getTime() - STALE_AFTER_MS)
  // Batched, account-scoped reads (no N+1, mirrors listMachines): machine names, non-stale per-session
  // snapshot slices, and non-stale per-session activity maps.
  const [machines, snaps, acts] = await Promise.all([
    prisma.machine.findMany({ where: { accountId }, select: { id: true, displayName: true } }),
    prisma.snapshot.findMany({
      where: { accountId, receivedAt: { gt: staleAt } },
      select: { machineId: true, data: true },
    }),
    prisma.paneActivity.findMany({
      where: { accountId, updatedAt: { gt: staleAt } },
      select: { machineId: true, activity: true },
    }),
  ])

  const nameById = new Map(machines.map((m) => [m.id, m.displayName]))
  // Union each machine's per-session slices → its full session list (each slice is one Zellij session).
  const sessionsByMachine = new Map<string, Session[]>()
  for (const s of snaps) {
    // The stored blob is a validated wire-v4 snapshot (ingest boundary) → treat its sessions as typed.
    const data = s.data as unknown as { sessions?: Session[] } | null
    if (!data?.sessions) continue
    const arr = sessionsByMachine.get(s.machineId) ?? []
    arr.push(...data.sessions)
    sessionsByMachine.set(s.machineId, arr)
  }
  // Union each machine's per-session activity maps → paneKey → last-changed ISO.
  const activityByMachine = new Map<string, Record<string, string>>()
  for (const a of acts) {
    const merged = activityByMachine.get(a.machineId) ?? {}
    Object.assign(merged, activityToWire(asActivityMap(a.activity)))
    activityByMachine.set(a.machineId, merged)
  }

  const out: SpotlightSession[] = []
  for (const [machineId, sessions] of sessionsByMachine) {
    const activity = activityByMachine.get(machineId) ?? {}
    for (const session of sessions) {
      if (session.state !== 'live') continue
      for (const tab of session.tabs) {
        for (const pane of tab.panes) {
          if (pane.exited || !isClaudePane(pane)) continue
          const paneKey = `${session.sid}:${tab.tabId}:${pane.id}`
          const updatedAt = activity[paneKey] ?? null
          out.push({
            key: `${machineId}:${paneKey}`,
            machineId,
            machineName: nameById.get(machineId) ?? null,
            sessionSid: session.sid,
            sessionName: session.name,
            tabId: tab.tabId,
            tabName: tab.name,
            paneId: pane.id,
            paneName: pane.name,
            command: pane.command,
            // Spinner marker AND still producing output — a frozen glyph on a finished pane clears.
            thinking: isThinkingMarker(pane.name) && recentlyActive(updatedAt, now),
            updatedAt,
          })
        }
      }
    }
  }
  // Deterministic order so the album's initial layout is stable across reloads.
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return out
}
