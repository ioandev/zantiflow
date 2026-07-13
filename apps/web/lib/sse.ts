// Live dashboard updates via the backend SSE stream (ADR-0008). The browser's EventSource sends the
// session cookie on the same-origin `/api/v1/stream` and auto-reconnects. Callers get a cleanup fn.
'use client'

export type StreamEvent = 'machine.update' | 'attention.update'

/**
 * Subscribe to the live SSE stream. `onOpen`/`onError` report connection state so the caller can fall
 * back to polling when SSE is blocked (ADR-0026): an open stream is itself the "a viewer is watching"
 * signal, so while it's up nothing else is needed; when it can't connect, the caller polls the read
 * API (which also registers presence server-side).
 */
export function subscribeStream(
  onEvent: (event: StreamEvent, data: { machineId: string }) => void,
  opts?: { onOpen?: () => void; onError?: () => void },
): () => void {
  const es = new EventSource('/api/v1/stream', { withCredentials: true })
  const handler = (event: StreamEvent) => (e: MessageEvent) => {
    try {
      onEvent(event, JSON.parse(e.data) as { machineId: string })
    } catch {
      // ignore malformed frames
    }
  }
  const onMachine = handler('machine.update')
  const onAttention = handler('attention.update')
  es.addEventListener('machine.update', onMachine as EventListener)
  es.addEventListener('attention.update', onAttention as EventListener)
  if (opts?.onOpen) es.onopen = () => opts.onOpen?.()
  if (opts?.onError) es.onerror = () => opts.onError?.()
  return () => es.close()
}
