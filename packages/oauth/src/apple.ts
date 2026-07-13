// Sign in with Apple (web, Authorization Code flow). Apple differs from Google in
// two ways this class hides behind the same OAuthProvider interface:
//
//   1. The `client_secret` is NOT a static string. It's a short-lived JWT minted per
//      exchange, signed with ES256 using the .p8 private key Apple issued (keyed by
//      Team ID + Key ID). See `makeClientSecret`.
//   2. Because the name/email scopes are requested, Apple returns to the callback as
//      a POST (`response_mode=form_post`) and sends the display name ONLY on the
//      FIRST authorization, in a form field `user` (JSON). The id_token never carries
//      the name or an avatar. So `name` is null on every later login, and callers
//      must treat that as "unchanged" rather than blanking the stored name.
import { createPrivateKey, sign as ecdsaSign } from 'node:crypto'
import { decodeIdTokenPayload } from './idToken'
import type { OAuthProfile, OAuthProvider } from './types'

export interface AppleProviderOptions {
  /** The Services ID (e.g. `com.example.yoursite.svc`) — Apple's OAuth client id. */
  clientId: string
  /** Apple Developer Team ID (10 chars). */
  teamId: string
  /** Key ID of the "Sign in with Apple" key (10 chars). */
  keyId: string
  /** The .p8 private key contents (PEM). Real newlines or `\n`-escaped both work. */
  privateKey: string
  /** Redirect URI — must exactly match a Return URL registered for the Services ID. */
  redirectUri: string
  /** OAuth scopes. Default: `name email` (which forces `response_mode=form_post`). */
  scope?: string
  /** Client-secret JWT lifetime in seconds (Apple allows up to 6 months). Default 3600. */
  clientSecretTtlSeconds?: number
  /** Override the authorization endpoint (for testing). */
  authUrl?: string
  /** Override the token endpoint (for testing). */
  tokenUrl?: string
}

const DEFAULT_AUTH_URL = 'https://appleid.apple.com/auth/authorize'
const DEFAULT_TOKEN_URL = 'https://appleid.apple.com/auth/token'
const AUDIENCE = 'https://appleid.apple.com'

const b64url = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')

/** Apple sends the name once, on first login, as a JSON `user` form field. */
const nameFromUserField = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const u = JSON.parse(raw) as { name?: { firstName?: string; lastName?: string } }
    const parts = [u.name?.firstName, u.name?.lastName].filter((s): s is string => !!s)
    return parts.length ? parts.join(' ') : null
  } catch {
    return null // malformed → treat as no name given
  }
}

export class AppleProvider implements OAuthProvider {
  readonly id = 'apple'
  readonly callbackMethod = 'POST' as const

  constructor(private readonly opts: AppleProviderOptions) {}

  /** Mint the ES256 client-secret JWT Apple's token endpoint requires. */
  private makeClientSecret(): string {
    const now = Math.floor(Date.now() / 1000)
    const header = { alg: 'ES256', kid: this.opts.keyId }
    const payload = {
      iss: this.opts.teamId,
      iat: now,
      exp: now + (this.opts.clientSecretTtlSeconds ?? 3600),
      aud: AUDIENCE,
      sub: this.opts.clientId,
    }
    const signingInput = `${b64url(header)}.${b64url(payload)}`
    const key = createPrivateKey({ key: this.opts.privateKey.replace(/\\n/g, '\n'), format: 'pem' })
    // JWS ES256 wants the raw r||s signature (IEEE P1363), not ASN.1/DER.
    const sig = ecdsaSign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' })
    return `${signingInput}.${sig.toString('base64url')}`
  }

  buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.opts.clientId,
      redirect_uri: this.opts.redirectUri,
      response_type: 'code',
      scope: this.opts.scope ?? 'name email',
      // Requesting name/email forces form_post — Apple rejects the query mode then.
      response_mode: 'form_post',
      state,
    })
    return `${this.opts.authUrl ?? DEFAULT_AUTH_URL}?${params.toString()}`
  }

  async exchangeCode(code: string, params: Record<string, unknown> = {}): Promise<OAuthProfile> {
    const res = await fetch(this.opts.tokenUrl ?? DEFAULT_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.opts.clientId,
        client_secret: this.makeClientSecret(),
        redirect_uri: this.opts.redirectUri,
        grant_type: 'authorization_code',
      }),
    })
    if (!res.ok) throw new Error(`apple_token_exchange_failed_${res.status}`)
    const data = (await res.json()) as { id_token?: string }
    if (!data.id_token) throw new Error('apple_no_id_token')

    const p = decodeIdTokenPayload(data.id_token)
    if (typeof p.sub !== 'string') throw new Error('apple_no_sub')
    // Apple sends email_verified as a boolean or the string "true"/"false".
    const ev = p.email_verified
    return {
      sub: p.sub,
      email: typeof p.email === 'string' ? p.email : null,
      emailVerified: ev === true || ev === 'true' ? true : ev === false || ev === 'false' ? false : null,
      name: nameFromUserField(params.user), // null on every login after the first
      picture: null, // Apple provides no avatar
    }
  }
}
