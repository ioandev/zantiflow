// Sticky marketing nav (HOMEPAGE.md §2.1): brand mark, in-page anchors, docs, theme toggle. The right
// side reflects the session — a signed-in visitor sees a "Dashboard" link + their avatar; everyone else
// sees "Sign in".
import Link from 'next/link'
import type { Me } from '@/lib/types'
import { signInHref } from '@/lib/api'
import { links } from '@/lib/links'
import { ThemeToggle } from '@/components/ThemeToggle'
import { BrandMark } from '@/components/BrandMark'

export function HomeNav({ me }: { me?: Me | null }) {
  const label = me?.name || me?.email || '?'
  const initial = label.trim().charAt(0).toUpperCase() || '?'
  return (
    <div className="hp-nav">
      <div className="hp-nav-brand">
        <BrandMark />
        <div className="appbar-brand">zantiflow</div>
      </div>
      <nav className="hp-nav-mid">
        <a href="#how">How it works</a>
        <a href="#privacy">Privacy</a>
        <a href="#pricing">Pricing</a>
        <a href={links.docs} target="_blank" rel="noreferrer">
          Docs
        </a>
      </nav>
      <div className="hp-nav-right">
        <ThemeToggle />
        {me ? (
          <>
            <Link className="hp-signin" href="/dashboard">
              Dashboard
            </Link>
            <div className="avatar" title={me.email ?? me.name}>
              {initial}
            </div>
          </>
        ) : (
          <a className="hp-signin" href={signInHref('/dashboard')}>
            Sign in
          </a>
        )}
      </div>
    </div>
  )
}
