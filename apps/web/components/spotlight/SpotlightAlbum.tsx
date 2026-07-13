'use client'

// The Spotlight carousel (ADR-0016): flip through the album of Claude sessions one "photo" at a time,
// with ‹ / › buttons, ←/→ keys, a position counter, and a dot strip. Only the current photo is
// mounted, so exactly one session streams its output at a time (the on-screen-only decision). Keyed by
// `entry.key` so flipping remounts a fresh photo (no stale lines flash). Completed dots read greyed.
import { useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { SpotlightEntry } from '@/lib/spotlight'
import { SpotlightPhoto } from './SpotlightPhoto'

export function SpotlightAlbum({
  entries,
  index,
  setIndex,
  onFrame,
}: {
  entries: SpotlightEntry[]
  index: number
  setIndex: Dispatch<SetStateAction<number>>
  onFrame: (key: string, lines: string[], capturedAt: string) => void
}) {
  const n = entries.length
  // ←/→ flip through the album (wrap around). Disabled with a single photo.
  useEffect(() => {
    if (n < 2) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') setIndex((i) => (i - 1 + n) % n)
      else if (e.key === 'ArrowRight') setIndex((i) => (i + 1) % n)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [n, setIndex])

  const entry = entries[index]
  if (!entry) return null
  const go = (d: number) => setIndex((i) => (i + d + n) % n)

  return (
    <div className="spot-album">
      <div className="spot-controls">
        <button
          type="button"
          className="spot-arrow"
          onClick={() => go(-1)}
          disabled={n < 2}
          aria-label="Previous session"
        >
          ‹
        </button>
        <span className="spot-pos">
          {index + 1} / {n}
        </span>
        <button type="button" className="spot-arrow" onClick={() => go(1)} disabled={n < 2} aria-label="Next session">
          ›
        </button>
      </div>
      <SpotlightPhoto key={entry.key} entry={entry} onFrame={onFrame} />
      {n > 1 && (
        <div className="spot-dots">
          {entries.map((e, i) => (
            <button
              key={e.key}
              type="button"
              className={`spot-dot${i === index ? ' on' : ''}${e.completed ? ' done' : ''}`}
              onClick={() => setIndex(i)}
              aria-label={`Session ${i + 1}${e.completed ? ' (completed)' : ''}`}
              aria-current={i === index}
            />
          ))}
        </div>
      )}
    </div>
  )
}
