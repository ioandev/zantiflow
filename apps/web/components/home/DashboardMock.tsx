// Hero visual (HOMEPAGE.md §2.1): a static, redacted dashboard preview built from the product's own
// status colours (green live, amber quiet, orange needs-input, cyan thinking) so the marketing page and
// the real dashboard read as one system. Decorative — the whole thing carries a single descriptive
// label for assistive tech.
export function DashboardMock() {
  return (
    <div
      className="hp-mock"
      role="img"
      aria-label="Dashboard preview: a live machine 'red-laptop' running a session 'main' — one pane waiting for input, one pane thinking, and a build running."
    >
      <div className="hp-mock-bar">
        <span className="dot3" style={{ background: '#e8938a' }} />
        <span className="dot3" style={{ background: '#e5c07b' }} />
        <span className="dot3" style={{ background: '#98c379' }} />
        <span className="hp-mock-title">zantiflow — dashboard</span>
      </div>
      <div className="hp-mock-body">
        <div className="hp-mock-mrow">
          <span className="hp-mock-dot" />
          <span className="hp-mock-mname">red-laptop</span>
          <span className="pill live">live</span>
          <span className="pill restricted">privacy: restricted (pane names)</span>
          <span className="hp-mock-updated">updated 1s ago</span>
        </div>
        <div className="hp-mock-tabbox">
          <div className="hp-mock-tabhead">
            <span className="hp-mock-dot sm" />
            <span className="hp-mock-tabname">main</span>
            <span className="pill current">current</span>
            <span className="hp-mock-tablbl">tab · agent</span>
          </div>
          <div className="hp-mock-prow">
            <span className="hp-mock-pname">&lt;hidden&gt;</span>
            <span className="hp-mock-pcmd">claude</span>
            <span className="hp-mock-pflags">
              <span className="pill att">needs input</span>
              <span className="time-quiet">quiet 6m</span>
            </span>
          </div>
          <div className="hp-mock-prow">
            <span className="hp-mock-pname">&lt;hidden&gt;</span>
            <span className="hp-mock-pcmd">claude</span>
            <span className="hp-mock-pflags">
              <span className="pill thinking">thinking…</span>
              <span className="hp-mock-fresh">2s ago</span>
            </span>
          </div>
          <div className="hp-mock-prow">
            <span className="hp-mock-pname">&lt;hidden&gt;</span>
            <span className="hp-mock-pcmd">cargo watch -x check</span>
            <span className="hp-mock-pflags">
              <span className="hp-mock-fresh">
                <span className="d" />3s ago
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
