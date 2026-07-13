// Wire-version negotiation (ADR-0018 §2): validate `version` in the supported range, IGNORE unknown
// fields (forward-compat, handled by the schema's default strip), and REJECT unknown-newer with a
// clear error the backend maps to HTTP 400.
import type { z } from 'zod'
import { SnapshotV4 } from './wire'

export const SUPPORTED_WIRE_MIN = 4
export const SUPPORTED_WIRE_MAX = 4

export type SnapshotParseResult =
  | { ok: true; snapshot: SnapshotV4 }
  | { ok: false; code: 'invalid_body'; issues: z.ZodIssue[] }
  | { ok: false; code: 'unsupported_wire_version'; version: number }
  | { ok: false; code: 'unknown_wire_version'; version: number }

/** Parse an ingest body against the supported wire range. Never throws. */
export function parseSnapshot(body: unknown): SnapshotParseResult {
  const v = (body as { version?: unknown } | null | undefined)?.version
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    return { ok: false, code: 'invalid_body', issues: [] }
  }
  if (v > SUPPORTED_WIRE_MAX) return { ok: false, code: 'unknown_wire_version', version: v }
  if (v < SUPPORTED_WIRE_MIN) return { ok: false, code: 'unsupported_wire_version', version: v }
  const parsed = SnapshotV4.safeParse(body)
  if (!parsed.success) return { ok: false, code: 'invalid_body', issues: parsed.error.issues }
  return { ok: true, snapshot: parsed.data }
}
