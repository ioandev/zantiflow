'use client'

// Runtime error boundary (Next App Router `error` convention — must be a Client Component). Catches
// errors thrown while rendering a page or its nested segments, below the root layout. `reset()` re-runs
// the failed render (often enough to recover from a transient blip). Rendered inside the root layout,
// so it reuses the shared shell + `.nf-*` styles.
import { useEffect } from 'react'
import Link from 'next/link'
import { ErrorShell } from '@/components/ErrorShell'
import { links } from '@/lib/links'

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Surface for debugging. There is no client error-reporting sink by design (privacy-first).
    console.error(error)
  }, [error])

  return (
    <ErrorShell code="500" title="Something went wrong.">
      <p className="nf-lede">
        An unexpected error interrupted this page — it's almost certainly not you. Trying again often clears it; if it
        keeps happening, reporting it on GitHub helps.
      </p>

      <div className="nf-actions">
        <button type="button" className="nf-btn" onClick={reset}>
          Try again
        </button>
        <Link className="nf-btn ghost" href="/">
          Go to homepage
        </Link>
      </div>

      <div className="nf-links">
        <a href={links.docs} target="_blank" rel="noreferrer">
          Docs ↗
        </a>
        <a href={links.github} target="_blank" rel="noreferrer">
          Report on GitHub ↗
        </a>
      </div>

      {error.digest ? <p className="nf-note">Reference: {error.digest}</p> : null}
    </ErrorShell>
  )
}
