// Persist an ingested snapshot (ADR-0003 §3, ADR-0008). PER-SESSION, latest-only: Zellij delivers
// only the current session to a plugin, so each Zellij session's plugin instance reports just its own
// session. We store ONE row per reported session, keyed by (machineId, sid), so concurrent instances
// on the same machine never clobber each other — the machine view is the UNION on read. The machine
// is auto-registered on first ingest. A machineId owned by ANOTHER account is refused — a token can
// never hijack another account's machine (audit B7); within an account, any token may write any machineId.
import { Prisma, type PrismaClient } from '@prisma/client'
import type { SnapshotV4 } from '@zantiflow/protocol'
import { forbidden } from '../http/errors'
import { asActivityMap, deriveActivity } from '../machines/activity'

/** Returns the sids this ingest reported, so the caller can scope attention reconciliation to them. */
export const storeSnapshot = async (
  prisma: PrismaClient,
  accountId: string,
  tokenId: string,
  snapshot: SnapshotV4,
): Promise<{ sids: string[] }> => {
  const machineId = snapshot.machineId
  const displayName = snapshot.machine.name // nullable; null = redacted/<hidden>
  const now = new Date()
  const sids = snapshot.sessions.map((s) => s.sid)

  await prisma.$transaction(async (tx) => {
    const existing = await tx.machine.findUnique({ where: { id: machineId }, select: { accountId: true } })
    // Refuse with a GENERIC 403 (identical to the control/output planes): never disclose *why* — i.e.
    // don't reveal "this machineId belongs to another account". machineIds are unguessable 256-bit
    // secrets never shown to non-owners, so this refusal leaks nothing an attacker can reach or use.
    if (existing && existing.accountId !== accountId) throw forbidden()

    await tx.machine.upsert({
      where: { id: machineId },
      // Record which ingest token last pushed for this machine (ADR-0003) so the /tokens page can
      // group machines under their token and offer combined revoke + forget. Never changes accountId.
      create: { id: machineId, accountId, tokenId, displayName, firstSeenAt: now, lastSeenAt: now },
      update: { displayName, lastSeenAt: now, tokenId },
    })

    for (const session of snapshot.sessions) {
      const sid = session.sid
      // A wire-v4 slice scoped to this session: machine-level fields + only this session (and only
      // its attentions). The read reconstructs the machine by unioning slices (freshest wins for the
      // machine-level fields). Each instance touches only its own sid rows → no cross-instance clobber.
      const slice: SnapshotV4 = {
        ...snapshot,
        sessions: [session],
        attentions: snapshot.attentions.filter((a) => (a.target.sessionSid ?? '') === sid),
      }
      const data = slice as unknown as Prisma.InputJsonValue
      await tx.snapshot.upsert({
        where: { machineId_sid: { machineId, sid } },
        create: { machineId, sid, accountId, version: snapshot.version, capturedAtTick: snapshot.capturedAtTick, data },
        update: { version: snapshot.version, capturedAtTick: snapshot.capturedAtTick, data, receivedAt: now },
      })

      // Derive this session's per-pane "last updated" by diffing its fingerprints against its own
      // prior row (ADR-0001 §4). Per-session row → an instance only rewrites its own panes.
      const prevActivity = await tx.paneActivity.findUnique({
        where: { machineId_sid: { machineId, sid } },
        select: { activity: true },
      })
      const nextActivity = deriveActivity(asActivityMap(prevActivity?.activity), slice, now)
      const activityJson = nextActivity as unknown as Prisma.InputJsonValue
      await tx.paneActivity.upsert({
        where: { machineId_sid: { machineId, sid } },
        create: { machineId, sid, accountId, activity: activityJson },
        update: { activity: activityJson },
      })
    }
  })
  return { sids }
}
