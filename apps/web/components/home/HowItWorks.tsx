// How it works (HOMEPAGE.md §2.3): three steps, the loop diagram, and the two-keys reassurance line.
const STEPS = [
  {
    num: '01',
    title: 'Install the plugin.',
    body: 'A Rust → WebAssembly plugin runs inside Zellij and builds a snapshot of your sessions, tabs, and panes once a second.',
  },
  {
    num: '02',
    title: 'It reports to your dashboard.',
    body: 'The snapshot is POSTed to the backend over an authenticated, write-only ingest token. Redaction is applied in the plugin, before anything is sent.',
  },
  {
    num: '03',
    title: 'You get pinged when a pane needs you.',
    body: 'The dashboard shows every machine live; when an attention fires, you get a notification — browser push for everyone, Discord/Telegram DM for PRO.',
  },
]

export function HowItWorks() {
  return (
    <section id="how" className="hp-section">
      <h2 className="hp-h2">How it works</h2>
      <div className="hp-steps">
        {STEPS.map((s) => (
          <div className="hp-step" key={s.num}>
            <span className="hp-step-num">{s.num}</span>
            <span className="hp-step-title">{s.title}</span>
            <span className="hp-step-body">{s.body}</span>
          </div>
        ))}
      </div>
      <div className="hp-loop">
        <span className="hp-loop-node">Zellij plugin</span>
        <span className="hp-loop-arrow">→</span>
        <span className="hp-loop-node">backend</span>
        <span className="hp-loop-arrow">→</span>
        <span className="hp-loop-node">your dashboard</span>
        <span className="hp-loop-arrow">·</span>
        <span className="hp-loop-node att">attention fires</span>
        <span className="hp-loop-arrow">→</span>
        <span className="hp-loop-node">Web Push / bot DM</span>
      </div>
      <div className="hp-reassure">
        Two separate keys, never mixed — a <b>write-only</b> token pushes snapshots and can’t read a thing;{' '}
        <b>your Google sign-in</b> is the only thing that can read or manage your account.
      </div>
    </section>
  )
}
