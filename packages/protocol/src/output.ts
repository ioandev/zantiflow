// The separate, on-demand pane-output channel (ADR-0016) — NOT part of the ingest wire contract.
// Website registers a request → the plugin's ~5 s poll picks it up → captures + scrubs (ADR-0017)
// → delivers ≤50 ANSI-colored lines. Output is OFF by default and never streamed.
import { z } from 'zod'

const MAX_LINES = 50
const MAX_LINE = 8192 // a single line incl. ANSI escapes

/** One pane the user has asked to view. A pane's identity is `sessionSid + tabId + paneId` — a raw
 * `paneId` is only unique WITHIN one Zellij session's id-space (every session numbers panes from 0),
 * so all three are required to address a pane unambiguously and to let the right per-session plugin
 * instance recognise its own panes (ADR-0016; matches the `PaneActivity` key `sid:tabId:paneId`). */
export const OutputRequestRef = z.object({
  machineId: z.string().max(128),
  sessionSid: z.string().max(64),
  tabId: z.number().int().nonnegative(),
  paneId: z.number().int().nonnegative(),
})

/** Plugin polls this → the panes to capture (backend→plugin). */
export const OutputPendingResponse = z.object({
  requests: z.array(OutputRequestRef).max(200),
})

/** Plugin delivers the captured, scrubbed, ANSI-colored tail (plugin→backend). The plugin echoes the
 * full `sessionSid + tabId + paneId` identity from the request it is fulfilling, so the backend stores
 * (and the owner later reads) the output under the SAME composite key — never colliding with a pane
 * that merely shares a numeric id in another tab/session. */
export const OutputDelivery = z.object({
  machineId: z.string().max(128),
  sessionSid: z.string().max(64),
  tabId: z.number().int().nonnegative(),
  paneId: z.number().int().nonnegative(),
  lines: z.array(z.string().max(MAX_LINE)).max(MAX_LINES),
  capturedAt: z.string(), // ISO-8601 UTC
})

/** What the website's read endpoint returns (one of three states). */
export const OutputReadResponse = z.union([
  z.object({ lines: z.array(z.string()), capturedAt: z.string() }),
  z.object({ pending: z.literal(true) }),
  z.object({ shared: z.literal(false) }),
])

export type OutputRequestRef = z.infer<typeof OutputRequestRef>
export type OutputPendingResponse = z.infer<typeof OutputPendingResponse>
export type OutputDelivery = z.infer<typeof OutputDelivery>
export type OutputReadResponse = z.infer<typeof OutputReadResponse>
