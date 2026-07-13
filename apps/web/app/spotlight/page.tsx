'use client'

// Spotlight (ADR-0016) — a PRO-only live album of every ACTIVE Claude session across the account's
// machines, flipped through like photos, each streaming its terminal output. The roster comes from the
// PRO-gated `GET /spotlight` (a `403 requires_pro` ⇒ the upgrade screen); it stays live off the SSE
// stream (a ping ⇒ a throttled refetch), so new Claude sessions appear on their own. Sessions that go
// away become "completed" (kept, greyed) until "Clear sessions that completed". Header shows the active
// count; with zero active it explains the view only works when Claude sessions are running.
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, getMe, getSpotlight, signInHref, UnauthorizedError } from '@/lib/api'
import {
  clearCompleted,
  countActive,
  filterRunning,
  reconcileAlbum,
  sortByRecent,
  type SpotlightEntry,
} from '@/lib/spotlight'
import { subscribeStream } from '@/lib/sse'
import type { Me } from '@/lib/types'
import { RedeemPromo } from '@/components/RedeemPromo'
import { TopBar } from '@/components/TopBar'
import { SpotlightAlbum } from '@/components/spotlight/SpotlightAlbum'

type Status = 'loading' | 'anon' | 'not-pro' | 'ready'

const RUNNING_KEY = 'ztf.spot.runningOnly'

export default function Spotlight() {
  const [me, setMe] = useState<Me | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [entries, setEntries] = useState<SpotlightEntry[]>([])
  const [index, setIndex] = useState(0)
  const [runningOnly, setRunningOnly] = useState(false)
  const prefsLoaded = useRef(false)

  // "Running only" persists across reloads. Write effect declared FIRST so on mount it runs while
  // `prefsLoaded` is still false and skips — never clobbering a stored choice with the default before
  // the read below applies it. Read on mount (not in the initializer — localStorage during SSR/first
  // render would mismatch hydration); only a stored value overrides the default (off).
  useEffect(() => {
    if (!prefsLoaded.current) return
    localStorage.setItem(RUNNING_KEY, runningOnly ? '1' : '0')
  }, [runningOnly])
  useEffect(() => {
    const stored = localStorage.getItem(RUNNING_KEY)
    if (stored !== null) setRunningOnly(stored === '1')
    prefsLoaded.current = true
  }, [])

  const refresh = useCallback(async () => {
    try {
      const { sessions } = await getSpotlight()
      setEntries((prev) => reconcileAlbum(prev, sessions))
    } catch {
      /* transient — a later SSE tick (or the fallback poll) retries */
    }
  }, [])

  // Initial auth + PRO gate + first roster. The backend 403 is authoritative: a non-PRO account lands
  // on the upgrade screen even if its cached client tier disagrees.
  useEffect(() => {
    getMe()
      .then(async (m) => {
        setMe(m)
        try {
          const { sessions } = await getSpotlight()
          // First open: lay the album out most-recently-used first. Later refreshes keep this order
          // stable (reconcileAlbum never moves an existing entry), so only the initial sort matters.
          setEntries((prev) => reconcileAlbum(prev, sortByRecent(sessions)))
          setStatus('ready')
        } catch (e) {
          setStatus(e instanceof ApiError && e.status === 403 ? 'not-pro' : 'ready')
        }
      })
      .catch((e) => setStatus(e instanceof UnauthorizedError ? 'anon' : 'ready'))
  }, [])

  // Live: an SSE ping (machine.update / attention.update fires ~1/s per machine) triggers a roster
  // refetch, throttled to ~1s so many machines don't hammer the endpoint. Same SSE-is-presence + 15s
  // polling fallback as the dashboard.
  useEffect(() => {
    if (status !== 'ready') return
    let fallback: ReturnType<typeof setInterval> | null = null
    let throttle: ReturnType<typeof setTimeout> | null = null
    let queued = false
    const fire = () => {
      if (throttle) {
        queued = true
        return
      }
      void refresh()
      throttle = setTimeout(() => {
        throttle = null
        if (queued) {
          queued = false
          fire()
        }
      }, 1000)
    }
    const stopFallback = () => {
      if (fallback) {
        clearInterval(fallback)
        fallback = null
      }
    }
    const startFallback = () => {
      if (!fallback) fallback = setInterval(() => void refresh(), 15_000)
    }
    const unsub = subscribeStream(() => fire(), { onOpen: stopFallback, onError: startFallback })
    return () => {
      unsub()
      stopFallback()
      if (throttle) clearTimeout(throttle)
    }
  }, [status, refresh])

  // The album shows either every entry or only the running ones. `index` addresses this VISIBLE list,
  // so toggling the filter / clearing completed can leave it out of range — clamp it below.
  const visible = runningOnly ? filterRunning(entries) : entries

  // Keep the viewed index valid when the visible album shrinks (filter toggled, "Clear completed").
  useEffect(() => {
    setIndex((i) => (i >= visible.length ? Math.max(0, visible.length - 1) : i))
  }, [visible.length])

  const onFrame = useCallback((key: string, lines: string[], capturedAt: string) => {
    setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, lastFrame: lines, capturedAt } : e)))
  }, [])

  if (status === 'loading') {
    return (
      <>
        <TopBar me={me} />
        <div className="dash">
          <p className="muted">Loading…</p>
        </div>
      </>
    )
  }
  if (status === 'anon') {
    return (
      <div className="dash">
        <p>Please sign in to use Spotlight.</p>
        <a className="btn" href={signInHref('/spotlight')}>
          Sign in
        </a>
      </div>
    )
  }
  if (status === 'not-pro') {
    return (
      <>
        <TopBar me={me} />
        <div className="dash">
          <section className="banner">
            <h1>Spotlight is a PRO feature</h1>
            <p className="muted">
              Spotlight shows every active Claude session across your machines at once, live. Redeem a promo code to
              unlock PRO.
            </p>
            <RedeemPromo onRedeemed={() => window.location.reload()} />
          </section>
        </div>
      </>
    )
  }

  const active = countActive(entries)
  const hasCompleted = entries.some((e) => e.completed)

  return (
    <>
      <TopBar me={me} />
      <div className="dash spot">
        <div className="spot-head">
          <h1>Spotlight ({active})</h1>
          <label className="check spot-running">
            <input type="checkbox" checked={runningOnly} onChange={(e) => setRunningOnly(e.target.checked)} />
            Running only
          </label>
          {hasCompleted && (
            <button type="button" className="btn ghost" onClick={() => setEntries((prev) => clearCompleted(prev))}>
              Clear sessions that completed
            </button>
          )}
        </div>

        {active === 0 && <p className="spot-empty">Spotlight only works when there are active Claude sessions.</p>}

        {entries.length === 0 ? (
          <p className="muted">No Claude sessions are running yet. Launch Claude in a Zellij pane to see it here.</p>
        ) : visible.length > 0 ? (
          <SpotlightAlbum entries={visible} index={index} setIndex={setIndex} onFrame={onFrame} />
        ) : (
          <p className="spot-empty">No Claude sessions are actively running right now.</p>
        )}
      </div>
    </>
  )
}
