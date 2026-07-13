import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { generateKeyPair, SignJWT, type KeyLike } from 'jose'
import { GoogleProvider, type GoogleProviderOptions } from '../src/google'

// Google's issuer + our client id. exchangeCode now VERIFIES the id_token against a JWKS,
// so the tests mint REAL RS256-signed tokens with a throwaway keypair and inject the
// matching public key via `keyResolver` — a forged/expired/wrong-aud token must be rejected.
const ISS = 'https://accounts.google.com'
const AUD = 'cid.apps.googleusercontent.com'

let priv: KeyLike // the "real" Google key the provider trusts (its public half is injected)
let pub: KeyLike
let attackerPriv: KeyLike // a key the provider does NOT trust — used to forge a signature

beforeAll(async () => {
  ;({ privateKey: priv, publicKey: pub } = await generateKeyPair('RS256'))
  ;({ privateKey: attackerPriv } = await generateKeyPair('RS256'))
})

// Mint a signed id_token. Defaults produce a valid token for AUD/ISS; overrides let a test
// forge the signature, target the wrong audience/issuer, or set an already-past expiry.
const signIdToken = async (
  claims: Record<string, unknown>,
  o: { key?: KeyLike; iss?: string; aud?: string; exp?: string | number } = {},
): Promise<string> =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(o.iss ?? ISS)
    .setAudience(o.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(o.exp ?? '2h')
    .sign(o.key ?? priv)

// Stub the GLOBAL fetch (GoogleProvider has no injectable fetch — only tokenUrl is
// overridable), record the request, return a canned token response.
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

// A fresh options bag per call — `keyResolver` injects the trusted public key so no real
// JWKS fetch happens. Tests that don't verify a token (buildAuthUrl) can use it too.
const mkOpts = (over: Partial<GoogleProviderOptions> = {}): GoogleProviderOptions => ({
  clientId: AUD,
  clientSecret: 'the-secret',
  redirectUri: 'https://app.example/cb',
  tokenUrl: 'https://token.test/token',
  keyResolver: pub,
  ...over,
})

describe('GoogleProvider — identity + buildAuthUrl', () => {
  it('has id "google" and a GET callback method', () => {
    const p = new GoogleProvider(mkOpts())
    expect(p.id).toBe('google')
    expect(p.callbackMethod).toBe('GET')
  })

  it('builds the consent URL with the expected params + defaults', () => {
    const url = new URL(new GoogleProvider(mkOpts()).buildAuthUrl('STATE'))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    const q = url.searchParams
    expect(q.get('client_id')).toBe(AUD)
    expect(q.get('redirect_uri')).toBe('https://app.example/cb')
    expect(q.get('response_type')).toBe('code')
    expect(q.get('scope')).toBe('openid email profile')
    expect(q.get('state')).toBe('STATE')
    expect(q.get('access_type')).toBe('online')
    expect(q.get('prompt')).toBe('select_account')
  })

  it('honours custom scope, prompt and authUrl', () => {
    const url = new URL(
      new GoogleProvider(mkOpts({ scope: 'openid', prompt: 'consent', authUrl: 'https://auth.test/a' })).buildAuthUrl(
        'S',
      ),
    )
    expect(url.origin + url.pathname).toBe('https://auth.test/a')
    expect(url.searchParams.get('scope')).toBe('openid')
    expect(url.searchParams.get('prompt')).toBe('consent')
  })
})

describe('GoogleProvider.exchangeCode', () => {
  it('POSTs the form-encoded credentials to the token endpoint', async () => {
    const { calls } = stubFetch({ id_token: await signIdToken({ sub: 'g1' }) })
    await new GoogleProvider(mkOpts()).exchangeCode('THE_CODE')
    expect(calls[0].url).toBe('https://token.test/token')
    expect(calls[0].init.method).toBe('POST')
    expect((calls[0].init.headers as Record<string, string>)['content-type']).toBe('application/x-www-form-urlencoded')
    const body = calls[0].init.body as URLSearchParams
    expect(body.get('code')).toBe('THE_CODE')
    expect(body.get('client_id')).toBe(AUD)
    expect(body.get('client_secret')).toBe('the-secret')
    expect(body.get('redirect_uri')).toBe('https://app.example/cb')
    expect(body.get('grant_type')).toBe('authorization_code')
  })

  it('maps a verified id_token payload to a normalized profile (incl. emailVerified)', async () => {
    stubFetch({
      id_token: await signIdToken({
        sub: 'g1',
        email: 'a@b.com',
        email_verified: true,
        name: 'Ann',
        picture: 'https://x/p.png',
      }),
    })
    expect(await new GoogleProvider(mkOpts()).exchangeCode('C')).toEqual({
      sub: 'g1',
      email: 'a@b.com',
      emailVerified: true,
      name: 'Ann',
      picture: 'https://x/p.png',
    })
  })

  it('captures email_verified: false', async () => {
    stubFetch({ id_token: await signIdToken({ sub: 'g1', email: 'a@b.com', email_verified: false }) })
    expect((await new GoogleProvider(mkOpts()).exchangeCode('C')).emailVerified).toBe(false)
  })

  it('reports emailVerified null when the claim is absent', async () => {
    stubFetch({ id_token: await signIdToken({ sub: 'g1', email: 'a@b.com' }) })
    expect((await new GoogleProvider(mkOpts()).exchangeCode('C')).emailVerified).toBeNull()
  })

  it('falls the name back to the email when no name is present, and nulls a missing picture', async () => {
    stubFetch({ id_token: await signIdToken({ sub: 'g1', email: 'a@b.com' }) })
    expect(await new GoogleProvider(mkOpts()).exchangeCode('C')).toEqual({
      sub: 'g1',
      email: 'a@b.com',
      emailVerified: null,
      name: 'a@b.com',
      picture: null,
    })
  })

  it('uses "User" when neither name nor email is present', async () => {
    stubFetch({ id_token: await signIdToken({ sub: 'g1' }) })
    expect(await new GoogleProvider(mkOpts()).exchangeCode('C')).toEqual({
      sub: 'g1',
      email: null,
      emailVerified: null,
      name: 'User',
      picture: null,
    })
  })

  it('throws google_token_exchange_failed_<status> on a non-ok token response', async () => {
    stubFetch({}, { ok: false, status: 401 })
    await expect(new GoogleProvider(mkOpts()).exchangeCode('C')).rejects.toThrow('google_token_exchange_failed_401')
  })

  it('throws google_no_id_token when the response has no id_token', async () => {
    stubFetch({ access_token: 'x', token_type: 'Bearer' })
    await expect(new GoogleProvider(mkOpts()).exchangeCode('C')).rejects.toThrow('google_no_id_token')
  })

  it('throws google_no_sub when a verified id_token has no string sub', async () => {
    stubFetch({ id_token: await signIdToken({ email: 'a@b.com' }) })
    await expect(new GoogleProvider(mkOpts()).exchangeCode('C')).rejects.toThrow('google_no_sub')
  })

  // --- hardening: the id_token must survive full JWKS verification ---

  it('rejects a forged signature (token signed by an untrusted key)', async () => {
    stubFetch({ id_token: await signIdToken({ sub: 'g1', email: 'a@b.com' }, { key: attackerPriv }) })
    await expect(new GoogleProvider(mkOpts()).exchangeCode('C')).rejects.toThrow('google_id_token_invalid')
  })

  it('rejects a token minted for a different audience (client)', async () => {
    stubFetch({ id_token: await signIdToken({ sub: 'g1' }, { aud: 'someone-else.apps.googleusercontent.com' }) })
    await expect(new GoogleProvider(mkOpts()).exchangeCode('C')).rejects.toThrow('google_id_token_invalid')
  })

  it('rejects a token from an unexpected issuer', async () => {
    stubFetch({ id_token: await signIdToken({ sub: 'g1' }, { iss: 'https://evil.example' }) })
    await expect(new GoogleProvider(mkOpts()).exchangeCode('C')).rejects.toThrow('google_id_token_invalid')
  })

  it('rejects an expired token', async () => {
    // exp set 60s in the past → jose's jwtVerify throws → we surface google_id_token_invalid.
    const pastExp = Math.floor(Date.now() / 1000) - 60
    stubFetch({ id_token: await signIdToken({ sub: 'g1' }, { exp: pastExp }) })
    await expect(new GoogleProvider(mkOpts()).exchangeCode('C')).rejects.toThrow('google_id_token_invalid')
  })

  it('rejects a structurally malformed id_token', async () => {
    stubFetch({ id_token: 'not-a-jwt' })
    await expect(new GoogleProvider(mkOpts()).exchangeCode('C')).rejects.toThrow('google_id_token_invalid')
  })
})
