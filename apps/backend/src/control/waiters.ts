// Long-poll wake registry (ADR-0029) — in-process, single-backend (mirrors the SSE bus and the
// presence tracker; no Redis, ADR-0019). When the plugin opts into long-poll (`waitMs > 0` on the
// control request), the backend holds the response open on `wait(machineId, …)` until a latency-
// sensitive event `signal(machineId)`s it — a new pane-output request or a manual refresh — or the
// (clamped) timeout fires. A held request is one parked promise, resolved at most once. This is the
// ONLY new state long-poll adds server-side; the default immediate-response path never touches it.

export interface ControlWaiters {
  /** Park until this machine is signalled or `timeoutMs` elapses. Always resolves (never rejects). */
  wait(machineId: string, timeoutMs: number): Promise<void>
  /** Wake every request currently parked for this machine. No-op if none are parked. */
  signal(machineId: string): void
}

export const createControlWaiters = (): ControlWaiters => {
  // machineId → the set of "release me" callbacks for the requests currently parked on it.
  const parked = new Map<string, Set<() => void>>()

  return {
    wait(machineId, timeoutMs) {
      return new Promise<void>((resolve) => {
        const set = parked.get(machineId) ?? new Set<() => void>()
        parked.set(machineId, set)
        // Idempotent release: clears the timeout, unregisters, and resolves exactly once (a later
        // signal or a client-close simply finds nothing parked). `timer` is declared just below and
        // only read when `done` actually runs (via the timeout or a signal), so it is always set by
        // then.
        const done = (): void => {
          clearTimeout(timer)
          set.delete(done)
          if (set.size === 0) parked.delete(machineId)
          resolve()
        }
        set.add(done)
        // NOT unref'd: a parked poll is a live in-flight request, and its timer is what guarantees
        // the response is eventually written. unref would let the loop exit before it fires, so the
        // request (and its awaited promise) would hang forever with nothing else keeping it alive.
        const timer = setTimeout(done, timeoutMs)
      })
    },
    signal(machineId) {
      const set = parked.get(machineId)
      if (!set) return
      // Snapshot before iterating: `done` mutates the set as each resolves.
      for (const done of [...set]) done()
    },
  }
}
