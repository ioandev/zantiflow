'use client'

// One pane row (name · command · flags · activity time), matching the v2 design grid. Clicking the
// row toggles the inline "last 50 lines" output drawer (ADR-0016). The activity time is the derived
// per-pane last-change (ADR-0001): a busy "thinking…" spinner when Claude is working (ADR-0025),
// green+dot when fresh, "quiet Xm" when the pane needs attention, "Unknown" when no change has ever
// been observed, plain otherwise.
import { useState } from 'react'
import type { WirePane } from '@/lib/types'
import { paneActivity } from '@/lib/format'
import { paneDisplayName } from '@/lib/machineView'
import { useNow } from '@/lib/useNow'
import { PaneOutputDrawer } from '../PaneOutputDrawer'
import { Name, Pill } from './atoms'

function ActivityTime({
  pane,
  needsAttention,
  thinking,
  updatedAt,
}: {
  pane: WirePane
  needsAttention: boolean
  thinking: boolean
  updatedAt?: string
}) {
  // Tick every second so the "fresh" dot ages out and "Xs ago" advances even while the plugin is
  // quiet (ADR-0026) and no SSE event re-renders us.
  const now = useNow()
  const a = paneActivity({ updatedAt, needsAttention, thinking, exited: pane.exited, now })
  if (a.kind === 'thinking')
    return (
      <span className="time-thinking">
        <span className="spin" aria-hidden />
        thinking…
      </span>
    )
  if (a.kind === 'fresh')
    return (
      <span className="time-fresh">
        <span className="d" aria-hidden />
        {a.label}
      </span>
    )
  if (a.kind === 'quiet') return <span className="time-quiet">{a.label}</span>
  if (a.kind === 'unknown') return <span className="time-unknown">Unknown</span>
  return <span className={`time-plain${a.faint ? ' faint' : ''}`}>{a.label}</span>
}

export function PaneRow({
  machineId,
  sessionSid,
  tabId,
  pane,
  needsAttention,
  thinking,
  updatedAt,
}: {
  machineId: string
  sessionSid: string
  tabId: number
  pane: WirePane
  needsAttention: boolean
  thinking: boolean
  updatedAt?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="prow-wrap">
      <button
        type="button"
        className={`prow${pane.exited ? ' exited' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="pname">
          <Name value={paneDisplayName(pane.name)} />
        </span>
        <span className="pcmd">
          <Name value={pane.command} />
        </span>
        <span className="pflags">
          {pane.isFocused && <Pill kind="focused">focused</Pill>}
          {thinking && <Pill kind="thinking">thinking</Pill>}
          {needsAttention && <Pill kind="needs">needs attention</Pill>}
          {pane.exited && <Pill kind="exited">exited</Pill>}
        </span>
        <span className="ptime">
          <ActivityTime pane={pane} needsAttention={needsAttention} thinking={thinking} updatedAt={updatedAt} />
        </span>
      </button>
      {open && <PaneOutputDrawer machineId={machineId} sessionSid={sessionSid} tabId={tabId} paneId={pane.id} />}
    </div>
  )
}
