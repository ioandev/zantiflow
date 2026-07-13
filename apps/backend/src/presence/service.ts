// Viewer presence (ADR-0026) — in-process, single-backend (mirrors the SSE bus; no Redis, ADR-0019).
// The plugin sends snapshots at a livelier cadence only while a dashboard is watching, and it learns
// that from the control channel's `viewers.active`. "Watching" = a live SSE stream is open OR a viewer
// signal was seen within a short TTL. The TTL covers two cases the raw SSE count misses: an SSE
// reconnect blip (the count momentarily drops to 0) and a browser on the polling fallback (no SSE at
// all, ADR-0008). It also tracks a per-machine refresh sequence the manual refresh button bumps.
import type { SseBus } from '../sse/bus'

/** How long after the last viewer signal an account still counts as "watching" (ADR-0026). Must
 *  exceed the 25 s SSE heartbeat so an idle-but-open tab and reconnect blips don't flap the plugin. */
export const PRESENCE_TTL_MS = 45_000

// Coarse overflow guards so a flood of distinct ids can't grow these maps without bound (mirrors the
// rate limiter). Clearing is safe: presence simply falls back to the live SSE count until re-marked.
const MAX_ENTRIES = 100_000

export interface Presence {
  /** Record a viewer signal for an account (SSE subscribe/heartbeat, owner read). */
  markViewer(accountId: string): void
  /** Is a dashboard watching this account? Live SSE stream OR a viewer signal within the TTL. */
  isWatching(accountId: string): boolean
  /** Bump a machine's refresh sequence (manual refresh button); returns the new value. */
  bumpRefresh(machineId: string): number
  /** A machine's current refresh sequence (0 if never refreshed). */
  refreshSeq(machineId: string): number
}

export const createPresence = (bus: SseBus, opts?: { now?: () => number }): Presence => {
  const now = opts?.now ?? Date.now
  const lastViewerAt = new Map<string, number>()
  const refresh = new Map<string, number>()

  return {
    markViewer(accountId) {
      if (lastViewerAt.size >= MAX_ENTRIES) lastViewerAt.clear()
      lastViewerAt.set(accountId, now())
    },
    isWatching(accountId) {
      if (bus.countFor(accountId) > 0) return true
      const seen = lastViewerAt.get(accountId)
      return seen !== undefined && now() - seen < PRESENCE_TTL_MS
    },
    bumpRefresh(machineId) {
      if (refresh.size >= MAX_ENTRIES) refresh.clear()
      const next = (refresh.get(machineId) ?? 0) + 1
      refresh.set(machineId, next)
      return next
    },
    refreshSeq(machineId) {
      return refresh.get(machineId) ?? 0
    },
  }
}
