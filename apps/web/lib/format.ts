// Pure formatting helpers for the dashboard (ADR-0008/0016). No React, no DOM → unit-tested directly.
// Times use UTC for month/day (ADR-0018 §UTC); relative labels are computed against `now` (ms).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "3s ago" / "12m ago" / "2h ago" / "5d ago". Clamped so clock skew never shows a negative. */
export function relativeAgo(iso: string, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`
  return `${Math.round(secs / 86400)}d ago`
}

/** Machine "last seen": collapses the freshest window to "just now". */
export function lastSeenLabel(iso: string, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  return secs < 5 ? 'just now' : relativeAgo(iso, now)
}

/** Relative label from a raw seconds count (used for `diedSecondsAgo`). */
export function durationAgo(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s ago`
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`
  return `${Math.round(secs / 86400)}d ago`
}

export function shortDate(iso: string): string {
  const d = new Date(iso)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
}
export function longDate(iso: string): string {
  const d = new Date(iso)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export function hostnameModeLabel(source: 'real' | 'alias' | 'hidden'): string {
  return source === 'real' ? 'real hostname' : source
}
export function privacyLevelLabel(level: 'full' | 'restricted'): string {
  return level === 'full' ? 'privacy: full' : 'privacy: restricted (all names)'
}

// --- per-pane activity (the design's most prominent column) ---
export type ActivityKind =
  | { kind: 'unknown' } // no fingerprint change ever observed → dashed "Unknown"
  | { kind: 'thinking' } // claude is actively working (ADR-0025) → distinct busy indicator
  | { kind: 'quiet'; label: string } // pane has an attention → amber "quiet Xm" pill
  | { kind: 'fresh'; label: string } // changed within FRESH_SECONDS → green dot
  | { kind: 'plain'; label: string; faint?: boolean }

const FRESH_SECONDS = 10

/** Classify a pane's activity time from its derived last-change ISO, attention state, and exit.
 *  `thinking` (Claude busy) is distinct from and takes precedence over `needsAttention` (Claude
 *  waiting) — the plugin never sets both, but if it did, "busy" is the truer current state. */
export function paneActivity(opts: {
  updatedAt?: string | null
  needsAttention: boolean
  thinking?: boolean
  exited: boolean
  now?: number
}): ActivityKind {
  const now = opts.now ?? Date.now()
  if (opts.exited) {
    return { kind: 'plain', label: opts.updatedAt ? relativeAgo(opts.updatedAt, now) : 'exited', faint: true }
  }
  if (opts.thinking) return { kind: 'thinking' }
  if (opts.needsAttention) {
    const mins = opts.updatedAt ? Math.max(1, Math.round((now - new Date(opts.updatedAt).getTime()) / 60000)) : null
    return { kind: 'quiet', label: mins ? `quiet ${mins}m` : 'quiet' }
  }
  if (!opts.updatedAt) return { kind: 'unknown' }
  const secs = Math.max(0, Math.round((now - new Date(opts.updatedAt).getTime()) / 1000))
  return secs <= FRESH_SECONDS
    ? { kind: 'fresh', label: relativeAgo(opts.updatedAt, now) }
    : { kind: 'plain', label: relativeAgo(opts.updatedAt, now) }
}
