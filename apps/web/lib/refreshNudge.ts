// Frustration detector behind the filter nudge (ADR-0053): a user who refreshes twice within a
// short window — the ↻ machine-refresh button OR the browser's own reload — is usually LOOKING for
// something the current filters hide (the "Claude only" default hid a live session in the motivating
// incident). Refreshing can't fix that; the filters can. Pure/injectable so the policy unit-tests
// without React or a browser; the dashboard page owns the show-once state.

/** Two refreshes within this window ⇒ nudge. */
export const NUDGE_WINDOW_MS = 5 * 60_000
export const NUDGE_CLICKS = 2

export const NUDGE_TEXT = 'Not finding what you’re looking for? Check the filters at the top'

/** sessionStorage key for the browser-reload trigger: per-tab, survives the reload itself, gone
 *  when the tab closes. */
export const RELOAD_STORE_KEY = 'ztf.dash.reloads'

/**
 * Record a refresh (button click or page reload) at `now` against the previous times. Returns the
 * surviving times (pruned to the window, newest included) and whether this one crossed the nudge
 * threshold — the caller applies its own show-once policy on top.
 */
export const recordRefreshClick = (times: number[], now: number): { times: number[]; nudge: boolean } => {
  const kept = [...times.filter((t) => now - t < NUDGE_WINDOW_MS), now]
  return { times: kept, nudge: kept.length >= NUDGE_CLICKS }
}

/** Whether this page view came from the browser's reload (F5/⌘R), per the Navigation Timing API —
 *  a plain navigation or back/forward is NOT a frustration signal. SSR-safe (false off-browser). */
export const isPageReload = (): boolean => {
  if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return false
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  return nav?.type === 'reload'
}

/**
 * The browser-reload trigger, called once on dashboard mount: when this view is a reload, record it
 * (per tab, in `storage`) and report whether it is the 2nd within the window. Fires ⇒ the stored
 * window is cleared, so it takes another two rapid reloads to nudge again in this tab. `storage` and
 * `reload` are injectable for tests; defaults hit sessionStorage + the real navigation type.
 */
export const checkReloadNudge = (
  now: number = Date.now(),
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof sessionStorage === 'undefined' ? null : sessionStorage,
  reload: boolean = isPageReload(),
): boolean => {
  if (!reload || !storage) return false
  let times: number[] = []
  try {
    const parsed: unknown = JSON.parse(storage.getItem(RELOAD_STORE_KEY) ?? '[]')
    if (Array.isArray(parsed)) times = parsed.filter((t): t is number => typeof t === 'number')
  } catch {
    /* corrupted → start fresh */
  }
  const r = recordRefreshClick(times, now)
  try {
    storage.setItem(RELOAD_STORE_KEY, JSON.stringify(r.nudge ? [] : r.times))
  } catch {
    /* quota/private mode — the nudge just won't persist across reloads */
  }
  return r.nudge
}
