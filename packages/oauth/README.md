# @zantiflow/oauth

Framework-agnostic **Sign in with Google & Apple** for Node servers. You give a
provider its credentials; it gives you an authorization URL and, after the callback,
a **normalized profile**. It does not touch HTTP frameworks, sessions, cookies or
your database — *you* own routing, CSRF/state and user persistence. (For Express,
`@zantiflow/oauth-express` wires those parts up for you.)

Google and Apple's very different wire protocols are hidden behind one interface —
including Apple's ES256 client-secret JWT and its `form_post` callback.

```sh
npm install @zantiflow/oauth
```

## Usage

```ts
import { GoogleProvider, AppleProvider } from '@zantiflow/oauth'

const google = new GoogleProvider({
  clientId: process.env.GOOGLE_CLIENT_ID!,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  redirectUri: 'https://example.com/auth/google/callback',
})

const apple = new AppleProvider({
  clientId: process.env.APPLE_CLIENT_ID!,   // the Services ID
  teamId: process.env.APPLE_TEAM_ID!,
  keyId: process.env.APPLE_KEY_ID!,
  privateKey: process.env.APPLE_PRIVATE_KEY!, // .p8 contents (PEM); \n-escaped is fine
  redirectUri: 'https://example.com/auth/apple/callback',
})

// 1. Send the user to consent (sign & remember `state` yourself for CSRF):
res.redirect(google.buildAuthUrl(state))

// 2. On the callback, exchange the code for a normalized profile:
const profile = await google.exchangeCode(code)
// { sub, email, name, picture } — upsert your user, start your session
```

## The provider interface

```ts
interface OAuthProvider {
  readonly id: string                 // 'google' | 'apple' — your URL segment + stored provider
  readonly callbackMethod: 'GET' | 'POST'  // Apple returns via POST (form_post)
  buildAuthUrl(state: string): string
  exchangeCode(code: string, params?: Record<string, unknown>): Promise<OAuthProfile>
}

interface OAuthProfile {
  sub: string
  email: string | null
  name: string | null    // Apple sends it only on first login → null means "unchanged"
  picture: string | null // Apple never returns one
}
```

Implement `OAuthProvider` yourself to add Microsoft, GitHub, etc.

## Apple notes

- `callbackMethod` is `'POST'` — Apple posts the callback (`response_mode=form_post`)
  because the `name`/`email` scopes are requested. Pass the parsed body to
  `exchangeCode(code, body)` so the one-time `user` field (the display name) is read.
- `name` is populated **only on the first authorization**. On later logins it is
  `null` — treat that as "keep the stored name", don't overwrite it with a blank.
- The client secret is an ES256 JWT minted per call from your `.p8` key — nothing to
  manage or rotate at runtime.

## Requirements

Node ≥ 18 (uses the global `fetch` and `node:crypto`). Server-side only.
