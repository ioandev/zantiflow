'use client'

import Link from 'next/link'
import { type CSSProperties, useCallback, useEffect, useState } from 'react'
import { ApiError, approvePairing, getMe, signInHref, UnauthorizedError } from '@/lib/api'
import { approveErrorMessage, formatUserCode, isCompleteCode } from '@/lib/paircode'
import { TopBar } from '@/components/TopBar'

// Shared look for the copy-pasteable KDL / shell snippets in the "not seeing a code?" help block.
const snippet: CSSProperties = {
  margin: '8px 0 0',
  padding: '12px 14px',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontFamily: 'var(--font-mono), ui-monospace, monospace',
  fontSize: 13.5,
  lineHeight: 1.7,
  color: 'var(--tx2)',
  overflowX: 'auto',
  whiteSpace: 'pre',
}

export default function Pair() {
  const [status, setStatus] = useState<'loading' | 'anon' | 'ready'>('loading')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [paired, setPaired] = useState(false)
  // The plugin's `server_url` is the ingest endpoint, which external machines reach through THIS
  // public origin (the web tier proxies /api/v1 → backend; the backend isn't itself published).
  // Derive it from the served origin so the copy-paste snippet is correct on the hosted site and
  // for self-hosters alike. SSR-safe fallback to the hosted domain until the client hydrates.
  const [origin, setOrigin] = useState('https://zantiflow.com')
  useEffect(() => setOrigin(window.location.origin), [])

  // Owner approval requires a session; check first, and redirect anon users to sign-in.
  useEffect(() => {
    getMe()
      .then(() => setStatus('ready'))
      .catch((e) => setStatus(e instanceof UnauthorizedError ? 'anon' : 'ready'))
  }, [])

  // Convenience: prefill from ?code=… if the plugin ever links here with the code embedded.
  // Read from location directly (client-only) to avoid a Suspense boundary for useSearchParams.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('code')
    if (q) setCode(formatUserCode(q))
  }, [])

  const onSubmit = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await approvePairing(code)
      setPaired(true)
      setCode('')
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        setStatus('anon')
      } else if (e instanceof ApiError) {
        setError(approveErrorMessage(e.code, e.status))
      } else {
        setError(approveErrorMessage('unknown'))
      }
    } finally {
      setBusy(false)
    }
  }, [code])

  if (status === 'loading')
    return (
      <main className="wrap">
        <p className="muted">Loading…</p>
      </main>
    )

  if (status === 'anon')
    return (
      <main className="wrap">
        <div className="topbar">
          <Link className="brand" href="/dashboard">
            zantiflow
          </Link>
        </div>
        <h1>Pair a device</h1>
        <p className="muted">Sign in to approve the code shown in your plugin pane.</p>
        <p style={{ marginTop: 24 }}>
          <a className="btn" href={signInHref('/pair')}>
            Sign in
          </a>
        </p>
      </main>
    )

  return (
    <>
      <TopBar />
      <main className="wrap">
        <h1>Pair a device</h1>
        <p className="muted">
          Your Zellij plugin shows a code like <code>ABCD-EFGH</code> when it starts without a token. Enter it below to
          approve it — the plugin receives its ingest token automatically within a few seconds.
        </p>

        {paired && (
          <div className="banner">
            <p>
              <strong>Device paired ✓</strong>
            </p>
            <p className="muted">Return to your terminal — the plugin will connect and start reporting shortly.</p>
            <button className="btn ghost" type="button" onClick={() => setPaired(false)}>
              Pair another
            </button>
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (isCompleteCode(code) && !busy) void onSubmit()
          }}
          style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '16px 0' }}
        >
          <input
            aria-label="Pairing code"
            placeholder="ABCD-EFGH"
            value={code}
            onChange={(e) => {
              setCode(formatUserCode(e.target.value))
              setError(null)
            }}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            maxLength={9}
            style={{ letterSpacing: '0.15em', textTransform: 'uppercase', fontFamily: 'var(--mono, monospace)' }}
          />
          <button className="btn" type="submit" disabled={busy || !isCompleteCode(code)}>
            {busy ? 'Pairing…' : 'Approve'}
          </button>
        </form>

        {error && (
          <p className="muted" role="alert" style={{ color: 'var(--danger, #e5534b)' }}>
            {error}
          </p>
        )}

        <section className="banner" style={{ marginTop: 24 }}>
          <p>
            <strong>Not seeing a code?</strong>
          </p>
          <p className="muted" style={{ marginTop: 4 }}>
            The code prints inside the plugin&apos;s own pane, and only when it starts with no <code>token</code>. Add a{' '}
            <code>zantiflow</code> plugin to your <code>config.kdl</code>:
          </p>
          <pre style={snippet}>{`plugins {
    zantiflow location="file:/path/to/zantiflow_plugin.wasm" {
        server_url    "${origin}"

        // privacy — defaults shown, all optional (ADR-0002)
        full          "true"            // master switch: send names? per-field keys below override it
        machine_name  "alias:my-laptop" // real | alias:<name> | hidden
        session_names "send"            // send | hidden
        tab_names     "send"            // send | hidden
        pane_names    "send"            // send | hidden  (hides the pane title AND its command)

        // pane output + hostname — both OFF by default (ADR-0016 / ADR-0024)
        pane_output   "false"           // allow viewing a pane's last ~50 lines, upon your request only; relayed through the backend's memory, never written to its database
        hostname      "false"           // send the REAL hostname (only with machine_name "real")

        // leave \`token\` unset → the plugin pairs on launch and shows a code
    }
}`}</pre>
          <p className="muted" style={{ marginTop: 14 }}>
            Already running but you can&apos;t see the pane? Focus it from any terminal inside that Zellij session:
          </p>
          <pre style={snippet}>{`zellij action launch-or-focus-plugin --floating zantiflow`}</pre>
          <p className="muted" style={{ marginTop: 12 }}>
            Grant the permission prompt that appears in the pane — the pairing code shows right after. Prefer a manual
            token instead? Create one under <Link href="/tokens">Tokens</Link> (not{' '}
            <Link href="/integrations">Integrations</Link>, which is for Discord/Telegram notifications) and set it as{' '}
            <code>token</code> in the config above.
          </p>
        </section>
      </main>
    </>
  )
}
