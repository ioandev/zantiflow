// Google OAuth (Authorization Code flow). The auth `code` is exchanged server-to-server
// (over TLS, authenticated with the client secret). The returned id_token is then
// cryptographically VERIFIED against Google's JWKS — signature, `aud` (must equal our
// clientId), `iss`, and `exp` — before ANY claim is trusted. This is defense-in-depth on
// top of the server-to-server transport: the package will refuse to derive a profile from
// a forged, tampered, expired, or browser-transited id_token (ADR-0004; security-audit A8).
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import type { OAuthProfile, OAuthProvider } from './types'

/** A verification key or a jose key-resolver (a `createRemoteJWKSet` result / a test key). */
type VerifyKey = Parameters<typeof jwtVerify>[1]

export interface GoogleProviderOptions {
  /** OAuth client id (the `...apps.googleusercontent.com` value). */
  clientId: string
  /** OAuth client secret. */
  clientSecret: string
  /** Redirect URI — must exactly match one registered in the Google console. */
  redirectUri: string
  /** OAuth scopes (space-separated). Default: `openid email profile`. */
  scope?: string
  /** `prompt` param. Default: `select_account`. */
  prompt?: string
  /** Override the authorization endpoint (for testing). */
  authUrl?: string
  /** Override the token endpoint (for testing). */
  tokenUrl?: string
  /** Override the JWKS endpoint used to verify id_token signatures (for testing). */
  jwksUri?: string
  /** Inject the verification key/resolver directly, bypassing the remote JWKS fetch — for
   *  testing, or to supply a pre-fetched key set. Takes precedence over `jwksUri`. */
  keyResolver?: VerifyKey
}

const DEFAULT_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token'
// Google publishes its id_token signing keys here (rotated; jose caches + refreshes).
const DEFAULT_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
// Google stamps tokens with either the bare or the https issuer form; accept both.
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

export class GoogleProvider implements OAuthProvider {
  readonly id = 'google'
  readonly callbackMethod = 'GET' as const
  private jwks?: VerifyKey

  constructor(private readonly opts: GoogleProviderOptions) {}

  /** The verification key: an injected key/resolver, else a cached remote JWKS. */
  private verifyKey(): VerifyKey {
    if (this.opts.keyResolver) return this.opts.keyResolver
    if (!this.jwks) this.jwks = createRemoteJWKSet(new URL(this.opts.jwksUri ?? DEFAULT_JWKS_URL))
    return this.jwks
  }

  buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.opts.clientId,
      redirect_uri: this.opts.redirectUri,
      response_type: 'code',
      scope: this.opts.scope ?? 'openid email profile',
      state,
      access_type: 'online',
      prompt: this.opts.prompt ?? 'select_account',
    })
    return `${this.opts.authUrl ?? DEFAULT_AUTH_URL}?${params.toString()}`
  }

  async exchangeCode(code: string): Promise<OAuthProfile> {
    const res = await fetch(this.opts.tokenUrl ?? DEFAULT_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        redirect_uri: this.opts.redirectUri,
        grant_type: 'authorization_code',
      }),
    })
    if (!res.ok) throw new Error(`google_token_exchange_failed_${res.status}`)
    const data = (await res.json()) as { id_token?: string }
    if (!data.id_token) throw new Error('google_no_id_token')

    // Verify signature + aud + iss + exp. A bad signature (forgery/tampering), a token
    // minted for a different client, a wrong issuer, or an expired token all reject here.
    let payload: JWTPayload
    try {
      ;({ payload } = await jwtVerify(data.id_token, this.verifyKey(), {
        issuer: GOOGLE_ISSUERS,
        audience: this.opts.clientId,
      }))
    } catch {
      throw new Error('google_id_token_invalid')
    }

    if (typeof payload.sub !== 'string') throw new Error('google_no_sub')
    const email = typeof payload.email === 'string' ? payload.email : null
    return {
      sub: payload.sub,
      email,
      emailVerified: typeof payload.email_verified === 'boolean' ? payload.email_verified : null,
      name: typeof payload.name === 'string' ? payload.name : (email ?? 'User'),
      picture: typeof payload.picture === 'string' ? payload.picture : null,
    }
  }
}
