// Tier-gated auto-refresh window for the pane-output drawer (ADR-0016). While the dashboard drawer is
// open it AUTO-REFRESHES a pane's captured output; PRO accounts refresh indefinitely, FREE accounts
// refresh only for a bounded window (FREE_AUTO_REFRESH_SEC) after which the drawer must be manually
// resumed — a human gesture. This registry is the SERVER-SIDE enforcement of that limit: it decides
// whether each automatic refresh tick may proceed, so a free client can't bypass the UI and stream
// output forever. In-process + single-backend, exactly like presence/waiters (no Redis, ADR-0019);
// the state is ephemeral coordination — a window lost on restart just grants the next tick a fresh
// one, which is harmless (the request still requires an authenticated owner session).
import type { Tier } from '../tiers/service'

/** FREE-tier auto-refresh window: how long the drawer may auto-refresh before a manual resume is
 *  required. PRO is unbounded. The client runs the same budget; this is the authoritative gate. */
export const FREE_AUTO_REFRESH_SEC = 60

/** Coarse overflow guard (mirrors presence): a flood of distinct panes can't grow the map without
 *  bound. Clearing is safe — a dropped window just grants the next tick a fresh one. */
const MAX_ENTRIES = 100_000

export interface AutoRefreshLimiter {
  /** A human gesture (drawer open or "resume"): (re)start the auto-refresh window for `key`. */
  start(key: string): void
  /** An automatic refresh tick for `key`: may it proceed at this tier? PRO is always allowed; FREE is
   *  allowed until FREE_AUTO_REFRESH_SEC past the window start (a missing window starts one now). */
  allow(key: string, tier: Tier): boolean
}

export const createAutoRefreshLimiter = (opts?: { now?: () => number }): AutoRefreshLimiter => {
  const now = opts?.now ?? Date.now
  // key (accountId:machineId:paneKey) → epoch ms the current window started (set by a human gesture).
  const windowStart = new Map<string, number>()

  const open = (key: string): void => {
    if (windowStart.size >= MAX_ENTRIES) windowStart.clear()
    windowStart.set(key, now())
  }

  return {
    start: open,
    allow(key, tier) {
      if (tier === 'pro') return true // unbounded auto-refresh for PRO
      const started = windowStart.get(key)
      if (started === undefined) {
        // No window (first tick, or lost on restart) — treat as a fresh window and allow.
        open(key)
        return true
      }
      return now() - started <= FREE_AUTO_REFRESH_SEC * 1000
    },
  }
}
