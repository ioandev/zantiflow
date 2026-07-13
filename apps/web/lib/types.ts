// Shapes returned by the backend read API (ADR-0008). Kept minimal — the dashboard only reads.

export interface Me {
  id: string
  email: string | null
  name: string
  avatarUrl: string | null
  tier: string
  tierExpiresAt: string | null
}

export interface MachinePrivacy {
  source: 'real' | 'alias' | 'hidden'
  level: 'full' | 'restricted'
}
export interface MachineCounts {
  sessions: number
  tabs: number
  panes: number
}
export interface MachineSummary {
  id: string
  displayName: string | null
  tokenId: string | null // ingest token that last pushed for this machine; null = unlinked
  firstSeenAt: string
  lastSeenAt: string
  online: boolean // false = stale (no snapshot within the stale window)
  privacy: MachinePrivacy | null // null until a snapshot arrives
  counts: MachineCounts | null
  attentionCount: number // active attentions needing the user (excludes thinking)
  thinkingCount: number // active claude.thinking attentions (ADR-0025)
}

// The wire-v4 snapshot stored per machine (subset the dashboard renders).
export interface WirePane {
  id: number
  name: string | null // null = redacted → render <hidden>
  command: string | null
  isFocused: boolean
  exited: boolean
  contentFingerprint: string
}
export interface WireTab {
  tabId: number
  name: string | null
  position: number
  active: boolean
  panes: WirePane[]
}
export interface WireSession {
  sid: string
  name: string | null
  isCurrent: boolean
  state: 'live' | 'resurrectable'
  diedSecondsAgo: number | null
  tabs: WireTab[]
}
export interface WireSnapshot {
  version: number
  machineId: string
  capturedAtTick: number
  machine: { source: 'real' | 'alias' | 'hidden'; name: string | null }
  sessions: WireSession[]
}

export interface MachineDetail extends MachineSummary {
  snapshot: WireSnapshot | null
  capturedAtTick: number | null
  receivedAt: string | null
  // Derived per-pane activity: paneKey (`sid:tabId:paneId`) → last-changed ISO. A pane absent from
  // this map has had no observed change → rendered "Unknown".
  activity: Record<string, string>
}

export interface AttentionView {
  id: string
  machineId: string
  type: string
  targetKey: string
  activeSince: string
  lastFiredAt: string | null
}

// One channel a notification was sent on, with its delivery status (ADR-0006/0009).
export interface NotificationChannel {
  channel: string // webpush | discord | telegram
  status: string // pending | delivered | failed | expired
}
export interface NotificationView {
  id: string
  text: string
  createdAt: string
  channels: NotificationChannel[]
}

// One active Claude pane in the Spotlight roster (ADR-0016), across all the account's machines. The
// backend returns only currently-active ones; the client tracks "completed" by diffing rosters.
export interface SpotlightSession {
  key: string // stable pane identity: machineId:sid:tabId:paneId
  machineId: string
  machineName: string | null // machine displayName; null = hidden
  sessionSid: string
  sessionName: string | null
  tabId: number
  tabName: string | null
  paneId: number
  paneName: string | null
  command: string | null
  thinking: boolean // a turn is in flight (Braille spinner marker)
  updatedAt: string | null // last observed output change (ISO); null = Unknown
}

export interface TokenMeta {
  id: string
  label: string | null
  createdAt: string
  expiresAt: string | null
  lastUsedAt: string | null
  status: 'active' | 'revoked' | 'expired'
}
