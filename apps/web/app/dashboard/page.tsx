'use client'

// The dashboard (ADR-0008/0016), built to the canonical v2 design: a single scrolling page — an
// overview grid of machine cards followed by each machine's inline detail section. Clicking a card
// smooth-scrolls to its detail. Live via the SSE stream: an ingest for a known machine refetches just
// that machine; a new machine refetches the list; attention changes refetch attentions + the machine.
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getAttentions,
  getMachine,
  getMachines,
  getMe,
  getNotifications,
  signInHref,
  UnauthorizedError,
} from '@/lib/api'
import { subscribeStream } from '@/lib/sse'
import { coerceSortMode, machineLastActiveMs, sortMachines, type SortMode } from '@/lib/machineView'
import type { AttentionView, MachineDetail, MachineSummary, Me, NotificationView } from '@/lib/types'
import { TopBar } from '@/components/TopBar'
import { MachineCard } from '@/components/dashboard/MachineCard'
import { MachineDetail as MachineDetailView } from '@/components/dashboard/MachineDetail'
import { SentNotifications } from '@/components/dashboard/SentNotifications'

const anchorFor = (id: string) => `m-${id}`

const SORT_KEY = 'ztf.dash.sort'
const CLAUDE_KEY = 'ztf.dash.claudeOnly'

export default function Dashboard() {
  const [me, setMe] = useState<Me | null>(null)
  const [machines, setMachines] = useState<MachineSummary[]>([])
  const [details, setDetails] = useState<Record<string, MachineDetail>>({})
  const [attentions, setAttentions] = useState<AttentionView[]>([])
  const [notifications, setNotifications] = useState<NotificationView[]>([])
  const [status, setStatus] = useState<'loading' | 'anon' | 'ready'>('loading')
  // Defaults: sort by most-recently-used, and start filtered to Claude panes only.
  const [sortMode, setSortMode] = useState<SortMode>('recent')
  const [claudeOnly, setClaudeOnly] = useState(true)
  const known = useRef<Set<string>>(new Set())
  const prefsLoaded = useRef(false)

  // Toolbar preferences persist across reloads. The write effect is declared FIRST so that on mount it
  // runs while `prefsLoaded` is still false and skips — never clobbering a stored choice with the
  // initial default before the read below has applied it.
  useEffect(() => {
    if (!prefsLoaded.current) return
    localStorage.setItem(SORT_KEY, sortMode)
    localStorage.setItem(CLAUDE_KEY, claudeOnly ? '1' : '0')
  }, [sortMode, claudeOnly])
  // Read on mount (never in the initializer — reading localStorage during SSR/first render would
  // mismatch hydration). Only a value the user has actually stored overrides the default, so a
  // first-time visitor keeps the defaults (recent + Claude-only).
  useEffect(() => {
    const storedSort = localStorage.getItem(SORT_KEY)
    if (storedSort !== null) setSortMode(coerceSortMode(storedSort))
    const storedClaude = localStorage.getItem(CLAUDE_KEY)
    if (storedClaude !== null) setClaudeOnly(storedClaude === '1')
    prefsLoaded.current = true
  }, [])

  const loadAttentions = useCallback(async () => {
    try {
      setAttentions(await getAttentions())
    } catch {
      /* transient */
    }
  }, [])

  const loadNotifications = useCallback(async () => {
    try {
      setNotifications(await getNotifications())
    } catch {
      /* transient */
    }
  }, [])

  const loadMachine = useCallback(async (id: string) => {
    try {
      const d = await getMachine(id)
      setDetails((prev) => ({ ...prev, [id]: d }))
    } catch {
      /* transient — a later SSE tick will retry */
    }
  }, [])

  const loadList = useCallback(async () => {
    const list = await getMachines()
    known.current = new Set(list.map((m) => m.id))
    setMachines(list)
    await Promise.all([...list.map((m) => loadMachine(m.id)), loadAttentions(), loadNotifications()])
  }, [loadMachine, loadAttentions, loadNotifications])

  // Initial auth + data load.
  useEffect(() => {
    getMe()
      .then(async (m) => {
        setMe(m)
        await loadList()
        setStatus('ready')
      })
      .catch((e) => setStatus(e instanceof UnauthorizedError ? 'anon' : 'ready'))
  }, [loadList])

  // Live updates. The open SSE stream is itself the "a viewer is watching" signal (ADR-0026). If SSE
  // can't connect, fall back to polling the read API every ~15s — that refreshes the UI AND registers
  // presence server-side (GET /machines marks the viewer), so the plugin still learns a dashboard is
  // open even where SSE is blocked.
  useEffect(() => {
    if (status !== 'ready') return
    let fallback: ReturnType<typeof setInterval> | null = null
    const stopFallback = () => {
      if (fallback) {
        clearInterval(fallback)
        fallback = null
      }
    }
    const startFallback = () => {
      if (fallback) return
      fallback = setInterval(() => void loadList(), 15_000)
    }
    const unsub = subscribeStream(
      (event, data) => {
        if (event === 'attention.update') {
          loadAttentions()
          // A fired attention may have just created notifications — refresh the sent-notifications list.
          loadNotifications()
          if (data.machineId) loadMachine(data.machineId)
          return
        }
        if (known.current.has(data.machineId)) loadMachine(data.machineId)
        else loadList()
      },
      { onOpen: stopFallback, onError: startFallback },
    )
    return () => {
      stopFallback()
      unsub()
    }
  }, [status, loadMachine, loadList, loadAttentions, loadNotifications])

  // "Most recently used" ranks by newest Claude-pane activity (from each machine's snapshot + derived
  // activity map), NOT lastSeenAt — a machine reports ~1/s even when idle, so lastSeenAt can't tell
  // "used" from "merely online", and counting non-Claude panes lets a background npm/shell bump an
  // untouched machine up. Recomputed as details stream in / SSE refreshes them.
  const lastActive = useMemo(() => {
    const m: Record<string, number> = {}
    for (const [id, d] of Object.entries(details)) m[id] = machineLastActiveMs(d)
    return m
  }, [details])

  // The display order for both the overview grid and the detail sections, so they stay in sync.
  const shown = useMemo(() => sortMachines(machines, sortMode, lastActive), [machines, sortMode, lastActive])

  if (status === 'loading') {
    return (
      <div className="dash">
        <p className="muted">Loading…</p>
      </div>
    )
  }
  if (status === 'anon') {
    return (
      <div className="dash">
        <p>Please sign in to see your machines.</p>
        <a className="btn" href={signInHref('/dashboard')}>
          Sign in
        </a>
      </div>
    )
  }

  // Group attentions by machine for per-node placement in the detail sections.
  const attnByMachine = new Map<string, AttentionView[]>()
  for (const a of attentions) {
    const arr = attnByMachine.get(a.machineId) ?? []
    arr.push(a)
    attnByMachine.set(a.machineId, arr)
  }

  const scrollTo = (id: string) => {
    const el = document.getElementById(anchorFor(id))
    if (el) {
      const y = el.getBoundingClientRect().top + window.scrollY - 62
      window.scrollTo({ top: y, behavior: 'smooth' })
    }
  }

  return (
    <>
      <TopBar me={me} />
      <div className="dash">
        <section className="ov">
          <div className="ov-head">
            <h1>Machines</h1>
            <span className="count">
              {machines.length > 0 ? `${machines.length} reporting for this account` : 'nothing reporting yet'}
            </span>
            {machines.length > 0 && (
              <div className="ov-tools">
                <label>
                  Sort
                  <select value={sortMode} onChange={(e) => setSortMode(e.target.value as SortMode)}>
                    <option value="recent">Most recently used</option>
                    <option value="name">Name A–Z</option>
                    <option value="attention">Needs attention</option>
                  </select>
                </label>
                <label className="check">
                  <input type="checkbox" checked={claudeOnly} onChange={(e) => setClaudeOnly(e.target.checked)} />
                  Claude only
                </label>
              </div>
            )}
          </div>

          {machines.length === 0 ? (
            <div className="banner">
              <p>No machines yet. Pair a plugin or create an ingest token to start reporting.</p>
              <Link href="/tokens">Manage tokens →</Link>
            </div>
          ) : (
            <>
              <div className="ov-grid">
                {shown.map((m) => (
                  <MachineCard key={m.id} m={m} onOpen={() => scrollTo(m.id)} />
                ))}
              </div>
              <p className="note">
                Counts are shown even under full redaction — structure leaks by design. Click a machine to jump to its
                detail. Click a pane to see its last 50 lines.
              </p>
            </>
          )}
        </section>

        {shown.map((m) => {
          const d = details[m.id]
          return d ? (
            <MachineDetailView
              key={m.id}
              detail={d}
              attentions={attnByMachine.get(m.id) ?? []}
              anchorId={anchorFor(m.id)}
              claudeOnly={claudeOnly}
            />
          ) : null
        })}

        <SentNotifications notifications={notifications} />

        {machines.length > 0 && (
          <p className="note">
            Read-only view · “needs attention” = an agent pane quiet past the threshold · activity times come from the
            backend clock, not the plugin tick.
          </p>
        )}
      </div>
    </>
  )
}
