# @zantiflow/oauth-react

A tiny React hook for **popup-based OAuth sign-in**. It opens your login popup (which
is first-party on your own origin, so no third-party-cookie problems), listens for
the **origin-checked `postMessage`** the popup posts back with the identity token, and
hands it to you. Zero dependencies beyond React. Pairs naturally with
[`@zantiflow/oauth-express`](../oauth-express), but works with any backend that
posts `{ type, token }` back to the opener.

```sh
npm install @zantiflow/oauth-react react
```

## Usage

```tsx
'use client'
import { useOAuthPopup } from '@zantiflow/oauth-react'

function SignInButton() {
  const { signIn, pending, token } = useOAuthPopup('/api/v1/auth/google?mode=popup', {
    onToken: (t) => localStorage.setItem('ct_user', t), // you decide where it lives
  })

  return (
    <button onClick={signIn} disabled={pending}>
      {pending ? 'Signing in…' : 'Sign in with Google'}
    </button>
  )
}
```

The popup's final page must post the token back to its opener, e.g.:

```js
window.opener.postMessage({ type: 'oauth', token }, targetOrigin)
window.close()
```

## API

```ts
useOAuthPopup(authUrl: string, options?: {
  messageType?: string       // postMessage `type` to accept — default 'oauth'
  allowedOrigin?: string     // required message origin — default window.location.origin
  features?: string          // popup window features — default 'width=460,height=600'
  windowName?: string        // popup target name — default 'oauth-login'
  onToken?: (token) => void  // called on success
  onCancel?: () => void      // popup blocked or closed before completing
}): { signIn: () => void; pending: boolean; token: string | null }
```

## Security

- The token is accepted **only** when `event.origin` equals `allowedOrigin`
  (defaults to your own origin — the popup is first-party).
- The hook never writes the token anywhere — it hands it to `onToken`, so in a
  third-party iframe you can keep it in memory / partitioned storage and it never
  reaches the host page.

## Requirements

React ≥ 18 (peer dependency). Client-side only (the module is marked `'use client'`).
