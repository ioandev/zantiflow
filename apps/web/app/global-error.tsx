'use client'

// Root error boundary (Next App Router `global-error` convention). This catches errors thrown by the
// ROOT layout itself, and REPLACES it — so it must render its own <html>/<body> and cannot rely on
// globals.css, next/font, or the pre-paint theme script. Kept deliberately self-contained and minimal
// (inline styles, system fonts, media-query theming) so it still renders when the app shell is broken.

// Brand tokens inlined (globals.css isn't loaded here); dark variant via prefers-color-scheme.
const css = `
  .ge-wrap{min-height:100vh;box-sizing:border-box;display:flex;align-items:center;justify-content:center;
    padding:48px 24px;background:#f5f7f9;color:#1c242e;
    font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
  .ge-card{width:100%;max-width:520px}
  .ge-brand{margin:0 0 22px;font:600 14px ui-monospace,SFMono-Regular,Menlo,monospace;color:#61707e}
  .ge-code{margin:0;font:700 clamp(56px,12vw,88px)/1 ui-monospace,SFMono-Regular,Menlo,monospace;
    letter-spacing:-.03em;color:#1c242e}
  .ge-title{margin:12px 0 0;font-size:clamp(22px,4vw,28px);font-weight:700;color:#1c242e}
  .ge-lede{margin:12px 0 24px;max-width:440px;font-size:16px;line-height:1.6;color:#61707e}
  .ge-actions{display:flex;flex-wrap:wrap;gap:10px}
  .ge-btn{display:inline-block;padding:11px 22px;border-radius:9px;cursor:pointer;text-decoration:none;
    font:600 14px inherit;color:#fff;background:#2f6fd0;border:1px solid transparent}
  .ge-btn.ghost{font-weight:500;color:#1c242e;background:#fff;border-color:#e4e9ee}
  .ge-note{margin:22px 0 0;font:400 12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#8b98a5}
  @media (prefers-color-scheme:dark){
    .ge-wrap{background:#0b0e14;color:#e6edf3}
    .ge-brand,.ge-lede{color:#8b98a5}
    .ge-code,.ge-title{color:#f0f6fc}
    .ge-btn.ghost{color:#e6edf3;background:#14181d;border-color:#242a31}
  }
`

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="en">
      <body>
        <style dangerouslySetInnerHTML={{ __html: css }} />
        <div className="ge-wrap">
          <div className="ge-card">
            <p className="ge-brand">zantiflow</p>
            <p className="ge-code">500</p>
            <h1 className="ge-title">Something went wrong.</h1>
            <p className="ge-lede">
              The app hit an unexpected error and couldn&rsquo;t finish loading. Reloading usually fixes
              it.
            </p>
            <div className="ge-actions">
              <button type="button" className="ge-btn" onClick={reset}>
                Reload
              </button>
              <a className="ge-btn ghost" href="/">
                Go to homepage
              </a>
            </div>
            {error.digest ? <p className="ge-note">Reference: {error.digest}</p> : null}
          </div>
        </div>
      </body>
    </html>
  )
}
