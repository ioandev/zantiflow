// In-process pub/sub for dashboard SSE (ADR-0008). Account-scoped: a subscriber only ever receives
// its own account's events, and the ingest path publishes to the owning account only. Single-process
// by design (no Redis — ADR-0019); horizontal scaling is explicitly out of scope.
import type { SseEvent } from '@zantiflow/protocol'

export type SseListener = (event: SseEvent) => void

export interface SseBus {
  publish(accountId: string, event: SseEvent): void
  /** Subscribe a listener for an account; returns an unsubscribe function. */
  subscribe(accountId: string, listener: SseListener): () => void
  /** Current subscriber count for an account (used to cap concurrent streams). */
  countFor(accountId: string): number
}

export const createBus = (): SseBus => {
  const subs = new Map<string, Set<SseListener>>()

  return {
    publish(accountId, event) {
      const set = subs.get(accountId)
      if (!set) return
      for (const listener of set) {
        try {
          listener(event)
        } catch {
          // A broken listener must never break the publisher or other subscribers.
        }
      }
    },
    subscribe(accountId, listener) {
      let set = subs.get(accountId)
      if (!set) {
        set = new Set()
        subs.set(accountId, set)
      }
      set.add(listener)
      return () => {
        const s = subs.get(accountId)
        if (!s) return
        s.delete(listener)
        if (s.size === 0) subs.delete(accountId)
      }
    },
    countFor(accountId) {
      return subs.get(accountId)?.size ?? 0
    },
  }
}
