// Fixture data + the mutable mock state the specs hand to `installApiMocks`. Shapes mirror the read
// API (see `lib/types.ts`); relative imports keep e2e independent of the app's `@/` path alias.
import type { MachineDetail, MachineSummary, Me, TokenMeta, WirePane, WireSession, WireSnapshot } from '../lib/types'

/** Everything the mock backend serves for one test. Specs mutate it in place to drive live updates. */
export interface MockState {
  me: Me | null // null → /auth/me answers 401 (anonymous)
  machines: MachineSummary[]
  details: Record<string, MachineDetail>
  attentions: {
    id: string
    machineId: string
    type: string
    targetKey: string
    activeSince: string
    lastFiredAt: string | null
  }[]
  tokens: TokenMeta[]
  /** machineIds the dashboard asked to refresh — one per POST /machines/:id/refresh (ADR-0026). */
  refreshCalls?: string[]
  /** Status POST /machines/:id/refresh returns (default 202); set 429 to exercise the rate limit. */
  refreshStatus?: number
  /** Owner sign-in methods the mock reports at GET /auth/methods (ADR-0035); default google-only. */
  authMethods?: { google: boolean; local: boolean }
  /** The self-host secret POST /auth/local accepts; a matching submit "signs in" (sets `me = ME`). */
  localSecret?: string
}

export const ME: Me = {
  id: 'acc_1',
  email: 'ioan@example.com',
  name: 'Ioan',
  avatarUrl: null,
  tier: 'free',
  tierExpiresAt: null,
}

const now = () => new Date().toISOString()

export function pane(over: Partial<WirePane> = {}): WirePane {
  return {
    id: 1,
    name: 'claude',
    command: 'claude',
    isFocused: false,
    exited: false,
    contentFingerprint: 'fp',
    ...over,
  }
}

export function session(over: Partial<WireSession> = {}): WireSession {
  return {
    sid: 's1',
    name: 'main',
    isCurrent: true,
    state: 'live',
    diedSecondsAgo: null,
    tabs: [{ tabId: 1, name: 'editor', position: 0, active: true, panes: [pane()] }],
    ...over,
  }
}

/** A machine summary + matching detail sharing one id — the pair the dashboard fetches per machine. */
export function machine(id = 'm_red', over: Partial<MachineSummary> = {}, sessions: WireSession[] = [session()]) {
  const summary: MachineSummary = {
    id,
    displayName: 'red-laptop',
    tokenId: null,
    firstSeenAt: '2026-03-12T00:00:00Z',
    lastSeenAt: now(),
    online: true,
    privacy: { source: 'real', level: 'full' },
    counts: { sessions: sessions.length, tabs: 1, panes: 1 },
    attentionCount: 0,
    thinkingCount: 0,
    ...over,
  }
  const snapshot: WireSnapshot = {
    version: 4,
    machineId: id,
    capturedAtTick: 1,
    machine: { source: 'real', name: 'red-laptop' },
    sessions,
  }
  const detail: MachineDetail = { ...summary, snapshot, capturedAtTick: 1, receivedAt: now(), activity: {} }
  return { summary, detail }
}

/** A signed-in state with one live machine reporting one session/tab/pane. */
export function authedState(): MockState {
  const m = machine()
  return {
    me: ME,
    machines: [m.summary],
    details: { [m.summary.id]: m.detail },
    attentions: [],
    tokens: [],
    refreshCalls: [],
  }
}
