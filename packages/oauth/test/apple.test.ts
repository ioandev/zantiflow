import { describe, it, expect, vi, afterEach } from 'vitest'
import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto'
import { AppleProvider } from '../src/apple'

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
const idToken = (payload: Record<string, unknown>): string => `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`

// A throwaway P-256 keypair so the REAL ES256 client-secret minting path runs and can
// be verified with the matching public key.
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const PRIV_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const stubFetch = (body: unknown, init: { ok?: boolean; status?: number } = {}) => {
  const calls: { url: string; init: RequestInit }[] = []
  const fn = vi.fn(async (url: string | URL | Request, reqInit?: RequestInit) => {
    calls.push({ url: String(url), init: reqInit ?? {} })
    return { ok: init.ok ?? true, status: init.status ?? 200, json: async () => body } as Response
  })
  vi.stubGlobal('fetch', fn)
  return { calls }
}
afterEach(() => vi.unstubAllGlobals())

const OPTS = {
  clientId: 'com.example.svc',
  teamId: 'TEAM123456',
  keyId: 'KEY1234567',
  privateKey: PRIV_PEM,
  redirectUri: 'https://app.example/cb',
  tokenUrl: 'https://token.test/apple',
}

// Split "<header>.<payload>.<sig>" and decode the header/payload.
const decodeJwt = (jwt: string) => {
  const [h, p] = jwt.split('.')
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString()) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, number | string>,
  }
}
const clientSecretFrom = (calls: { init: RequestInit }[]) =>
  (calls[0].init.body as URLSearchParams).get('client_secret')!
const verifySignature = (jwt: string): boolean => {
  const cut = jwt.lastIndexOf('.')
  const signingInput = jwt.slice(0, cut)
  const sig = Buffer.from(jwt.slice(cut + 1), 'base64url')
  return cryptoVerify('sha256', Buffer.from(signingInput), { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig)
}

describe('AppleProvider — identity + buildAuthUrl', () => {
  it('has id "apple" and a POST (form_post) callback method', () => {
    const p = new AppleProvider(OPTS)
    expect(p.id).toBe('apple')
    expect(p.callbackMethod).toBe('POST')
  })

  it('builds the consent URL forcing response_mode=form_post with the default scope', () => {
    const url = new URL(new AppleProvider(OPTS).buildAuthUrl('STATE'))
    expect(url.origin + url.pathname).toBe('https://appleid.apple.com/auth/authorize')
    const q = url.searchParams
    expect(q.get('client_id')).toBe(OPTS.clientId)
    expect(q.get('redirect_uri')).toBe(OPTS.redirectUri)
    expect(q.get('response_type')).toBe('code')
    expect(q.get('scope')).toBe('name email')
    expect(q.get('response_mode')).toBe('form_post')
    expect(q.get('state')).toBe('STATE')
  })

  it('honours a custom scope and authUrl', () => {
    const url = new URL(
      new AppleProvider({ ...OPTS, scope: 'email', authUrl: 'https://apple.test/a' }).buildAuthUrl('S'),
    )
    expect(url.origin + url.pathname).toBe('https://apple.test/a')
    expect(url.searchParams.get('scope')).toBe('email')
  })
})

describe('AppleProvider — ES256 client secret', () => {
  it('mints a JWT with the right header/claims and a signature that verifies', async () => {
    const { calls } = stubFetch({ id_token: idToken({ sub: 'a1' }) })
    await new AppleProvider(OPTS).exchangeCode('C')
    const secret = clientSecretFrom(calls)
    const { header, payload } = decodeJwt(secret)
    expect(header).toEqual({ alg: 'ES256', kid: 'KEY1234567' })
    expect(payload.iss).toBe('TEAM123456')
    expect(payload.aud).toBe('https://appleid.apple.com')
    expect(payload.sub).toBe('com.example.svc')
    expect((payload.exp as number) - (payload.iat as number)).toBe(3600) // default TTL
    expect(verifySignature(secret)).toBe(true)
  })

  it('honours a custom clientSecretTtlSeconds', async () => {
    const { calls } = stubFetch({ id_token: idToken({ sub: 'a1' }) })
    await new AppleProvider({ ...OPTS, clientSecretTtlSeconds: 600 }).exchangeCode('C')
    const { payload } = decodeJwt(clientSecretFrom(calls))
    expect((payload.exp as number) - (payload.iat as number)).toBe(600)
  })

  it('accepts a \\n-escaped private key (single-line env-var form)', async () => {
    const escaped = PRIV_PEM.replace(/\n/g, '\\n')
    const { calls } = stubFetch({ id_token: idToken({ sub: 'a1' }) })
    await new AppleProvider({ ...OPTS, privateKey: escaped }).exchangeCode('C')
    expect(verifySignature(clientSecretFrom(calls))).toBe(true) // parsed + signed → key round-tripped
  })
})

describe('AppleProvider.exchangeCode', () => {
  it('POSTs the code + minted secret to the token endpoint', async () => {
    const { calls } = stubFetch({ id_token: idToken({ sub: 'a1' }) })
    await new AppleProvider(OPTS).exchangeCode('THE_CODE')
    expect(calls[0].url).toBe('https://token.test/apple')
    expect(calls[0].init.method).toBe('POST')
    const body = calls[0].init.body as URLSearchParams
    expect(body.get('code')).toBe('THE_CODE')
    expect(body.get('client_id')).toBe(OPTS.clientId)
    expect(body.get('redirect_uri')).toBe(OPTS.redirectUri)
    expect(body.get('grant_type')).toBe('authorization_code')
  })

  it('reads the display name from the one-time `user` field (first login); picture is always null', async () => {
    stubFetch({ id_token: idToken({ sub: 'a1', email: 'a@b.com' }) })
    const profile = await new AppleProvider(OPTS).exchangeCode('C', {
      user: JSON.stringify({ name: { firstName: 'Jane', lastName: 'Doe' } }),
    })
    expect(profile).toEqual({ sub: 'a1', email: 'a@b.com', emailVerified: null, name: 'Jane Doe', picture: null })
  })

  it('returns name null on a later login (no `user` field) — callers treat null as "unchanged"', async () => {
    stubFetch({ id_token: idToken({ sub: 'a1', email: 'a@b.com' }) })
    const profile = await new AppleProvider(OPTS).exchangeCode('C') // no params
    expect(profile.name).toBeNull()
  })

  it('tolerates a partial or malformed `user` field', async () => {
    stubFetch({ id_token: idToken({ sub: 'a1' }) })
    const p = new AppleProvider(OPTS)
    expect((await p.exchangeCode('C', { user: JSON.stringify({ name: { firstName: 'Solo' } }) })).name).toBe('Solo')
    stubFetch({ id_token: idToken({ sub: 'a1' }) })
    expect((await p.exchangeCode('C', { user: JSON.stringify({ name: { lastName: 'Only' } }) })).name).toBe('Only')
    stubFetch({ id_token: idToken({ sub: 'a1' }) })
    expect((await p.exchangeCode('C', { user: 'not-json{' })).name).toBeNull()
    stubFetch({ id_token: idToken({ sub: 'a1' }) })
    expect((await p.exchangeCode('C', { user: JSON.stringify({ name: {} }) })).name).toBeNull()
  })

  it('nulls the email when the id_token omits it', async () => {
    stubFetch({ id_token: idToken({ sub: 'a1' }) })
    expect((await new AppleProvider(OPTS).exchangeCode('C')).email).toBeNull()
  })

  it('captures email_verified from Apple\'s string ("true"/"false") or boolean claim', async () => {
    stubFetch({ id_token: idToken({ sub: 'a1', email: 'a@b.com', email_verified: 'true' }) })
    expect((await new AppleProvider(OPTS).exchangeCode('C')).emailVerified).toBe(true)
    stubFetch({ id_token: idToken({ sub: 'a1', email: 'a@b.com', email_verified: false }) })
    expect((await new AppleProvider(OPTS).exchangeCode('C')).emailVerified).toBe(false)
    stubFetch({ id_token: idToken({ sub: 'a1' }) })
    expect((await new AppleProvider(OPTS).exchangeCode('C')).emailVerified).toBeNull()
  })

  it('throws apple_token_exchange_failed_<status> on a non-ok response', async () => {
    stubFetch({}, { ok: false, status: 400 })
    await expect(new AppleProvider(OPTS).exchangeCode('C')).rejects.toThrow('apple_token_exchange_failed_400')
  })

  it('throws apple_no_id_token when the response has no id_token', async () => {
    stubFetch({ access_token: 'x' })
    await expect(new AppleProvider(OPTS).exchangeCode('C')).rejects.toThrow('apple_no_id_token')
  })

  it('throws apple_no_sub when the id_token has no string sub', async () => {
    stubFetch({ id_token: idToken({ email: 'a@b.com' }) })
    await expect(new AppleProvider(OPTS).exchangeCode('C')).rejects.toThrow('apple_no_sub')
  })
})
