'use client'

// One Spotlight "photo" (ADR-0016): a single Claude session's live terminal output. Streams via the
// shared `usePaneOutputStream` loop while it's the active, non-completed photo (`enabled`); the album
// mounts only the current photo, so exactly one streams at a time. `onFrame` lifts each captured frame
// to the page so flipping back (or a completed session) shows the last thing it printed. Terminal
// chrome + XSS-safe ANSI rendering match the dashboard's pane-output drawer.
import { useEffect, useRef } from 'react'
import { ansiLineToReact } from '@/lib/ansi'
import { relativeAgo } from '@/lib/format'
import { paneDisplayName } from '@/lib/machineView'
import type { SpotlightEntry } from '@/lib/spotlight'
import { useNow } from '@/lib/useNow'
import { usePaneOutputStream } from '@/lib/usePaneOutput'
import { Name, Pill } from '../dashboard/atoms'

export function SpotlightPhoto({
  entry,
  onFrame,
}: {
  entry: SpotlightEntry
  onFrame: (key: string, lines: string[], capturedAt: string) => void
}) {
  const streaming = !entry.completed
  const { phase, lines, capturedAt } = usePaneOutputStream({
    machineId: entry.machineId,
    sessionSid: entry.sessionSid,
    tabId: entry.tabId,
    paneId: entry.paneId,
    enabled: streaming,
    onFrame: (l, c) => onFrame(entry.key, l, c),
  })
  // Prefer freshly-streamed lines; fall back to the last frame the page persisted for this entry (so a
  // just-mounted or completed photo isn't blank).
  const shownLines = lines.length ? lines : (entry.lastFrame ?? [])
  const shownAt = capturedAt ?? entry.capturedAt ?? null

  const now = useNow() // keep "last output Ns ago" / "updated Ns ago · live" ticking between frames
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (shownLines.length && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [shownLines])

  const status = entry.completed
    ? { kind: 'exited', label: 'completed' }
    : entry.thinking
      ? { kind: 'thinking', label: 'thinking' }
      : { kind: 'live', label: 'active' }

  const note = entry.completed
    ? shownAt
      ? `session ended · last output ${relativeAgo(shownAt, now)}`
      : 'session ended'
    : phase === 'not-shared'
      ? 'output not shared'
      : phase === 'error'
        ? 'could not load'
        : shownLines.length
          ? shownAt
            ? `updated ${relativeAgo(shownAt, now)} · live`
            : 'live'
          : 'waiting for output…'

  return (
    <div className={`spot-photo${entry.completed ? ' done' : ''}`}>
      <div className="spot-photo-head">
        <span className="spot-photo-machine">
          <Name value={entry.machineName} hiddenText="<machine hidden>" />
        </span>
        <span className="spot-photo-loc">
          <Name value={entry.sessionName} /> · <Name value={entry.tabName} /> ·{' '}
          <Name value={paneDisplayName(entry.paneName)} />
        </span>
        <Pill kind={status.kind}>{status.label}</Pill>
        <span className="spot-photo-note r">{note}</span>
      </div>
      {shownLines.length ? (
        <div className="spot-photo-body pout-lines" ref={bodyRef}>
          {shownLines.map((line, i) => (
            <div key={i}>{ansiLineToReact(line)}</div>
          ))}
        </div>
      ) : (
        <div className="spot-photo-body empty">
          {entry.completed
            ? 'No output was captured for this session.'
            : phase === 'not-shared'
              ? 'Output isn’t shared for this pane. Enable `pane_output` in the plugin config.'
              : phase === 'error'
                ? 'Could not load output.'
                : 'Waiting for the first capture…'}
        </div>
      )}
    </div>
  )
}
