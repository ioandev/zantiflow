'use client'

// The single sign-in surface (ADR-0035). Every "Sign in" entry point routes here; this page asks the
// backend which owner-auth methods it offers (`/auth/methods`) and renders accordingly, so the SAME
// web image serves both the Google-only hosted deployment and self-hosters who set a secret:
//   • Google only  → forward straight to Google (hosted stays effectively one-click)
//   • secret set   → show a secret form
//   • both         → show both
// Reading `redirect` from location (client-only) avoids a useSearchParams Suspense boundary.
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { ApiError, type AuthMethods, getAuthMethods, getMe, loginHref, loginWithSecret } from '@/lib/api'

// Same-site relative redirect only — mirror the backend's `safeRedirect` intent for the client nav.
const sanitizeRedirect = (value: string | null): string =>
  value && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : '/dashboard'

export default function Login() {
  const [status, setStatus] = useState<'loading' | 'ready'>('loading')
  const [methods, setMethods] = useState<AuthMethods | null>(null)
  const [redirect, setRedirect] = useState('/dashboard')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const target = sanitizeRedirect(new URLSearchParams(window.location.search).get('redirect'))
    setRedirect(target)
    void (async () => {
      // Already signed in → straight to the target, don't show a login form.
      try {
        await getMe()
        if (!cancelled) window.location.href = target
        return
      } catch {
        // not signed in — decide which methods to offer
      }
      let m: AuthMethods
      try {
        m = await getAuthMethods()
      } catch {
        if (!cancelled) {
          setError('Could not load sign-in options. Refresh to try again.')
          setStatus('ready')
        }
        return
      }
      if (cancelled) return
      // Keep hosted sign-in one-click: when Google is the only method, forward immediately.
      if (m.google && !m.local) {
        window.location.href = loginHref(target)
        return
      }
      setMethods(m)
      setStatus('ready')
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const onSubmit = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await loginWithSecret(secret)
      window.location.href = redirect
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 429
          ? 'Too many attempts. Please wait a moment and try again.'
          : 'Incorrect secret.',
      )
      setBusy(false)
    }
  }, [secret, redirect])

  if (status === 'loading')
    return (
      <main className="wrap">
        <p className="muted">Loading…</p>
      </main>
    )

  return (
    <main className="wrap">
      <div className="topbar">
        <Link className="brand" href="/">
          zantiflow
        </Link>
      </div>
      <h1>Sign in</h1>

      {methods?.google && (
        <p style={{ marginTop: 16 }}>
          <a className="btn" href={loginHref(redirect)}>
            Sign in with Google
          </a>
        </p>
      )}

      {methods?.google && methods?.local && (
        <p className="muted" style={{ margin: '16px 0 8px' }}>
          — or —
        </p>
      )}

      {methods?.local && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (secret && !busy) void onSubmit()
          }}
          style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}
        >
          <input
            type="password"
            aria-label="Sign-in secret"
            placeholder="Sign-in secret"
            value={secret}
            onChange={(e) => {
              setSecret(e.target.value)
              setError(null)
            }}
            autoComplete="current-password"
            spellCheck={false}
            style={{ minWidth: 260 }}
          />
          <button className="btn" type="submit" disabled={busy || !secret}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      )}

      {methods && !methods.google && !methods.local && (
        <p className="muted" style={{ marginTop: 16 }}>
          No sign-in method is configured on this deployment.
        </p>
      )}

      {error && (
        <p className="muted" role="alert" style={{ color: 'var(--danger, #e5534b)', marginTop: 12 }}>
          {error}
        </p>
      )}
    </main>
  )
}
