'use client'

// Shared app header (v2 design): brand mark, nav tabs, theme toggle, and the account's real actions
// (redeem promo, enable notifications, avatar, sign out). Full-width + sticky. Used on every signed-in
// app page (dashboard, tokens, integrations, pair) so they share one header. The brand + "Machines"
// tab go to the dashboard; a "Home" link goes back to the public marketing page.
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { Me } from '@/lib/types'
import { getMe, logout } from '@/lib/api'
import { ThemeToggle } from './ThemeToggle'
import { EnableNotifications } from './EnableNotifications'
import { RedeemPromo } from './RedeemPromo'

const TABS = [
  { href: '/dashboard', label: 'Machines' },
  { href: '/tokens', label: 'Tokens' },
  { href: '/integrations', label: 'Integrations' },
  { href: '/pair', label: 'Pair' },
]
// Spotlight is PRO-only (ADR-0016) — only shown to PRO accounts. The backend also hard-gates the feed,
// so a hidden link is a UX nicety, not the enforcement.
const PRO_TABS = [{ href: '/spotlight', label: 'Spotlight' }]

export function TopBar({ me: meProp }: { me?: Me | null }) {
  // Pages that already fetch `me` (the dashboard) pass it in; otherwise self-fetch so any app page can
  // drop in <TopBar /> and get the same account-aware header without duplicating the request.
  const selfFetch = meProp === undefined
  const [meFetched, setMeFetched] = useState<Me | null>(null)
  useEffect(() => {
    if (selfFetch)
      getMe()
        .then(setMeFetched)
        .catch(() => setMeFetched(null))
  }, [selfFetch])
  const me = selfFetch ? meFetched : meProp

  const path = usePathname()
  const label = me?.name || me?.email || '?'
  const initial = label.trim().charAt(0).toUpperCase() || '?'

  return (
    <div className="appbar">
      <Link className="appbar-home" href="/dashboard" aria-label="zantiflow — go to dashboard">
        <img className="brand-logo" src="/icon.svg" width={22} height={22} alt="" aria-hidden="true" />
        <div className="appbar-brand">zantiflow</div>
      </Link>
      <nav className="appbar-nav">
        {[...TABS, ...(me?.tier === 'pro' ? PRO_TABS : [])].map((t) => (
          <Link key={t.href} className={path === t.href ? 'active' : undefined} href={t.href}>
            {t.label}
          </Link>
        ))}
        <Link href="/">Home</Link>
      </nav>
      <div className="appbar-right">
        <ThemeToggle />
        <RedeemPromo onRedeemed={() => window.location.reload()} />
        <EnableNotifications />
        {me && (
          <>
            <span className="appbar-email">
              {me.email ?? me.name}
              {me.tier === 'pro' && <span className="badge"> PRO</span>}
            </span>
            <div className="avatar" title={label}>
              {initial}
            </div>
          </>
        )}
        <button
          className="btn ghost"
          type="button"
          onClick={async () => {
            await logout().catch(() => {})
            window.location.href = '/'
          }}
        >
          Sign out
        </button>
      </div>
    </div>
  )
}
