// Feature grid (HOMEPAGE.md §2.4): benefit-led cards, each tagged with the product's own status pill so
// the marketing language matches the dashboard's badge vocabulary.
const FEATURES = [
  {
    pill: 'live',
    badge: 'live',
    title: 'Live, once a second.',
    body: 'Machines → sessions → tabs → panes, streaming over SSE. Current session first, then other live, then resurrectable/dead.',
  },
  {
    pill: 'att',
    badge: 'needs input',
    title: 'Attention badges.',
    body: 'The dashboard flags the pane that needs you — needs-input, session stopped, session detached — and shows a distinct “thinking…” indicator when Claude is busy (not counted as needing you).',
  },
  {
    pill: 'current',
    badge: 'push',
    title: 'Notifications that reach you.',
    body: 'Installable PWA with browser Web Push for everyone; Discord + Telegram DMs for PRO. Tune when, what, and where.',
  },
  {
    pill: 'hidden',
    badge: 'opt-in',
    title: 'Peek at a pane, on demand.',
    body: 'Optionally pull the last ~50 lines of a pane — ANSI colors and all — only when you ask. Off by default; content otherwise never leaves your machine.',
  },
  {
    pill: 'alias',
    badge: 'multi',
    title: 'Multi-machine, multi-tenant.',
    body: 'One dashboard for your laptop, dev box, and servers, each named — real hostname, a custom alias, or hidden.',
  },
  {
    pill: 'thinking',
    badge: 'theme',
    title: 'Dark & light.',
    body: 'Built to a hand-tuned terminal-native theme; follows your system, toggle to pin.',
  },
]

export function Features() {
  return (
    <section className="hp-section">
      <h2 className="hp-h2">What you get</h2>
      <div className="hp-cards">
        {FEATURES.map((f) => (
          <div className="hp-card" key={f.title}>
            <span className={`pill ${f.pill}`}>{f.badge}</span>
            <span className="hp-card-title">{f.title}</span>
            <span className="hp-card-body">{f.body}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
