// The always-on plugin control channel (ADR-0026). Generalises the ADR-0016 output poll: the plugin
// POSTs its `machineId` + the session ids it is currently reporting every ~5 s, REGARDLESS of
// `pane_output`. The backend uses it to (a) touch liveness so a quiet-but-live session stays fresh
// under the read-filter, (b) return the pending pane-output requests (acted on only when
// `pane_output` is on), (c) tell the plugin whether a dashboard is watching, and (d) hand back a
// per-machine refresh sequence a manual refresh bumps. This is NOT part of the ingest wire contract
// (that stays v4) — it is versioned here in `@zantiflow/protocol`.
import { z } from 'zod'
import { OutputRequestRef } from './output'

/** Plugin → backend, every ~5 s. `liveSids` = the sessions this instance is currently reporting. */
export const ControlRequest = z.object({
  machineId: z.string().max(128),
  liveSids: z.array(z.string().max(64)).max(200),
  /**
   * Opt-in long-poll (ADR-0029). Absent/0 → the backend responds immediately (the default ~5 s poll,
   * unchanged). >0 → the backend holds the response up to this many ms — clamped server-side below the
   * 60 s read-filter — until a pending pane-output request or a refresh bump wakes it, so a website
   * "view this pane" request reaches the plugin in ≈1 s instead of up to ~5 s. Purely additive: the
   * plugin only sends it when its `control_long_poll` flag is on.
   */
  waitMs: z.number().int().min(0).max(30_000).optional(),
})

/** Backend → plugin. Additive fields only — the plugin ignores unknown ones (forward-compatible). */
export const ControlResponse = z.object({
  /** Panes the website has asked to view (only for this machine); acted on when `pane_output` is on. */
  pendingOutput: z.array(OutputRequestRef).max(200),
  /** Whether a dashboard is currently watching this account (drives the plugin's watched cadence). */
  viewers: z.object({
    active: z.boolean(),
    until: z.string().optional(), // reserved: ISO-8601 UTC presence expiry
  }),
  /** Monotonic per-machine counter; a bump means "the user hit refresh → send one snapshot now". */
  refreshSeq: z.number().int().nonnegative(),
})

export type ControlRequest = z.infer<typeof ControlRequest>
export type ControlResponse = z.infer<typeof ControlResponse>
