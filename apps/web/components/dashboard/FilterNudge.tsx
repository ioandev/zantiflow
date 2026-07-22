'use client'

// One-shot frustration toast (ADR-0053): shown after repeated refreshes — the ↻ button or the
// browser's own reload — pointing at the toolbar filters (the usual reason "my data isn't there",
// e.g. the Claude-only default hiding a session with no Claude panes) and at the troubleshooting
// guide. Fixed to the bottom of the viewport; dismissible; never re-nags.
import { links } from '@/lib/links'
import { NUDGE_TEXT } from '@/lib/refreshNudge'

export function FilterNudge({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      className="banner"
      role="status"
      style={{
        position: 'fixed',
        bottom: 18,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 40,
        margin: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        maxWidth: 'calc(100vw - 32px)',
        boxShadow: '0 6px 24px rgba(0, 0, 0, 0.35)',
      }}
    >
      <span>
        {NUDGE_TEXT}
        {' · '}
        <a href={links.troubleshooting} target="_blank" rel="noreferrer">
          Troubleshooting guide →
        </a>
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{
          font: 'inherit',
          lineHeight: 1,
          padding: '2px 7px',
          borderRadius: 5,
          border: '1px solid currentColor',
          background: 'transparent',
          color: 'inherit',
          opacity: 0.7,
          cursor: 'pointer',
        }}
      >
        ✕
      </button>
    </div>
  )
}
