// Footer (HOMEPAGE.md §2.8): brand, docs/privacy/contributing/donations/GitHub links, theme toggle.
// No newsletter capture or tracking — that would contradict the privacy pitch.
import { links } from '@/lib/links'
import { versionLabel } from '@/lib/version'
import { ThemeToggle } from '@/components/ThemeToggle'

export function HomeFooter() {
  return (
    <div className="hp-footer">
      <div className="hp-footer-inner">
        <span className="hp-footer-brand">zantiflow</span>
        <span className="hp-footer-version" title="Running version">
          {versionLabel}
        </span>
        <div className="hp-footer-links">
          <a href={links.docs} target="_blank" rel="noreferrer">
            Docs
          </a>
          <a href="#privacy">Privacy</a>
          <a href={links.contributing} target="_blank" rel="noreferrer">
            Contributing
          </a>
          <a href={links.donations} target="_blank" rel="noreferrer">
            Donations
          </a>
          <a href={links.github} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </div>
        <ThemeToggle />
      </div>
    </div>
  )
}
