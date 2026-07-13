// Per-pane activity derivation (ADR-0001/0008/0016). Zellij emits no "new stdout" signal, so the
// backend derives per-pane "last updated" by diffing each pane's `contentFingerprint` across
// ingests and stamping a BACKEND-clock timestamp when it changes. A pane we've seen but never
// observed change stays `null` → the dashboard renders "Unknown" (distinct from a redacted name).
// State is a single JSON map per machine (`PaneActivity`), replaced each ingest — O(1) writes, not
// O(panes).
import type { SnapshotV4 } from '@zantiflow/protocol'

export interface PaneActivityEntry {
  fp: string
  updatedAt: string | null // ISO of the last observed fingerprint change, or null = no change seen yet
}
export type ActivityMap = Record<string, PaneActivityEntry>

/** Stable per-pane key — identical to the attention `targetKey` so the UI can join the two. */
export const paneKeyOf = (sid: string, tabId: number, paneId: number): string => `${sid}:${tabId}:${paneId}`

/**
 * Fold the previous activity map with the current snapshot. For every pane in the snapshot:
 *  - changed fingerprint → stamp `updatedAt = now`
 *  - unchanged fingerprint → keep the prior entry (and its timestamp)
 *  - first-ever observation → record fp with `updatedAt = null` ("Unknown" until it next changes)
 * Panes absent from the snapshot (closed) are dropped, so the map stays bounded to what's live.
 */
export const deriveActivity = (prev: ActivityMap, snapshot: SnapshotV4, now: Date): ActivityMap => {
  const next: ActivityMap = {}
  const iso = now.toISOString()
  for (const s of snapshot.sessions) {
    for (const t of s.tabs) {
      for (const p of t.panes) {
        const key = paneKeyOf(s.sid, t.tabId, p.id)
        const before = prev[key]
        if (!before) {
          next[key] = { fp: p.contentFingerprint, updatedAt: null }
        } else if (before.fp !== p.contentFingerprint) {
          next[key] = { fp: p.contentFingerprint, updatedAt: iso }
        } else {
          next[key] = before
        }
      }
    }
  }
  return next
}

/** Read the stored JSON map, tolerant of a missing/legacy row. */
export const asActivityMap = (raw: unknown): ActivityMap => {
  if (!raw || typeof raw !== 'object') return {}
  return raw as ActivityMap
}

/** Project the stored map to the wire shape the read API returns: paneKey → ISO, omitting Unknowns. */
export const activityToWire = (map: ActivityMap): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(map)) if (v.updatedAt) out[k] = v.updatedAt
  return out
}
