// Problem strip (HOMEPAGE.md §2.2): name the pain precisely, then three scannable "before" vignettes.
export function ProblemStrip() {
  return (
    <section className="hp-section">
      <h2 className="hp-h2">You can’t watch every terminal at once.</h2>
      <p className="hp-p">
        You start a task and switch away. The agent hits a prompt and waits. The build fails. A session detaches.
        Nothing in the terminal can reach you — so you lose minutes, or the whole coffee break, before you look back and
        notice.
      </p>
      <div className="hp-vignettes">
        <div className="hp-vignette">
          <span className="pill att">waiting</span>
          <span className="txt">agent waiting on input</span>
        </div>
        <div className="hp-vignette">
          <span className="pill exited">stopped</span>
          <span className="txt">session stopped or detached</span>
        </div>
        <div className="hp-vignette">
          <span className="pill quiet">quiet</span>
          <span className="txt">build gone quiet</span>
        </div>
      </div>
    </section>
  )
}
