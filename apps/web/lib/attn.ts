// Index a machine's active attentions for O(1) per-node lookups in the tree (ADR-0008 §4). The
// backend keys each attention by `targetKey = sid:tabId:paneId` (segments empty when the attention
// targets the session or machine, e.g. `sid::` for session.detached). The dashboard uses this to
// badge the specific pane and to count attentions per session.
//
// `claude.thinking` (ADR-0025) is tracked SEPARATELY from the rest: it means "Claude is busy", not
// "Claude needs you", so it feeds a distinct indicator and is excluded from the needs-attention count.
import type { AttentionView } from './types'

export const THINKING_TYPE = 'claude.thinking'
// Machine-scoped (ADR-0027): its targetKey is `"::"` (no sid/tab/pane), so it never badges a specific
// pane/session — it surfaces once per machine via `machineIdle()`.
export const IDLE_TYPE = 'claude.idle'

export interface AttnTarget {
  sid: string
  tabId: string
  paneId: string
}

export function parseTargetKey(key: string): AttnTarget {
  const [sid = '', tabId = '', paneId = ''] = key.split(':')
  return { sid, tabId, paneId }
}

export class AttentionIndex {
  private needsPane = new Set<string>() // panes with a non-thinking attention (needs-input, …)
  private thinkingPane = new Set<string>() // panes where claude is thinking
  private needsCount = new Map<string, number>() // per session: non-thinking attentions
  private thinkingSession = new Set<string>() // sessions with at least one thinking pane
  private idle = false // machine-level: all Claude sessions are idle (ADR-0027)

  constructor(attentions: AttentionView[]) {
    for (const a of attentions) {
      const t = parseTargetKey(a.targetKey)
      if (a.type === IDLE_TYPE) {
        this.idle = true
        continue // machine-scoped ("::") — never a pane/session badge
      }
      const thinking = a.type === THINKING_TYPE
      const paneKey = t.paneId ? `${t.sid}:${t.tabId}:${t.paneId}` : null
      if (thinking) {
        if (paneKey) this.thinkingPane.add(paneKey)
        if (t.sid) this.thinkingSession.add(t.sid)
      } else {
        if (paneKey) this.needsPane.add(paneKey)
        if (t.sid) this.needsCount.set(t.sid, (this.needsCount.get(t.sid) ?? 0) + 1)
      }
    }
  }

  paneNeedsAttention(sid: string, tabId: number, paneId: number): boolean {
    return this.needsPane.has(`${sid}:${tabId}:${paneId}`)
  }
  paneThinking(sid: string, tabId: number, paneId: number): boolean {
    return this.thinkingPane.has(`${sid}:${tabId}:${paneId}`)
  }
  /** Count of attentions that need the user (excludes thinking). */
  sessionAttentions(sid: string): number {
    return this.needsCount.get(sid) ?? 0
  }
  sessionThinking(sid: string): boolean {
    return this.thinkingSession.has(sid)
  }
  /** Machine-level: every Claude session on this machine has gone quiet (ADR-0027). */
  machineIdle(): boolean {
    return this.idle
  }
}
