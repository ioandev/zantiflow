// The always-on control channel (ADR-0026), token plane — the plugin's ~5 s poll, decoupled from the
// snapshot cadence. It does two things: (1) LIVENESS TOUCH — stamp the machine's `lastSeenAt` and the
// `receivedAt` of every reported session's slice so a quiet-but-live session stays fresh under the
// existing 60 s read-filter (`machines/service.ts`) while a genuinely-closed session — whose instance
// stops polling — ages out on its own; and (2) return the pending pane-output requests for this
// machine + whether a dashboard is watching + the machine's refresh sequence. NOTHING here writes the
// ingest tree — that stays on the (now change-driven) snapshot POST.
import type { PrismaClient } from '@prisma/client'
import type { ControlResponse } from '@zantiflow/protocol'
import { pendingRequests } from '../output/service'
import type { Presence } from '../presence/service'
import { effectiveTier, type Tier } from '../tiers/service'
import type { ControlWaiters } from './waiters'

/** Upper bound on how long a long-poll response is held (ADR-0029). Must stay below the 60 s
 *  read-filter so the liveness touch (which happens once per request) can't lapse, and comfortably
 *  under typical proxy read timeouts. Requests asking for longer are clamped to this. */
export const MAX_WAIT_MS = 25_000

/** Tier-paced heartbeat interval handed to the plugin (ADR-0051): how long it may stay send-silent
 *  before re-affirming its state with a full snapshot. Server-owned so tier changes (promo expiry)
 *  apply on the next control poll with no plugin involvement. */
export const HEARTBEAT_SEC_PRO = 30
export const HEARTBEAT_SEC_FREE = 300

export const heartbeatSeconds = (tier: Tier): number => (tier === 'pro' ? HEARTBEAT_SEC_PRO : HEARTBEAT_SEC_FREE)

/**
 * Handle one control poll. Returns null when the machine is not owned by the token's account
 * (IDOR/hijack guard → 403), mirroring the pane-output plane. Scoped by `accountId` throughout.
 *
 * `waitMs > 0` opts into long-poll (ADR-0029): after the (always-immediate) liveness touch, if there
 * is nothing pending to act on, the response is held on `waiters` until a pane-output request or a
 * refresh bump wakes it, or the clamped timeout fires. `waitMs` omitted/0 returns straight away — the
 * default ~5 s-poll behaviour, unchanged.
 */
export const handleControl = async (
  prisma: PrismaClient,
  presence: Presence,
  waiters: ControlWaiters,
  accountId: string,
  machineId: string,
  liveSids: string[],
  waitMs = 0,
  now: Date = new Date(),
): Promise<ControlResponse | null> => {
  // A token may only touch its own account's machine — never register/hijack another's (audit B7).
  const owned = await prisma.machine.findFirst({ where: { id: machineId, accountId }, select: { id: true } })
  if (!owned) return null

  // The account's tier prices the heartbeat interval (ADR-0051); a missing row (never expected —
  // the token FK guarantees the account) degrades to the free interval rather than failing the poll.
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { tier: true, tierExpiresAt: true },
  })
  const heartbeatSec = heartbeatSeconds(account ? effectiveTier(account, now) : 'free')

  // Liveness touch. `Machine.lastSeenAt` keeps the machine "online"; `Snapshot.receivedAt` keeps each
  // still-reported session inside the read-filter without re-sending the whole tree; `PaneActivity`
  // has an `@updatedAt` column, so an idempotent `accountId` set is how we bump its timestamp (there
  // is no dedicated touch field) — this keeps the per-pane activity map visible for a quiet session.
  await prisma.$transaction([
    prisma.machine.updateMany({ where: { id: machineId, accountId }, data: { lastSeenAt: now } }),
    ...(liveSids.length > 0
      ? [
          prisma.snapshot.updateMany({
            where: { machineId, accountId, sid: { in: liveSids } },
            data: { receivedAt: now },
          }),
          prisma.paneActivity.updateMany({
            where: { machineId, accountId, sid: { in: liveSids } },
            data: { accountId }, // no-op value → bumps @updatedAt (see comment above)
          }),
        ]
      : []),
  ])

  // Only this machine's pending output (the plugin for machine X must not act on machine Y's requests).
  const compute = async (at: Date): Promise<ControlResponse> => ({
    pendingOutput: (await pendingRequests(prisma, accountId, at)).filter((r) => r.machineId === machineId),
    viewers: { active: presence.isWatching(accountId) },
    refreshSeq: presence.refreshSeq(machineId),
    heartbeatSec,
  })

  const result = await compute(now)
  // Long-poll (ADR-0029): hold the response only when the caller opted in AND there is nothing to act
  // on yet. On wake (a new request / refresh, or the clamped timeout) recompute once with a fresh clock
  // and return — it may still be empty on a pure timeout, which is fine: the plugin simply re-polls.
  if (waitMs > 0 && result.pendingOutput.length === 0) {
    await waiters.wait(machineId, Math.min(waitMs, MAX_WAIT_MS))
    return compute(new Date())
  }
  return result
}
