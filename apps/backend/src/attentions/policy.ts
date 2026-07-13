// Attention triggering policy (ADR-0005 §5/§6) — AUTHORITATIVE, server-side. The plugin reports
// attentions freely; the backend decides *how often* they fire, tier-aware. Thresholds/cooldowns are
// enforced here so a client can never unlock pro cadence.

export interface WireTarget {
  machineId?: string
  sessionSid?: string
  tabId?: number
  paneId?: number
}

/** Stable per-target key `sid:tabId:paneId` (unique with `type` per machine). */
export const targetKeyOf = (t: WireTarget): string => `${t.sessionSid ?? ''}:${t.tabId ?? ''}:${t.paneId ?? ''}`

/** Minimum active duration (seconds) before an attention may fire. Free 5 min / pro 1 min for the
 *  needs-input family; session-lifecycle attentions fire quickly. */
export const thresholdSeconds = (type: string, tier: string): number => {
  const pro = tier === 'pro'
  // `claude.idle` (ADR-0027) and `machine.offline` (ADR-0028) are self-timed by their backend sweep —
  // they are reported `active` only once the condition already holds — so the engine fires immediately
  // (0 = no extra wait). Cooldown + clear-on-resume still apply.
  if (type === 'claude.idle' || type === 'machine.offline') return 0
  if (type === 'claude.needs-input' || type === 'claude.thinking') return pro ? 60 : 300
  return pro ? 15 : 30
}

/** Anti-spam: a given target may fire at most once per this window. */
export const cooldownSeconds = (type: string): number =>
  // `machine.offline` should fire ONCE per disconnect, not every 5 min a machine stays down — a long
  // cooldown makes the single episode fire once; a reconnect clears the row so the next drop fires anew.
  type === 'machine.offline' ? 24 * 3600 : 300
