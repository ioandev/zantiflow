// Privacy (HOMEPAGE.md §2.5): a full section, not a footnote. Three concrete promises, each mapping to
// something true per the ADRs, plus the open-source / self-host trust footer.
import { links } from '@/lib/links'

export function Privacy() {
  return (
    <section id="privacy" className="hp-section">
      <h2 className="hp-h2 wide">Your terminal is yours. Redaction happens before anything is sent.</h2>
      <div className="hp-cards narrow">
        <div className="hp-card">
          <span className="hp-card-h">Redacted on your machine.</span>
          <span className="hp-card-body">
            Names you hide never leave the plugin — they transmit as <code>null</code> and the dashboard shows{' '}
            <span className="hidden hp-mono">&lt;hidden&gt;</span>. Settings fail closed: a typo redacts more, never
            less.
          </span>
        </div>
        <div className="hp-card">
          <span className="hp-card-h">Nothing is stored.</span>
          <span className="hp-card-body">
            The backend keeps only the latest snapshot per machine and current attentions — no history. Notifications
            are pruned after a few hours.
          </span>
        </div>
        <div className="hp-card">
          <span className="hp-card-h">Raw output stays home.</span>
          <span className="hp-card-body">
            Pane contents are never sent by default. The opt-in peek scrubs known secret shapes in the plugin first, and
            the dashboard escapes markup so output can’t execute.
          </span>
        </div>
      </div>
      <div className="hp-privacy-foot">
        <span>
          <b>Open source and self-hostable</b> — read exactly what’s sent, or run the whole thing yourself.
        </span>
        <a href={links.privacy} target="_blank" rel="noreferrer">
          Privacy docs
        </a>
        <a href={links.deployExample} target="_blank" rel="noreferrer">
          deploy/ example
        </a>
      </div>
    </section>
  )
}
