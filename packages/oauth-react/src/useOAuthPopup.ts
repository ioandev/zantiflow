'use client'
// A React hook for popup-based OAuth sign-in. It opens the provider's login popup
// (which is first-party on your own origin, so there are no third-party-cookie
// problems), listens for the origin-checked `postMessage` the popup posts back with
// the identity token, and hands it to you. It does not persist the token — that's
// your app's decision (memory, storage, context…).
import { useCallback, useEffect, useRef, useState } from 'react'

export interface UseOAuthPopupOptions {
  /** The `type` field the popup's postMessage must carry. Default: `'oauth'`. */
  messageType?: string
  /** Origin the popup message must come from. Default: the current window origin
   *  (the popup is first-party on your own domain). */
  allowedOrigin?: string
  /** Popup window features. Default: `'width=460,height=600'`. */
  features?: string
  /** Popup window target name. Default: `'oauth-login'`. */
  windowName?: string
  /** Called with the token when sign-in succeeds. */
  onToken?: (token: string) => void
  /** Called if the popup is blocked, or closed before completing. */
  onCancel?: () => void
}

export interface UseOAuthPopupResult {
  /** Open the sign-in popup. Wire directly to a button's `onClick`. */
  signIn: () => void
  /** True while a popup is open and awaiting the token. */
  pending: boolean
  /** The most recently received token (also delivered via `onToken`). */
  token: string | null
}

const DEFAULT_FEATURES = 'width=460,height=600'

/**
 * @param authUrl The URL to open in the popup — your backend's login-start endpoint,
 *   e.g. `/api/v1/auth/google?mode=popup`. It must ultimately post
 *   `{ type: messageType, token }` back to the opener.
 */
export function useOAuthPopup(authUrl: string, options: UseOAuthPopupOptions = {}): UseOAuthPopupResult {
  const {
    messageType = 'oauth',
    allowedOrigin,
    features = DEFAULT_FEATURES,
    windowName = 'oauth-login',
    onToken,
    onCancel,
  } = options

  const [pending, setPending] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  // Teardown for the in-flight attempt, so a new signIn() or unmount can cancel it.
  const cleanupRef = useRef<(() => void) | null>(null)

  const signIn = useCallback(() => {
    if (typeof window === 'undefined') return
    cleanupRef.current?.() // abandon any prior attempt

    const origin = allowedOrigin ?? window.location.origin
    const popup = window.open(authUrl, windowName, features)
    if (!popup) {
      onCancel?.()
      return
    } // blocked by the browser
    setPending(true)

    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin) return // the popup is same-origin as us
      const m = e.data as { type?: string; token?: string } | null
      if (m?.type !== messageType || !m.token) return
      setToken(m.token)
      onToken?.(m.token)
      cleanup()
    }

    const poll = window.setInterval(() => {
      if (popup.closed) {
        cleanup()
        onCancel?.()
      }
    }, 500)

    const cleanup = () => {
      window.clearInterval(poll)
      window.removeEventListener('message', onMessage)
      setPending(false)
      cleanupRef.current = null
    }

    window.addEventListener('message', onMessage)
    cleanupRef.current = cleanup
  }, [authUrl, messageType, allowedOrigin, features, windowName, onToken, onCancel])

  // Tear down a still-pending attempt if the component unmounts.
  useEffect(() => () => cleanupRef.current?.(), [])

  return { signIn, pending, token }
}
