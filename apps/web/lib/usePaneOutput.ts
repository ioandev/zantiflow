'use client'

// The pane-output auto-refresh loop (ADR-0016/0030/0031), extracted so both the inline drawer and the
// Spotlight album share one engine (ADR-0015). Each cycle registers a fresh capture request — the
// backend drops the prior capture, so the read is `pending` until the plugin delivers a NEW one — then
// polls until that frame lands, shows it, pauses briefly, and repeats. Tier-gated server-side: PRO
// refreshes indefinitely; a spent FREE window returns `{autoRefresh:false}` → `phase:'paused'` and the
// caller shows a resume affordance (`resume()` opens a new window). `enabled:false` stops the loop but
// KEEPS the last frame in state (Spotlight freezes photos you flip away from); flipping it back on
// starts a fresh stream. `onFrame` lets a parent persist the last frame across mounts.
import { useCallback, useEffect, useRef, useState } from 'react'
import { getOutput, requestOutput } from '@/lib/api'

/** Poll cadence while waiting for a fresh capture to land (a ~1s plugin capture — ADR-0031). */
const POLL_MS = 1000
/** Pause between showing a capture and requesting the next (≈2s effective auto-refresh cadence). */
const REFRESH_GAP_MS = 1000

export type PaneOutputPhase = 'loading' | 'live' | 'paused' | 'not-shared' | 'error'

export interface PaneOutputStream {
  phase: PaneOutputPhase
  lines: string[]
  capturedAt: string | null
  /** Restart the loop with a fresh `mode=start` window (used by the FREE "resume" button). */
  resume: () => void
}

export function usePaneOutputStream({
  machineId,
  sessionSid,
  tabId,
  paneId,
  enabled = true,
  onFrame,
}: {
  machineId: string
  sessionSid: string
  tabId: number
  paneId: number
  enabled?: boolean
  onFrame?: (lines: string[], capturedAt: string) => void
}): PaneOutputStream {
  const [phase, setPhase] = useState<PaneOutputPhase>('loading')
  const [lines, setLines] = useState<string[]>([])
  const [capturedAt, setCapturedAt] = useState<string | null>(null)
  // Bumped by resume() to restart the loop; also re-sends `mode=start` → a fresh (server-reset) window.
  const [cycle, setCycle] = useState(0)
  // Keep the latest onFrame without making it a loop dependency (a new closure each render must not
  // tear down and restart the stream).
  const onFrameRef = useRef(onFrame)
  useEffect(() => {
    onFrameRef.current = onFrame
  }, [onFrame])

  useEffect(() => {
    if (!enabled) return // stopped: keep the last frame on screen, don't poll
    let active = true
    let sleepTimer: ReturnType<typeof setTimeout> | undefined
    // Cancellable pause: resolves after `ms`, or immediately when the effect tears down.
    const sleep = (ms: number) => new Promise<void>((resolve) => (sleepTimer = setTimeout(resolve, ms)))

    const run = async () => {
      let mode: 'start' | 'auto' = 'start'
      while (active) {
        let ack
        try {
          ack = await requestOutput(machineId, sessionSid, tabId, paneId, mode)
        } catch {
          if (active) setPhase('error')
          return
        }
        if (!active) return
        // `autoRefresh:false` = the server telling a FREE client its window is spent — pause and keep
        // the last frame up. (An empty/absent body defensively means "keep going".)
        if (ack && ack.autoRefresh === false) {
          setPhase('paused')
          return
        }

        // Poll until THIS request's fresh capture arrives. The prior frame was dropped on register so
        // the read is `pending` briefly — we leave the already-shown lines up (no blank flicker).
        let shown = false
        while (active && !shown) {
          let res
          try {
            res = await getOutput(machineId, sessionSid, tabId, paneId)
          } catch {
            if (active) setPhase('error')
            return
          }
          if (!active) return
          if ('lines' in res) {
            setLines(res.lines)
            setCapturedAt(res.capturedAt)
            setPhase('live')
            onFrameRef.current?.(res.lines, res.capturedAt)
            shown = true
          } else if ('pending' in res) {
            await sleep(POLL_MS)
          } else {
            setPhase('not-shared')
            return
          }
        }

        await sleep(REFRESH_GAP_MS) // brief gap, then auto-refresh again
        mode = 'auto'
      }
    }

    void run()
    return () => {
      active = false
      if (sleepTimer) clearTimeout(sleepTimer)
    }
  }, [machineId, sessionSid, tabId, paneId, cycle, enabled])

  const resume = useCallback(() => setCycle((c) => c + 1), [])
  return { phase, lines, capturedAt, resume }
}
