// In-memory store for delivered pane output (ADR-0032, superseding ADR-0030's DB storage). Captured
// terminal content is the most sensitive thing the pane-output channel touches, so it is NEVER written
// to the database — it is relayed purely through this process's memory from the plugin's delivery
// (`POST /output`) to the owner's one-shot read, then dropped. In-process + single-backend, exactly
// like presence/waiters/autoRefresh (no Redis, ADR-0019); losing it on restart is harmless — the read
// just reports "not shared" and the next open captures afresh. The lightweight request lifecycle
// (which pane was asked for, pending/fulfilled) still lives in the DB (`OutputRequest`) — that carries
// no terminal content, only "the owner asked to view pane X".
//
// Keyed by (accountId, machineId, paneKey) where `paneKey = sessionSid:tabId:paneId` is the pane's FULL
// identity — a raw paneId is only unique within one Zellij session, so panes in different tabs/sessions
// would otherwise collide and read back each other's output.

/** Pane output lives only as long as the owner's one-shot read needs it, then is pruned so scrubbed
 * content doesn't linger in memory between views. Mirrors the ~2 min window ADR-0016/0030 established. */
export const PANE_OUTPUT_RETENTION_SEC = 120

/** Coarse overflow guard (mirrors presence/autoRefresh): a flood of distinct panes can't grow the map
 * without bound. We prune expired entries first; only if still over do we drop the oldest. */
const MAX_ENTRIES = 100_000

interface Entry {
  lines: string[]
  capturedAt: Date
  storedAtMs: number
}

export interface StoredOutput {
  lines: string[]
  capturedAt: Date
}

export interface PaneOutputStore {
  /** Record a delivered capture (last-write-wins), replacing any prior one for the pane. */
  put(accountId: string, machineId: string, paneKey: string, lines: string[], capturedAt: Date): void
  /** The current capture for a pane, or undefined if none is held. */
  get(accountId: string, machineId: string, paneKey: string): StoredOutput | undefined
  /** Drop the capture for one pane (fresh-on-open re-request, ADR-0030 §2). */
  delete(accountId: string, machineId: string, paneKey: string): void
  /** Drop every capture for a machine (immediate purge on forget-machine / token revoke, ADR-0030). */
  deleteMachine(accountId: string, machineId: string): void
  /** Prune captures older than the retention window (the sweep, ADR-0030 §3). */
  prune(now?: Date): void
  /** Number of held captures (overflow guard + tests). */
  size(): number
}

// A null byte can't appear in an accountId, machineId, or paneKey, so it's an unambiguous separator and
// the trailing one makes `machinePrefix` select exactly one machine's panes (no `m-1` vs `m-12` bleed).
const SEP = String.fromCharCode(0)
const keyOf = (accountId: string, machineId: string, paneKey: string): string =>
  `${accountId}${SEP}${machineId}${SEP}${paneKey}`
const machinePrefix = (accountId: string, machineId: string): string => `${accountId}${SEP}${machineId}${SEP}`

export const createPaneOutputStore = (opts?: { now?: () => number }): PaneOutputStore => {
  const now = opts?.now ?? Date.now
  const entries = new Map<string, Entry>()

  const pruneExpired = (nowMs: number): void => {
    const cutoff = nowMs - PANE_OUTPUT_RETENTION_SEC * 1000
    for (const [k, e] of entries) {
      if (e.storedAtMs < cutoff) entries.delete(k)
    }
  }

  return {
    put(accountId, machineId, paneKey, lines, capturedAt) {
      if (entries.size >= MAX_ENTRIES) {
        // Reclaim space without dropping a capture the owner may be about to read: expired first,
        // then (still full) the single oldest entry.
        pruneExpired(now())
        if (entries.size >= MAX_ENTRIES) {
          const oldest = entries.keys().next().value // Map preserves insertion order
          if (oldest !== undefined) entries.delete(oldest)
        }
      }
      entries.set(keyOf(accountId, machineId, paneKey), { lines, capturedAt, storedAtMs: now() })
    },
    get(accountId, machineId, paneKey) {
      const e = entries.get(keyOf(accountId, machineId, paneKey))
      return e ? { lines: e.lines, capturedAt: e.capturedAt } : undefined
    },
    delete(accountId, machineId, paneKey) {
      entries.delete(keyOf(accountId, machineId, paneKey))
    },
    deleteMachine(accountId, machineId) {
      const prefix = machinePrefix(accountId, machineId)
      for (const k of entries.keys()) {
        if (k.startsWith(prefix)) entries.delete(k)
      }
    },
    prune(when = new Date(now())) {
      pruneExpired(when.getTime())
    },
    size() {
      return entries.size
    },
  }
}
