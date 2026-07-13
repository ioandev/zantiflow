// Small shared presentational atoms for the dashboard tree. `Name` renders untrusted terminal text —
// React escapes `{value}` so this is XSS-safe (audit C6). `null` = redacted → italic `<hidden>`,
// which is visually distinct from a machine/pane that has simply reported nothing yet.
import type { ReactNode } from 'react'

export function Name({
  value,
  className,
  hiddenText = '<hidden>',
}: {
  value: string | null
  className?: string
  hiddenText?: string
}) {
  if (value === null) return <span className={`hidden ${className ?? ''}`}>{hiddenText}</span>
  return <span className={className}>{value}</span>
}

/** A rounded status/label pill. `kind` selects the colour variant (see globals.css `.pill.*`). */
export function Pill({ kind, sm, children }: { kind: string; sm?: boolean; children: ReactNode }) {
  return <span className={`pill ${kind}${sm ? ' sm' : ''}`}>{children}</span>
}

export function Dot({ kind, lg }: { kind: 'live' | 'stale' | 'dead'; lg?: boolean }) {
  return <span className={`dot ${kind}${lg ? ' lg' : ''}`} aria-hidden />
}
