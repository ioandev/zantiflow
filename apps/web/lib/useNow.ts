'use client'

// A shared 1 Hz clock so relative-time labels keep advancing even when nothing else re-renders. The
// dashboard only re-renders on an SSE event (or the 15 s polling fallback); by design the plugin goes
// QUIET once a machine is idle (ADR-0026 change-driven cadence), so without this the "fresh" green dot
// and every "Xs ago" / "quiet Xm" label would freeze at whatever `Date.now()` was at the last render.
// One interval backs every subscriber (not one per pane), and it stops when the last one unsubscribes.
import { useEffect, useState } from 'react'

/** A pub/sub clock ticking every `intervalMs`. Framework-free so the shared-timer logic unit-tests in
 *  the node vitest env without a DOM. Each subscriber reads `Date.now()` itself on tick, so the clock
 *  holds no time state to go stale. */
export class Clock {
  private readonly subs = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  constructor(private readonly intervalMs = 1000) {}

  /** Register `cb` to fire on each tick; returns an unsubscribe. The interval starts on the first
   *  subscriber and stops when the last one leaves (no orphaned timer). */
  subscribe(cb: () => void): () => void {
    this.subs.add(cb)
    if (this.timer === null) {
      this.timer = setInterval(() => {
        for (const s of this.subs) s()
      }, this.intervalMs)
    }
    return () => {
      this.subs.delete(cb)
      if (this.subs.size === 0 && this.timer !== null) {
        clearInterval(this.timer)
        this.timer = null
      }
    }
  }

  /** Test introspection. */
  get subscriberCount(): number {
    return this.subs.size
  }
  get running(): boolean {
    return this.timer !== null
  }
}

const shared = new Clock(1000)

/** Re-render roughly every second off the single shared clock, returning the current epoch-ms — pass
 *  it as the `now` argument to `relativeAgo` / `lastSeenLabel` / `paneActivity` so their labels tick. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => shared.subscribe(() => setNow(Date.now())), [])
  return now
}
