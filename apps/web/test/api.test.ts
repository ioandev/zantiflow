// Regression tests for the typed API client's response handling. The pane-output request endpoint
// returns `202 Accepted` with a small JSON ack (`{ autoRefresh }` — ADR-0016); the helper must parse
// that, tag the auto-refresh `mode` onto the URL, and still tolerate an empty body (an empty 202 must
// not throw a SyntaxError that surfaces as a spurious "Could not load output." in the drawer).
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  UnauthorizedError,
  getAuthMethods,
  getMachines,
  getSpotlight,
  loginWithSecret,
  requestOutput,
} from '../lib/api'

// 204/205/304 are null-body statuses — the Response constructor rejects any body (even ''), so pass
// null. Other statuses get the given body (or an empty string, mirroring an endpoint that `.end()`s).
const NULL_BODY = new Set([204, 205, 304])
const mockFetch = (init: { status: number; body?: string }) =>
  vi.fn().mockResolvedValue(
    new Response(NULL_BODY.has(init.status) ? null : (init.body ?? ''), {
      status: init.status,
      headers: { 'content-type': 'application/json' },
    }),
  )

afterEach(() => vi.restoreAllMocks())

describe('api client empty-body handling', () => {
  it('parses the auto-refresh ack and tags the mode on the request URL', async () => {
    const fetch = mockFetch({ status: 202, body: JSON.stringify({ autoRefresh: false }) })
    vi.stubGlobal('fetch', fetch)
    await expect(requestOutput('m-1', 's1', 0, 2, 'auto')).resolves.toEqual({ autoRefresh: false })
    expect(String(fetch.mock.calls[0]![0])).toContain('/request?mode=auto')
  })

  it('defaults to mode=start (a human open/resume)', async () => {
    const fetch = mockFetch({ status: 202, body: JSON.stringify({ autoRefresh: true }) })
    vi.stubGlobal('fetch', fetch)
    await expect(requestOutput('m-1', 's1', 0, 2)).resolves.toEqual({ autoRefresh: true })
    expect(String(fetch.mock.calls[0]![0])).toContain('/request?mode=start')
  })

  it('resolves (does not throw) on a 202 with an empty body', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 202 }))
    await expect(requestOutput('m-1', 's1', 0, 2)).resolves.toBeUndefined()
  })

  it('resolves on a 204 with no body', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 204 }))
    await expect(requestOutput('m-1', 's1', 0, 2)).resolves.toBeUndefined()
  })

  it('parses a JSON body on a normal 200', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 200, body: JSON.stringify({ machines: [{ id: 'm-1' }] }) }))
    await expect(getMachines()).resolves.toEqual([{ id: 'm-1' }])
  })

  it('maps 401 to UnauthorizedError', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 401 }))
    await expect(requestOutput('m-1', 's1', 0, 2)).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it('getSpotlight parses the roster', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ status: 200, body: JSON.stringify({ activeCount: 1, sessions: [{ key: 'k' }] }) }),
    )
    await expect(getSpotlight()).resolves.toEqual({ activeCount: 1, sessions: [{ key: 'k' }] })
  })

  it('getSpotlight surfaces a 403 requires_pro as a typed ApiError (→ upgrade screen)', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 403, body: JSON.stringify({ error: { code: 'requires_pro' } }) }))
    await expect(getSpotlight()).rejects.toMatchObject({ status: 403, code: 'requires_pro' })
  })

  it('maps other non-2xx to ApiError with the server code', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 404, body: JSON.stringify({ error: { code: 'machine_not_found' } }) }))
    await expect(requestOutput('m-1', 's1', 0, 2)).rejects.toMatchObject({ status: 404, code: 'machine_not_found' })
    // sanity: it's the typed error
    await expect(requestOutput('m-1', 's1', 0, 2).catch((e) => e instanceof ApiError)).resolves.toBe(true)
  })
})

// Owner sign-in helpers (ADR-0035): the /login page reads which methods exist, then posts the secret.
describe('auth methods + secret login', () => {
  it('getAuthMethods parses the method flags', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 200, body: JSON.stringify({ google: false, local: true }) }))
    await expect(getAuthMethods()).resolves.toEqual({ google: false, local: true })
  })

  it('loginWithSecret POSTs the secret to /auth/local and resolves on 204', async () => {
    const fetch = mockFetch({ status: 204 })
    vi.stubGlobal('fetch', fetch)
    await expect(loginWithSecret('s3cr3t-value')).resolves.toBeUndefined()
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toContain('/auth/local')
    expect(init?.method).toBe('POST')
    expect(String(init?.body)).toContain('s3cr3t-value')
  })

  it('loginWithSecret maps a 401 (wrong secret) to UnauthorizedError', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 401, body: JSON.stringify({ error: { code: 'invalid_secret' } }) }))
    await expect(loginWithSecret('nope')).rejects.toBeInstanceOf(UnauthorizedError)
  })
})
