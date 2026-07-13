// Mocks the same-origin `/api/v1/**` backend at the browser's network layer. Route interception fires
// before the request leaves the page, so the Next `/api/v1` → backend rewrite is bypassed entirely —
// no backend, DB, or Google needed. The handler reads `state` fresh on every call, so a spec can mutate
// `state.details` / `state.tokens` mid-run and the change shows up on the next fetch.
import type { Page } from '@playwright/test'
import { ME, type MockState } from './fixtures'

type Body = { status: number; contentType?: string; body: string; headers?: Record<string, string> }
const json = (body: unknown, status = 200): Body => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})
const noContent: Body = { status: 204, body: '' }
const unauthorized = json({ error: { code: 'unauthorized', message: 'Not signed in' } }, 401)
const notFound = json({ error: { code: 'not_found', message: 'Not found' } }, 404)

// One `machine.update` frame per (re)connect. The dashboard turns it into a refetch of that machine;
// EventSource reconnects after `retry` ms and re-delivers, so a spec that mutates `state.details`
// mid-test sees the change render — exactly how a real ingest drives a live refresh.
const streamBody = (machineId: string) =>
  `retry: 400\n\nevent: machine.update\ndata: ${JSON.stringify({ machineId })}\n\n`

export async function installApiMocks(page: Page, state: MockState) {
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname.replace(/^\/api\/v1/, '')
    const method = req.method()

    // Session
    if (path === '/auth/me') return route.fulfill(state.me ? json(state.me) : unauthorized)
    if (path === '/auth/logout') return route.fulfill(noContent)

    // Owner sign-in surface (ADR-0035) — all PUBLIC (answerable signed out), so they sit above the gate.
    // Which methods this deployment offers (drives the /login page); default google-only (hosted).
    if (path === '/auth/methods') return route.fulfill(json(state.authMethods ?? { google: true, local: false }))
    // The Google start endpoint the /login page forwards to when it's the only method — stub a landing.
    if (path === '/auth/google') return route.fulfill(json({ ok: true }))
    // Self-host secret login: a matching secret "signs in" (sets the session); otherwise 401.
    if (path === '/auth/local' && method === 'POST') {
      const { secret } = JSON.parse(req.postData() || '{}') as { secret?: unknown }
      if (state.localSecret && secret === state.localSecret) {
        state.me = ME
        return route.fulfill(noContent)
      }
      return route.fulfill(json({ error: { code: 'invalid_secret', message: 'Invalid secret' } }, 401))
    }

    // Public endpoints (answerable while signed out — the UI pings these on mount and swallows errors).
    if (path === '/promo/current') return route.fulfill(json({ code: null }))
    if (path === '/push/vapid-public-key') return route.fulfill(json({ publicKey: null }))

    // Everything below is the owner-gated read/manage plane — 401 without a session, like the backend.
    if (!state.me) return route.fulfill(unauthorized)

    // Machines tree
    if (path === '/machines' && method === 'GET') return route.fulfill(json({ machines: state.machines }))
    const mDetail = path.match(/^\/machines\/([^/]+)$/)
    if (mDetail && method === 'GET') {
      const d = state.details[decodeURIComponent(mDetail[1])]
      return route.fulfill(d ? json(d) : notFound)
    }
    // Kick (forget) a machine: drop it and its detail. Used by the /tokens page (ADR-0003).
    if (mDetail && method === 'DELETE') {
      const id = decodeURIComponent(mDetail[1])
      if (!state.machines.some((m) => m.id === id)) return route.fulfill(notFound)
      state.machines = state.machines.filter((m) => m.id !== id)
      delete state.details[id]
      return route.fulfill(noContent)
    }
    // Manual refresh (ADR-0026): record the call so a spec can assert the button hit the endpoint.
    const mRefresh = path.match(/^\/machines\/([^/]+)\/refresh$/)
    if (mRefresh && method === 'POST') {
      state.refreshCalls?.push(decodeURIComponent(mRefresh[1]))
      const status = state.refreshStatus ?? 202
      return route.fulfill(
        status === 202
          ? { status: 202, body: '' }
          : json({ error: { code: 'rate_limited', message: 'Too Many Requests' } }, status),
      )
    }
    if (path === '/attentions') return route.fulfill(json({ attentions: state.attentions }))

    // Live stream (SSE) — served for the first known machine.
    if (path === '/stream') {
      const id = state.machines[0]?.id ?? 'm_none'
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'cache-control': 'no-store' },
        body: streamBody(id),
      })
    }

    // Ingest tokens (mint shows the secret once; delete revokes)
    if (path === '/tokens' && method === 'GET') return route.fulfill(json({ tokens: state.tokens }))
    if (path === '/tokens' && method === 'POST') {
      const input = JSON.parse(req.postData() || '{}') as { label?: string; ttl?: string }
      const id = `tok_${state.tokens.length + 1}`
      const secret = `ztf_${id}_secret_shown_once`
      const label = input.label ?? null
      state.tokens.unshift({
        id,
        label,
        createdAt: new Date().toISOString(),
        expiresAt: null,
        lastUsedAt: null,
        status: 'active',
      })
      return route.fulfill(json({ id, secret, label, expiresAt: null, createdAt: new Date().toISOString() }))
    }
    const tById = path.match(/^\/tokens\/([^/]+)$/)
    // Rename a token in place (label only). Empty/whitespace clears it to null.
    if (tById && method === 'PATCH') {
      const id = decodeURIComponent(tById[1])
      const { label } = JSON.parse(req.postData() || '{}') as { label?: string | null }
      const next = label && label.trim() ? label.trim() : null
      state.tokens = state.tokens.map((t) => (t.id === id ? { ...t, label: next } : t))
      return route.fulfill(noContent)
    }
    // Combined revoke + forget: revoke the token AND drop every machine it last pushed for.
    if (tById && method === 'DELETE') {
      const id = decodeURIComponent(tById[1])
      const forgotten = state.machines.filter((m) => m.tokenId === id)
      for (const m of forgotten) delete state.details[m.id]
      state.machines = state.machines.filter((m) => m.tokenId !== id)
      state.tokens = state.tokens.map((t) => (t.id === id ? { ...t, status: 'revoked' } : t))
      return route.fulfill(json({ forgotten: forgotten.length }))
    }

    return route.fulfill(notFound)
  })
}
