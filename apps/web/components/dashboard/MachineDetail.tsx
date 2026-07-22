'use client'

// One machine's detail section (ADR-0008 §4 / ADR-0016 §A): header (dot, name, hostname/privacy
// badges, "updated Ns ago" or a stale disclosure) → live session cards → resurrectable/dead leaves.
// Stale machines dim the body and show the fire-and-forget explanation banner (ADR-0017 adaptive
// rendering). Attentions are joined to the specific session/pane via the AttentionIndex. A manual
// refresh button asks the plugin to push a fresh snapshot on its next control poll (ADR-0026).
import { useState } from 'react'
import type { AttentionView, MachineDetail as MD } from '@/lib/types'
import { ApiError, refreshMachine } from '@/lib/api'
import { AttentionIndex } from '@/lib/attn'
import { durationAgo, hostnameModeLabel, lastSeenLabel, longDate, privacyLevelLabel, relativeAgo } from '@/lib/format'
import { filterSessionsToClaude } from '@/lib/machineView'
import { useNow } from '@/lib/useNow'
import { Dot, Name, Pill } from './atoms'
import { SessionCard } from './SessionCard'

export function MachineDetail({
  detail,
  attentions,
  anchorId,
  claudeOnly = false,
  onRefreshClick,
}: {
  detail: MD
  attentions: AttentionView[]
  anchorId: string
  claudeOnly?: boolean
  /** Counted dashboard-wide for the repeated-refresh filter nudge (ADR-0053); busy clicks don't fire it. */
  onRefreshClick?: () => void
}) {
  const attn = new AttentionIndex(attentions)
  const now = useNow() // keep "updated Ns ago" / "last seen" ticking between snapshots
  const [refresh, setRefresh] = useState<{ busy: boolean; label: string }>({ busy: false, label: '↻ refresh' })
  const onRefresh = async () => {
    if (refresh.busy) return
    onRefreshClick?.()
    setRefresh({ busy: true, label: 'refreshing…' })
    let label = '✓ requested'
    try {
      await refreshMachine(detail.id)
    } catch (e) {
      label = e instanceof ApiError && e.status === 429 ? 'slow down' : 'failed'
    }
    setRefresh({ busy: true, label })
    // Stay disabled ~5s to match the server-side ≥5s rate limit, then reset. The fresh snapshot
    // arrives via SSE (or the polling fallback) within a poll or two — no manual refetch needed.
    setTimeout(() => setRefresh({ busy: false, label: '↻ refresh' }), 5_000)
  }
  const stale = !detail.online
  const hidden = detail.displayName === null
  const snap = detail.snapshot
  // When "Claude only" is on, prune the tree to Claude panes first; dead sessions carry no pane
  // detail so they fall out with it (nothing to render as a resurrectable leaf either).
  const sessions = snap ? (claudeOnly ? filterSessionsToClaude(snap.sessions) : snap.sessions) : []
  const live = sessions.filter((s) => s.state === 'live')
  const dead = sessions.filter((s) => s.state === 'resurrectable')
  const updated = detail.receivedAt ? relativeAgo(detail.receivedAt, now) : null

  return (
    <section className={`mach${stale ? ' stale-machine' : ''}`} id={anchorId}>
      <div className="mach-head">
        <div className="mach-title">
          <Dot kind={stale ? 'stale' : 'live'} lg />
          <span className={`nm${hidden ? ' hidden' : ''}`}>{hidden ? '<machine hidden>' : detail.displayName}</span>
          {detail.privacy && <Pill kind={detail.privacy.source}>{hostnameModeLabel(detail.privacy.source)}</Pill>}
          {detail.privacy && <Pill kind={detail.privacy.level}>{privacyLevelLabel(detail.privacy.level)}</Pill>}
          {attn.machineIdle() && <Pill kind="att">all Claude idle</Pill>}
          <span className={`updated${stale ? ' warn' : ''}`}>
            {stale
              ? `stale — last seen ${lastSeenLabel(detail.lastSeenAt, now)}`
              : updated
                ? `updated ${updated}`
                : 'no snapshot yet'}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refresh.busy}
            title="Ask this machine to send a fresh snapshot now"
            style={{
              marginLeft: 8,
              font: 'inherit',
              fontSize: '0.8em',
              lineHeight: 1.4,
              padding: '1px 7px',
              borderRadius: 5,
              border: '1px solid currentColor',
              background: 'transparent',
              color: 'inherit',
              opacity: refresh.busy ? 0.5 : 0.75,
              cursor: refresh.busy ? 'default' : 'pointer',
            }}
          >
            {refresh.label}
          </button>
        </div>
        <div className="mach-sub">
          <span>first seen {longDate(detail.firstSeenAt)}</span>
          {!stale && <span>last seen {lastSeenLabel(detail.lastSeenAt, now)}</span>}
          <span className="mono">{detail.id}</span>
        </div>
      </div>

      {stale && (
        <div className="stale-banner">
          Showing the last snapshot received, {lastSeenLabel(detail.lastSeenAt, now)}. The plugin is fire-and-forget —
          this could be a closed laptop or a network gap; the data can’t tell which.
        </div>
      )}

      <div className="mach-body">
        {!snap || sessions.length === 0 ? (
          <p className="muted">
            {claudeOnly && snap && snap.sessions.length > 0
              ? 'No Claude Code panes on this machine.'
              : 'No sessions reported yet.'}
          </p>
        ) : (
          <>
            {live.map((s) => (
              <SessionCard key={s.sid} machineId={detail.id} session={s} attn={attn} activity={detail.activity} />
            ))}
            {dead.map((s) => (
              <div className="deadleaf" key={s.sid}>
                <Dot kind="dead" />
                <Name value={s.name} className="nm" />
                <Pill kind="resurrectable">resurrectable</Pill>
                <span className="died">
                  died {s.diedSecondsAgo != null ? durationAgo(s.diedSecondsAgo) : 'recently'}
                </span>
                <span className="end">no tab/pane detail for dead sessions</span>
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  )
}
