import Link from 'next/link'

// Shared visual chrome for the full-page error/empty states (404, runtime error). Presentational only
// — no hooks — so it works in both the server-rendered not-found page and the client error boundary.
// Styling is `.nf-*` in globals.css (theme-aware). Note: global-error.tsx can NOT use this — it
// replaces the root layout, so globals.css / next/font / the theme script aren't loaded — and is
// self-contained instead.
export function ErrorShell({ code, title, children }: { code: string; title: string; children: React.ReactNode }) {
  return (
    <main className="nf">
      <div className="nf-card">
        <Link href="/" className="nf-brand" aria-label="zantiflow home">
          <img className="brand-logo" src="/icon.svg" width={22} height={22} alt="" aria-hidden="true" />
          <span className="appbar-brand">zantiflow</span>
        </Link>
        <div className="nf-code">{code}</div>
        <h1 className="nf-title">{title}</h1>
        {children}
      </div>
    </main>
  )
}
