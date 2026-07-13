// Shared Open Graph / Twitter social-card renderer (HOMEPAGE.md §6). Rendered on-demand by the
// `opengraph-image` / `twitter-image` file conventions into a 1200×630 PNG, so a shared link (dev
// Slack, X, Discord) shows a branded card instead of a bare URL. Built with `next/og` (satori) on the
// Node runtime — fully self-contained, no external fetch — so it works offline and in the standalone
// Docker image (ADR-0021). Colours come straight from the canonical design system (globals.css).
import { ImageResponse } from 'next/og'

export const OG_SIZE = { width: 1200, height: 630 } as const
export const OG_CONTENT_TYPE = 'image/png' as const
export const OG_ALT = 'zantiflow — live Zellij session dashboard with attention notifications'

// The real logo mark (public/icon.svg), inlined as a data URI so the card is self-contained.
const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
  '<rect width="512" height="512" rx="96" fill="#0b0e14"/>' +
  '<g fill="none" stroke="#5eb1ef" stroke-width="28" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M148 176 L220 256 L148 336"/><path d="M264 336 L364 336"/></g>' +
  '<circle cx="392" cy="152" r="26" fill="#7ee787"/></svg>'
const ICON_URI = `data:image/svg+xml;base64,${Buffer.from(ICON_SVG).toString('base64')}`

const PILLS = ['Free', 'Open source', 'Privacy-first', 'Self-hostable']

// Note: satori requires an explicit `display: flex` on any element with multiple children.
export function renderOgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: 'linear-gradient(135deg, #0b0e14 0%, #0d1622 60%, #101d2b 100%)',
          color: '#e6edf3',
          padding: '76px 84px',
          fontFamily: 'sans-serif',
        }}
      >
        {/* Brand row */}
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {/* satori (next/og) renders raw <img>; next/image is not applicable here */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={ICON_URI} width={76} height={76} alt="" />
          <div style={{ display: 'flex', marginLeft: 26, fontSize: 46, fontWeight: 600, letterSpacing: -1 }}>
            zantiflow
          </div>
        </div>

        {/* Headline + subhead */}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              display: 'flex',
              fontSize: 78,
              fontWeight: 700,
              lineHeight: 1.04,
              letterSpacing: -2,
              maxWidth: 1000,
              color: '#f0f6fc',
            }}
          >
            Know the moment your terminal needs you.
          </div>
          <div style={{ display: 'flex', marginTop: 30, fontSize: 31, lineHeight: 1.32, maxWidth: 980, color: '#8b98a5' }}>
            A Zellij plugin streams your sessions → tabs → panes to a live dashboard — and pings you when a pane needs
            you, like a Claude session waiting on input.
          </div>
        </div>

        {/* Footer pills */}
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {PILLS.map((label, i) => (
            <div
              key={label}
              style={{
                display: 'flex',
                alignItems: 'center',
                marginRight: 18,
                padding: '12px 22px',
                fontSize: 26,
                color: '#adbac7',
                border: '1px solid #21324a',
                borderRadius: 999,
                background: 'rgba(94, 177, 239, 0.06)',
              }}
            >
              {i === 0 ? (
                <div
                  style={{ display: 'flex', width: 12, height: 12, borderRadius: 999, background: '#7ee787', marginRight: 12 }}
                />
              ) : null}
              {label}
            </div>
          ))}
        </div>
      </div>
    ),
    { ...OG_SIZE },
  )
}
