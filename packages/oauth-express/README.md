# @zantiflow/oauth-express

An [Express](https://expressjs.com) router for **Sign in with Google & Apple**,
built on [`@zantiflow/oauth`](../oauth). It mounts the login + callback routes and
handles the shared HTTP plumbing (state, reading Apple's `form_post` body, the code
exchange, error responses). You provide four hooks — CSRF signing, session/storage —
so it stays unopinionated about *your* app.

```sh
npm install @zantiflow/oauth-express @zantiflow/oauth express
```

## Usage

```ts
import express from 'express'
import { GoogleProvider, AppleProvider } from '@zantiflow/oauth'
import { createOAuthRouter } from '@zantiflow/oauth-express'

const app = express()

app.use('/api/v1', createOAuthRouter({
  providers: [
    new GoogleProvider({ clientId, clientSecret, redirectUri }),
    new AppleProvider({ clientId, teamId, keyId, privateKey, redirectUri }),
  ],

  // Fold request-derived claims into the signed state (echoed back on callback):
  startState: (req) => ({
    mode: req.query.mode === 'popup' ? 'popup' : 'session',
    redirect: typeof req.query.redirect === 'string' ? req.query.redirect : '/',
  }),

  // Your CSRF hooks — any signed, expiring token mechanism:
  signState: (claims) => signMyToken(claims, { ttl: 600 }),
  verifyState: (token) => verifyMyToken(token),

  // Persist the user and write the response:
  onLogin: async (profile, { res, provider, state }) => {
    const user = await upsertUser(provider.id, profile) // { sub, email, name, picture }
    if (state.mode === 'popup') return sendPopupHtml(res, mintToken(user.id))
    setSessionCookie(res, user.id)
    res.redirect(typeof state.redirect === 'string' ? state.redirect : '/')
  },
}))
```

This mounts, for each provider:

| Route | Purpose |
|---|---|
| `GET /auth/<id>` | start login → redirect to consent |
| `GET \| POST /auth/<id>/callback` | provider returns here (Apple = POST/form_post) |

Routes are registered per provider with concrete paths, so they never shadow other
`/auth/*` routes you define (e.g. `/auth/logout`, `/auth/me`).

## Options

| Option | Required | Description |
|---|---|---|
| `providers` | ✓ | `OAuthProvider[]` from `@zantiflow/oauth` (or your own). |
| `signState(claims)` | ✓ | Return a signed, expiring state token. |
| `verifyState(token)` | ✓ | Return the claims, or `null` if invalid/expired. |
| `onLogin(profile, ctx)` | ✓ | Persist + respond. `ctx` = `{ provider, state, req, res }`. |
| `startState(req)` | | Extra claims to sign into the state at start. |
| `startMiddleware` | | Middleware for the start route(s) only (e.g. a rate limiter). |

## Error responses

`400 invalid_state` / `400 missing_code` / `400 <id>_denied` / `502 <id>_exchange_failed`.

## Publishing note

For local monorepo use this package depends on `@zantiflow/oauth` via
`file:../oauth`. Before `npm publish`, change that to a semver range (e.g. `^0.1.0`),
or publish both from an npm workspace that rewrites it for you.

## Requirements

Node ≥ 18. `express` is a peer dependency (`^4.17 || ^5`).
