// The plugin → backend snapshot wire contract, **version 4** (ADR-0001/0002/0005; Appendix B).
// Zod is the single source of truth: schemas here derive both the TS types and the runtime
// validators the backend uses at the ingest boundary. Objects use Zod's default `.strip()` so
// UNKNOWN fields are ignored (forward-compat, ADR-0018 §2). Array/string bounds guard against
// parser / memory-exhaustion DoS (audit C9/G2). The token/account are NEVER in the body.
import { z } from 'zod'

// --- bounds ---
const MAX_SESSIONS = 200
const MAX_TABS = 200
const MAX_PANES = 500
const MAX_ATTENTIONS = 500
const str = (max: number) => z.string().max(max)

export const WIRE_VERSION = 4 as const

/** The privacy config the plugin echoes back (effective, post Model-A resolution). */
export const PrivacyEcho = z.object({
  full: z.boolean(),
  machine: z.enum(['real', 'alias', 'hidden']),
  sessionNames: z.enum(['send', 'hidden']),
  tabNames: z.enum(['send', 'hidden']),
  paneNames: z.enum(['send', 'hidden']),
})

/** Machine identity for display (name may be redacted when hidden). */
export const MachineIdentity = z.object({
  source: z.enum(['real', 'alias', 'hidden']),
  name: str(256).nullable(),
})

export const AttentionTarget = z.object({
  machineId: str(128).optional(),
  sessionSid: str(64).optional(),
  tabId: z.number().int().nonnegative().optional(),
  paneId: z.number().int().nonnegative().optional(),
})

export const Attention = z.object({
  type: str(64),
  target: AttentionTarget,
  state: z.enum(['active', 'cleared']),
  since: z.number().nonnegative(),
  detail: str(512).optional(),
})

// `name` / `command` are nullable — `null` = redacted (ADR-0002 → rendered `<hidden>`).
export const Pane = z.object({
  id: z.number().int().nonnegative(),
  name: str(256).nullable(),
  command: str(512).nullable(),
  isFocused: z.boolean(),
  exited: z.boolean(),
  contentFingerprint: str(64),
  /** Additive optional (ADR-0055, still v4): the plugin's Claude-pane verdict (title marker or
   *  live-content signatures, ADR-0054). Authoritative when present; old plugins omit it. */
  claude: z.boolean().optional(),
})

export const Tab = z.object({
  tabId: z.number().int().nonnegative(),
  name: str(256).nullable(),
  position: z.number().int().nonnegative(),
  active: z.boolean(),
  panes: z.array(Pane).max(MAX_PANES),
})

// Resurrectable (dead) sessions carry no tab/pane detail → `tabs: []` (ADR-0001).
export const Session = z.object({
  sid: str(64),
  name: str(256).nullable(),
  isCurrent: z.boolean(),
  state: z.enum(['live', 'resurrectable']),
  diedSecondsAgo: z.number().nonnegative().nullable(),
  tabs: z.array(Tab).max(MAX_TABS),
})

export const SnapshotV4 = z.object({
  version: z.literal(WIRE_VERSION),
  machineId: str(128),
  capturedAtTick: z.number().int().nonnegative(),
  privacy: PrivacyEcho,
  machine: MachineIdentity,
  attentions: z.array(Attention).max(MAX_ATTENTIONS),
  sessions: z.array(Session).max(MAX_SESSIONS),
  /**
   * Additive optional (ADR-0051, still v4): true when ≥1 claude pane THIS instance observes is
   * producing output (own-session view — the backend merges instances per machine and stays the
   * authority on "across all sessions", ADR-0027). Old plugins omit it. Advisory/corroborating.
   */
  claudeActive: z.boolean().optional(),
})

export type PrivacyEcho = z.infer<typeof PrivacyEcho>
export type MachineIdentity = z.infer<typeof MachineIdentity>
export type Attention = z.infer<typeof Attention>
export type Pane = z.infer<typeof Pane>
export type Tab = z.infer<typeof Tab>
export type Session = z.infer<typeof Session>
export type SnapshotV4 = z.infer<typeof SnapshotV4>
