// Server-Sent Events pushed to the authenticated dashboard (ADR-0008). Account-scoped; the backend
// emits only the caller's data. Live "latest state" — there is no history (retention = none).
import { z } from 'zod'

export const SseEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('machine.update'), data: z.object({ machineId: z.string() }) }),
  z.object({ event: z.literal('attention.update'), data: z.object({ machineId: z.string() }) }),
])

export type SseEvent = z.infer<typeof SseEvent>
