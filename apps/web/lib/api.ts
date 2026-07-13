// Typed client for the same-origin /api/v1 proxy. Every call sends the `ztf_session` cookie
// (same-origin); a 401 means "not signed in" and is surfaced as `UnauthorizedError` so pages can
// redirect to login. Responses are never cached (account-specific).
import type {
  AttentionView,
  MachineDetail,
  MachineSummary,
  Me,
  NotificationView,
  SpotlightSession,
  TokenMeta,
} from './types'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}
export class UnauthorizedError extends ApiError {
  constructor() {
    super(401, 'unauthorized', 'Not signed in')
    this.name = 'UnauthorizedError'
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
    ...init,
  })
  if (res.status === 401) throw new UnauthorizedError()
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
    throw new ApiError(res.status, body?.error?.code ?? 'error', body?.error?.message ?? res.statusText)
  }
  // Success responses may carry no body — 204 No Content, but also 202 Accepted (the pane-output
  // request endpoint) and any endpoint that just `.end()`s. Parsing an empty body as JSON throws
  // `SyntaxError`, which would surface as a spurious failure, so only parse when there's content.
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export const getMe = () => api<Me>('/auth/me')
export const logout = () => api<void>('/auth/logout', { method: 'POST' })
export const getMachines = () => api<{ machines: MachineSummary[] }>('/machines').then((r) => r.machines)
export const getMachine = (id: string) => api<MachineDetail>(`/machines/${encodeURIComponent(id)}`)
export const getAttentions = () => api<{ attentions: AttentionView[] }>('/attentions').then((r) => r.attentions)

/** The account's last 10 sent notifications and the channels each went to (ADR-0006/0009). */
export const getNotifications = () =>
  api<{ notifications: NotificationView[] }>('/notifications').then((r) => r.notifications)

// --- On-demand pane output (ADR-0016) ---
// A pane is addressed by its full identity — sessionSid/tabId/paneId. A bare paneId is only unique
// within one Zellij session (every session numbers panes from 0), so keying by it alone made the
// dashboard show output from a pane in a different tab/session that happened to share the number.
export type OutputRead = { lines: string[]; capturedAt: string } | { pending: true } | { shared: false }
const paneOutputPath = (machineId: string, sessionSid: string, tabId: number, paneId: number) =>
  `/machines/${encodeURIComponent(machineId)}/sessions/${encodeURIComponent(sessionSid)}/tabs/${tabId}/panes/${paneId}/output`
/** The drawer auto-refreshes while open (ADR-0016). `mode` distinguishes a human gesture — a drawer
 * open or "resume" (`start`, which (re)opens the tier window) — from an automatic refresh tick
 * (`auto`). The ack's `autoRefresh` is the server-authoritative "keep refreshing?" flag: `false` once
 * a FREE-tier window is spent (PRO stays `true`), telling the drawer to pause and show a resume button. */
export type OutputRequestAck = { autoRefresh: boolean }
export const requestOutput = (
  machineId: string,
  sessionSid: string,
  tabId: number,
  paneId: number,
  mode: 'start' | 'auto' = 'start',
) =>
  api<OutputRequestAck>(`${paneOutputPath(machineId, sessionSid, tabId, paneId)}/request?mode=${mode}`, {
    method: 'POST',
  })
export const getOutput = (machineId: string, sessionSid: string, tabId: number, paneId: number) =>
  api<OutputRead>(paneOutputPath(machineId, sessionSid, tabId, paneId))
export const forgetMachine = (id: string) => api<void>(`/machines/${encodeURIComponent(id)}`, { method: 'DELETE' })

// --- Spotlight (ADR-0016) — PRO-only live roster of active Claude sessions across all machines. A
// `403 requires_pro` (via ApiError) means "upgrade"; the page shows the upgrade prompt. ---
export const getSpotlight = () => api<{ activeCount: number; sessions: SpotlightSession[] }>('/spotlight')

// --- Manual refresh (ADR-0026): ask a machine's plugin to push a fresh snapshot on its next control
// poll. Rate-limited server-side to ≥5s per machine (429 if faster). ---
export const refreshMachine = (id: string) =>
  api<void>(`/machines/${encodeURIComponent(id)}/refresh`, { method: 'POST' })

export const listTokens = () => api<{ tokens: TokenMeta[] }>('/tokens').then((r) => r.tokens)
export const createToken = (input: { label?: string; ttl?: string }) =>
  api<{ id: string; secret: string; label: string | null; expiresAt: string | null; createdAt: string }>('/tokens', {
    method: 'POST',
    body: JSON.stringify(input),
  })
/** Rename a token's label (empty → cleared). The secret is unchanged. */
export const renameToken = (id: string, label: string | null) =>
  api<void>(`/tokens/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ label }) })
/** Revoke a token AND forget the machines it last pushed for; returns how many were forgotten. */
export const revokeToken = (id: string) =>
  api<{ forgotten: number }>(`/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
/** Revoke ALL of the account's ingest tokens at once; returns how many were revoked. */
export const revokeAllTokens = () => api<{ revoked: number }>('/tokens', { method: 'DELETE' })

// --- Device pairing (ADR-0012) — the owner approves a code shown in the plugin pane; the plugin
// then receives its ingest token by polling. 204 on success. ---
export const approvePairing = (userCode: string) =>
  api<void>('/pair/approve', { method: 'POST', body: JSON.stringify({ userCode }) })

// --- Chat integrations (ADR-0007) ---
export interface ChannelLinkView {
  id: string
  platform: string
  platformUsername: string | null
  status: string
  linkedAt: string
}
export const getIntegrations = () => api<{ links: ChannelLinkView[] }>('/integrations').then((r) => r.links)
export const mintChatLinkToken = (platform: 'discord' | 'telegram') =>
  api<{ token: string; expiresAt: string; command: string }>(`/integrations/${platform}/link-token`, { method: 'POST' })
export const unlinkChat = (id: string) => api<void>(`/integrations/${encodeURIComponent(id)}`, { method: 'DELETE' })

// --- Promo codes / tiers (ADR-0011) ---
export const getCurrentPromo = () =>
  api<{ code: { code: string; durationDays: number; expiresAt: string } | null }>('/promo/current').then((r) => r.code)
export const redeemPromo = (code: string) =>
  api<{ tier: string; tierExpiresAt: string }>('/promo/redeem', { method: 'POST', body: JSON.stringify({ code }) })

// --- Web Push (ADR-0006) ---
export const getVapidKey = () => api<{ publicKey: string | null }>('/push/vapid-public-key').then((r) => r.publicKey)
export const subscribePush = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
  api<void>('/push/subscribe', { method: 'POST', body: JSON.stringify(sub) })
export const unsubscribePush = (endpoint: string) =>
  api<void>('/push/subscribe', { method: 'DELETE', body: JSON.stringify({ endpoint }) })

/** The direct Google login URL (proxied to the backend), returning to `redirect` after sign-in.
 * Used only *inside* the /login page (and its auto-forward) — app entry points use `signInHref`. */
export const loginHref = (redirect = '/dashboard') => `/api/v1/auth/google?redirect=${encodeURIComponent(redirect)}`

// --- Owner sign-in methods (ADR-0035) --- The same web image serves both the Google-only hosted
// deployment and self-hosters who set a secret; this endpoint tells the /login page which to render.
export interface AuthMethods {
  google: boolean
  local: boolean
}
export const getAuthMethods = () => api<AuthMethods>('/auth/methods')
/** Sign in with the self-host owner secret. Resolves on 204; throws `ApiError`/`UnauthorizedError`
 * (both mean "wrong secret" to the login page) on 401. */
export const loginWithSecret = (secret: string) =>
  api<void>('/auth/local', { method: 'POST', body: JSON.stringify({ secret }) })
/** The generic sign-in entry point every page links to; /login picks the method(s) to show. */
export const signInHref = (redirect = '/dashboard') => `/login?redirect=${encodeURIComponent(redirect)}`
