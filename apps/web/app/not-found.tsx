// 404 page (Next App Router `not-found` convention). Rendered inside the root layout, so it inherits
// the theme, fonts, and globals.css tokens. Gives the visitor a clear "you're lost" signal plus the
// handful of places worth going next.
import type { Metadata } from 'next'
import Link from 'next/link'
import { ErrorShell } from '@/components/ErrorShell'
import { links } from '@/lib/links'

export const metadata: Metadata = {
  title: 'Page not found',
  robots: { index: false, follow: false },
}

export default function NotFound() {
  return (
    <ErrorShell code="404" title="This page wandered off.">
      <p className="nf-lede">
        The link may be broken, or the page may have moved. No session, tab, or pane lives here — try
        one of these instead.
      </p>

      {/* Decorative echo of the product's session → tab → pane tree. */}
      <pre className="nf-tree" aria-hidden="true">
        {`● session  web
  └ tab  `}
        <span className="nf-attn">404</span>
        {`
      └ pane  <not found>`}
      </pre>

      <div className="nf-actions">
        <Link className="nf-btn" href="/">
          Go to homepage
        </Link>
        <Link className="nf-btn ghost" href="/dashboard">
          Open dashboard
        </Link>
      </div>

      <div className="nf-links">
        <a href={links.getStarted} target="_blank" rel="noreferrer">
          Getting started ↗
        </a>
        <a href={links.docs} target="_blank" rel="noreferrer">
          Docs ↗
        </a>
        <a href={links.github} target="_blank" rel="noreferrer">
          GitHub ↗
        </a>
      </div>
    </ErrorShell>
  )
}
