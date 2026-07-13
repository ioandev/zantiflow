// Pricing (HOMEPAGE.md §2.6): honest and low-pressure — free/OSS, PRO is real but promo-code only, no
// checkout (ADR-0013), and a support-only GitHub Sponsors line.
import { links } from '@/lib/links'

const FREE = [
  'Live dashboard',
  'All attention detection',
  'Browser Web Push',
  'Unlimited-ish machines (token cap ≤10)',
  'Self-host',
  'Attention thresholds ≥5 min',
]
const PRO = ['Everything in Free', 'Tighter thresholds (≥1 min)', 'Discord + Telegram DMs']

export function Pricing() {
  return (
    <section id="pricing" className="hp-section">
      <h2 className="hp-h2">Free and open source. PRO when you want it.</h2>
      <div className="hp-plans">
        <div className="hp-plan">
          <span className="hp-plan-name">Free</span>
          <div className="hp-plan-list">
            {FREE.map((f) => (
              <span key={f}>· {f}</span>
            ))}
          </div>
        </div>
        <div className="hp-plan pro">
          <div className="hp-plan-head">
            <span className="hp-plan-name">PRO</span>
            <span className="hp-plan-tag">promo code · no checkout</span>
          </div>
          <div className="hp-plan-list">
            {PRO.map((f) => (
              <span key={f}>· {f}</span>
            ))}
          </div>
        </div>
      </div>
      <div className="hp-pricing-note">
        There’s no checkout. A fresh promo code appears on this homepage every couple of weeks and grants a month of PRO
        — sign in, redeem, done. Or self-host and configure it yourself.
      </div>
      <div className="hp-support">
        Like it?{' '}
        <a href={links.sponsors} target="_blank" rel="noreferrer">
          Sponsor it on GitHub
        </a>
        . Donations fund the work; they’re support-only and don’t buy anything.
      </div>
    </section>
  )
}
