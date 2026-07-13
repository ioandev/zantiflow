// Final CTA (HOMEPAGE.md §2.7): one clean close for anyone who scrolled the whole way. A signed-in
// visitor gets "Open dashboard" instead of the sign-in prompt.
import Link from 'next/link'
import type { Me } from '@/lib/types'
import { signInHref } from '@/lib/api'
import { links } from '@/lib/links'

export function FinalCta({ me }: { me?: Me | null }) {
  return (
    <section className="hp-final">
      <h2 className="hp-h2">Give your terminals a way to reach you.</h2>
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
      <div className="hp-micro">Free · open source · redacted before send · self-hostable</div>
    </section>
  )
}
