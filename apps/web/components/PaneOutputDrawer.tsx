'use client'

// Inline pane-output drawer (ADR-0016, ADR-0030). Opening it AUTO-REFRESHES the pane's captured output
// via the shared `usePaneOutputStream` loop (also used by Spotlight): each cycle registers a fresh
// request → polls until a NEW capture lands → renders the scrubbed ANSI tail with the XSS-safe
// renderer. Tier-gated server-side: PRO refreshes indefinitely; a FREE account refreshes for a bounded
// window, after which the drawer PAUSES and a "Resume auto-refresh" button starts a new window. The
// fetched lines live only in the hook's state (closing the drawer drops them), and the last frame stays
// on screen across a refresh so it never blanks. "Output not shared" when `pane_output` is OFF.
import { useEffect, useRef } from 'react'
import { usePaneOutputStream } from '@/lib/usePaneOutput'
import { ansiLineToReact } from '@/lib/ansi'
import { relativeAgo } from '@/lib/format'

export function PaneOutputDrawer({
  machineId,
  sessionSid,
  tabId,
  paneId,
}: {
  machineId: string
  sessionSid: string
  tabId: number
  paneId: number
}) {
  const { phase, lines, capturedAt, resume } = usePaneOutputStream({ machineId, sessionSid, tabId, paneId })
  const bodyRef = useRef<HTMLDivElement>(null)

  // Terminal output reads bottom-up (newest last): jump to the bottom whenever a new frame lands — the
  // freshest output is what you opened the drawer to see.
  useEffect(() => {
    if (lines.length && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [lines])

  const right =
    phase === 'live' && capturedAt
      ? `captured ${relativeAgo(capturedAt)} · auto-refreshing`
      : phase === 'not-shared'
        ? 'output not shared · click row to close'
        : phase === 'error'
          ? 'could not load · click row to close'
          : 'requesting… · click row to close'

  return (
    <div className="pout">
      <div className="pout-head">
        <span>pane output — last 50 lines</span>
        {phase === 'paused' ? (
          <span className="r pout-resume-wrap">
            {capturedAt && (
              <span className="pout-paused">auto-refresh paused · captured {relativeAgo(capturedAt)}</span>
            )}
            <button type="button" className="pout-resume" onClick={resume}>
              Resume auto-refresh
            </button>
          </span>
        ) : (
          <span className="r">{right}</span>
        )}
      </div>
      {(phase === 'live' || phase === 'paused') && lines.length ? (
        <div className="pout-body pout-lines" ref={bodyRef}>
          {lines.map((line, i) => (
            <div key={i}>{ansiLineToReact(line)}</div>
          ))}
        </div>
      ) : phase === 'not-shared' ? (
        <div className="pout-body">Output isn’t shared for this pane. Enable `pane_output` in the plugin config.</div>
      ) : phase === 'error' ? (
        <div className="pout-body">Could not load output.</div>
      ) : null}
    </div>
  )
}
