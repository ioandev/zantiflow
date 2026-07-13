// Hero (HOMEPAGE.md §2.1): eyebrow → headline → subhead → two front doors (Get started = install the
// plugin, the real activation event; Sign in = account/token setup) → tertiary links → promo → the
// product-as-hero dashboard mock.
import Link from 'next/link'
import type { Me } from '@/lib/types'
import { signInHref } from '@/lib/api'
import { links } from '@/lib/links'
import { HomePromo } from './HomePromo'
import { DashboardMock } from './DashboardMock'

export function Hero({ me }: { me?: Me | null }) {
  return (
    <section className="hp-hero" aria-labelledby="hp-hero-h">
      <div className="hp-eyebrow">A Zellij plugin + live dashboard</div>
      <h1 id="hp-hero-h" className="hp-h1">
        Know the moment your terminal needs you.
      </h1>
      <p className="hp-lede">
        A Zellij plugin reports your sessions → tabs → panes to a live dashboard, once a second — and pings you when a
        pane needs your attention, like a Claude session waiting on input. Redaction happens in the plugin, before
        anything is sent.
      </p>
      <div className="hp-cta-row">
        <a className="hp-btn" href={links.getStarted}>
          Get started
        </a>
        {me ? (
          <Link className="hp-btn ghost" href="/dashboard">
            Open dashboard
          </Link>
        ) : (
          <a className="hp-btn ghost" href={signInHref('/dashboard')}>
            Sign in
          </a>
        )}
      </div>
      <div className="hp-tertiary">
        <a href="#how">See how it works ↓</a>
        <a href={links.github} target="_blank" rel="noreferrer">
          GitHub ↗
        </a>
      </div>
      <HomePromo />
      <DashboardMock />
    </section>
  )
}
