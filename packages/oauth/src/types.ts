// The provider contract. A provider knows how to send a user to a consent screen
// and how to turn the returned auth code into a normalized profile — nothing else.
// It is framework-agnostic: no HTTP framework, no session, no persistence. The host
// application owns routing, CSRF/state, sessions and user storage.

/** A normalized identity read from a provider's id_token / userinfo. */
export interface OAuthProfile {
  /** Provider-stable subject id — your app's stable external user id. */
  sub: string
  /** May be null (e.g. Apple's private relay, or a provider that omits it). */
  email: string | null
  /** Whether the provider asserts this email is verified, or null when it doesn't say.
   *  Only trust `email` as an identity/account-linking key when this is `true`. */
  emailVerified: boolean | null
  /** Display name, or null when the provider doesn't return one on this request.
   *  Apple only sends the name on the FIRST authorization — a null here means
   *  "unchanged", so callers must not overwrite an already-stored name with it. */
  name: string | null
  /** Avatar URL, or null when the provider has none (Apple never returns one). */
  picture: string | null
}

export interface OAuthProvider {
  /** Stable id — used as the URL segment (`/auth/<id>`) and as your stored
   *  account provider. Built-ins are `'google'` and `'apple'`. */
  readonly id: string
  /** How the provider returns to the callback: Google via GET (query params),
   *  Apple via POST (`response_mode=form_post`, forced by its name/email scopes). */
  readonly callbackMethod: 'GET' | 'POST'
  /** Build the consent URL to redirect the user to. `state` is an opaque token the
   *  host signs (CSRF protection) and gets back on the callback. */
  buildAuthUrl(state: string): string
  /** Exchange the auth `code` for a normalized profile. `params` is the full
   *  callback parameter bag (query for GET, parsed body for POST) so a provider can
   *  read its extras — e.g. Apple's one-time `user` JSON carrying the name. */
  exchangeCode(code: string, params?: Record<string, unknown>): Promise<OAuthProfile>
}
