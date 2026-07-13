// Machine-level `claude.idle` attention (ADR-0027) — the first BACKEND-DERIVED attention. It fires when
// EVERY Claude pane on a machine has produced no output for longer than the tier threshold (1 min pro /
// 5 min free), i.e. "all your Claude agents on this machine have gone quiet — go check them".
//
// Why backend-derived + swept, not plugin-emitted (ADR-0027 §Context):
//  - Ingest is PER-SESSION: each Zellij session's plugin instance reports only its own session, so no
//    single instance can observe "ALL sessions". Only the backend, which unions every session's slice,
//    can evaluate the machine-wide predicate.
//  - Under ADR-0026 the plugin STOPS sending once a session is idle+unwatched with no active attention
//    (the SendGate keepalive is gated on an active attention, and `claude.idle` is backend-derived so it
//    can't keep the plugin alive). So the condition must be evaluated on a backend TIMER (`sweepClaudeIdle`),
//    not at ingest time — an ingest-time hook would never observe the idle window when nobody is watching.
//
// The silence clock is the backend-derived per-pane `PaneActivity.entry.updatedAt` (machines/activity.ts):
// a thinking Claude pane repaints its spinner every tick → fingerprint changes → fresh → NOT idle; a
// finished pane freezes → `now - updatedAt` grows → idle after the threshold. A quiet-but-live session's
// rows stay inside the `STALE_AFTER_MS` window via ADR-0026's ~5s control-poll liveness touch, while a
// genuinely closed session ages out — so filtering to non-stale rows distinguishes idle (fire) from
// closed (drop, no false positive). All queries are scoped by `accountId` (IDOR).
import type { PrismaClient } from '@prisma/client'
import type { Attention as WireAttention } from '@zantiflow/protocol'
import { type ActivityMap, asActivityMap, paneKeyOf } from '../machines/activity'
import { STALE_AFTER_MS } from '../machines/service'
import { createForFired } from '../notifications/service'
import { effectiveTier } from '../tiers/service'
import type { SseBus } from '../sse/bus'
import { processAttentions } from './service'

/** The machine-scoped attention type (an open string on the wire — no contract bump, ADR-0027 §7). */
export const IDLE_TYPE = 'claude.idle'
/** Machine-scoped "the whole machine stopped reporting" attention (ADR-0028). Backend-derived from
 *  `Machine.lastSeenAt` staleness — the ADR-0005 §5 machine-offline signal, finally implemented. */
export const MACHINE_OFFLINE_TYPE = 'machine.offline'
// Only raise `machine.offline` for a machine seen within this window — a machine that went quiet just
// now is "it disconnected"; one last seen hours ago is stale news we don't want to notify about (and
// avoids a burst for long-dead machines on first run).
const OFFLINE_LOOKBACK_MS = 15 * 60_000

/** Which panes must be silent for the machine to count as idle. Default: only panes running `claude`. */
export type PaneScope = 'claude-only' | 'claude-sessions' | 'all'
const DEFAULT_SCOPE: PaneScope = 'claude-only'

/** Case-insensitive `claude` command match — mirrors the plugin's `is_claude_command` (attentions.rs). */
export const isClaudeCommand = (command: string | null | undefined): boolean =>
  !!command && command.toLowerCase().includes('claude')

// Tolerant readers over the stored wire-v4 slice blob (JSON column, typed `unknown`).
interface StoredPane {
  id?: number
  command?: string | null
  exited?: boolean
}
interface StoredTab {
  tabId?: number
  panes?: StoredPane[]
}
interface StoredSession {
  sid?: string
  tabs?: StoredTab[]
}

/**
 * Enumerate the `sid:tabId:paneId` keys that must be silent for the machine to be idle, per `scope`.
 * Exited panes are excluded (a terminated process is not "idle-but-alive"). Keys match the
 * `PaneActivity` map keys exactly (`paneKeyOf`), so the caller can join the two.
 */
export const watchedPaneKeys = (sessions: StoredSession[], scope: PaneScope = DEFAULT_SCOPE): string[] => {
  const keys: string[] = []
  for (const s of sessions) {
    const sid = s.sid
    if (typeof sid !== 'string') continue
    const tabs = s.tabs ?? []
    // For 'claude-sessions', a session counts only if it holds at least one live claude pane.
    const sessionHasClaude =
      scope !== 'claude-sessions' ||
      tabs.some((t) => (t.panes ?? []).some((p) => !p.exited && isClaudeCommand(p.command)))
    for (const t of tabs) {
      const tabId = t.tabId
      if (typeof tabId !== 'number') continue
      for (const p of t.panes ?? []) {
        if (typeof p.id !== 'number' || p.exited) continue
        const include =
          scope === 'all' ? true : scope === 'claude-sessions' ? sessionHasClaude : isClaudeCommand(p.command)
        if (include) keys.push(paneKeyOf(sid, tabId, p.id))
      }
    }
  }
  return keys
}

/** Tier-aware idle threshold (ADR-0027): 1 min pro / 5 min free. The ONLY place these numbers live. */
export const idleThresholdSeconds = (tier: string): number => (tier === 'pro' ? 60 : 300)

/**
 * PURE: is the machine "all Claude idle" right now? `'active'` iff there is at least one watched pane and
 * EVERY watched pane is provably idle (`now - updatedAt >= thresholdSec`). Conservative false-negatives:
 * a pane with no activity entry, or one never observed to change (`updatedAt === null`), counts as
 * not-idle so a just-opened or already-frozen pane can't produce a spurious fire.
 */
export const computeMachineIdle = (
  watchedKeys: string[],
  activity: ActivityMap,
  now: Date,
  thresholdSec: number,
): 'active' | 'cleared' => {
  if (watchedKeys.length === 0) return 'cleared'
  for (const key of watchedKeys) {
    const updatedAt = activity[key]?.updatedAt
    if (!updatedAt) return 'cleared' // missing entry or never-changed (Unknown) → not provably idle
    if (now.getTime() - new Date(updatedAt).getTime() < thresholdSec * 1000) return 'cleared'
  }
  return 'active'
}

/**
 * Evaluate the machine's current idle state from its persisted, NON-STALE per-session slices + activity
 * maps (unioned across sessions), and return the synthetic wire attention to feed the episode engine.
 * State is machine-wide even though ingest is per-session — that's the whole point (ADR-0027 §1).
 */
export const evaluateMachineIdle = async (
  prisma: PrismaClient,
  accountId: string,
  machineId: string,
  tier: string,
  now: Date = new Date(),
): Promise<WireAttention> => {
  const staleAt = new Date(now.getTime() - STALE_AFTER_MS)
  const [slices, actRows] = await Promise.all([
    prisma.snapshot.findMany({
      where: { accountId, machineId, receivedAt: { gt: staleAt } },
      select: { data: true },
    }),
    prisma.paneActivity.findMany({
      where: { accountId, machineId, updatedAt: { gt: staleAt } },
      select: { activity: true },
    }),
  ])
  const sessions = slices.flatMap((r) => (r.data as { sessions?: StoredSession[] } | null)?.sessions ?? [])
  const activity: ActivityMap = {}
  for (const a of actRows) Object.assign(activity, asActivityMap(a.activity))

  const state = computeMachineIdle(watchedPaneKeys(sessions), activity, now, idleThresholdSeconds(tier))
  return { type: IDLE_TYPE, target: { machineId }, state, since: 0 }
}

// The reportedSids used by the sweep. A machine-level target's `targetKey` is `"::"` whose leading sid is
// `""`, so `new Set([''])` scopes `processAttentions`'s end-of-tick clear to ONLY machine-level rows —
// it never touches per-session attentions (needs-input/thinking/detached) owned by the ingest path.
const MACHINE_SCOPE_SIDS = new Set([''])

/**
 * The timer body (mirrors the entrypoint dispatch/prune sweeps). For every recently-seen machine,
 * evaluate BOTH machine-level attentions and drive them through the episode engine in ONE call:
 *  - `machine.offline` (ADR-0028): active iff the machine has stopped reporting past `STALE_AFTER_MS`
 *    (backend clock — the plugin can't tell you it died). Fires once per disconnect (large cooldown),
 *    clears when it comes back.
 *  - `claude.idle` (ADR-0027): only meaningful while the machine is online; an offline machine's idle
 *    state is unknowable, so it is forced cleared.
 * Both are emitted together because they share the machine-level `targetKey` `"::"`, and the
 * `MACHINE_SCOPE_SIDS` clear would otherwise delete whichever one wasn't reported this pass.
 * Fired episodes enqueue durable notifications; a change publishes to live dashboards. Per-machine
 * failures are isolated so one bad machine can't abort the sweep.
 */
export const sweepMachineAttentions = async (
  prisma: PrismaClient,
  bus: SseBus,
  now: Date = new Date(),
): Promise<void> => {
  // Consider machines seen within the lookback window (online + freshly-disconnected). Anything older
  // has already had its one offline notification (or predates the feature) and is left alone.
  const lookbackAt = new Date(now.getTime() - OFFLINE_LOOKBACK_MS)
  const machines = await prisma.machine.findMany({
    where: { lastSeenAt: { gt: lookbackAt } },
    select: { id: true, accountId: true, lastSeenAt: true },
  })
  if (machines.length === 0) return

  // One tier lookup per distinct account (no relations in the schema — join in memory).
  const accountIds = [...new Set(machines.map((m) => m.accountId))]
  const accounts = await prisma.account.findMany({
    where: { id: { in: accountIds } },
    select: { id: true, tier: true, tierExpiresAt: true },
  })
  const tierOf = new Map(accounts.map((a) => [a.id, effectiveTier(a, now)]))

  for (const m of machines) {
    try {
      const tier = tierOf.get(m.accountId) ?? 'free'
      const offline = now.getTime() - m.lastSeenAt.getTime() > STALE_AFTER_MS
      const idle: WireAttention = offline
        ? { type: IDLE_TYPE, target: { machineId: m.id }, state: 'cleared', since: 0 }
        : await evaluateMachineIdle(prisma, m.accountId, m.id, tier, now)
      const offlineAttn: WireAttention = {
        type: MACHINE_OFFLINE_TYPE,
        target: { machineId: m.id },
        state: offline ? 'active' : 'cleared',
        since: 0,
      }
      const { changed, fired } = await processAttentions(
        prisma,
        m.accountId,
        m.id,
        [idle, offlineAttn],
        tier,
        now,
        MACHINE_SCOPE_SIDS,
      )
      if (changed) bus.publish(m.accountId, { event: 'attention.update', data: { machineId: m.id } })
      if (fired.length > 0) await createForFired(prisma, m.accountId, tier, fired)
    } catch {
      // Isolate per-machine failures; the caller logs the sweep-level error if the whole pass throws.
    }
  }
}
