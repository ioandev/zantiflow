'use client'

// Overview card for one machine (ADR-0008 §2 / ADR-0016 §A). Shows live/stale, hostname mode +
// privacy level, sessions/tabs/panes counts (present even under full redaction — structure leaks by
// design), attention count, and first/last seen. Clicking scrolls to the machine's detail section.
import type { MachineSummary } from '@/lib/types'
import { hostnameModeLabel, lastSeenLabel, privacyLevelLabel, shortDate } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { Dot, Pill } from './atoms'

export function MachineCard({ m, onOpen }: { m: MachineSummary; onOpen: () => void }) {
  const now = useNow() // keep "last seen Xs ago" advancing without a data refresh
  const stale = !m.online
  const hidden = m.displayName === null
  const c = m.counts
  return (
    <button type="button" className={`mcard${stale ? ' stale' : ''}`} onClick={onOpen}>
      <div className="mcard-top">
        <Dot kind={stale ? 'stale' : 'live'} />
        <span className={`mcard-name${hidden ? ' hidden' : ''}`}>{hidden ? '<machine hidden>' : m.displayName}</span>
        <span style={{ marginLeft: 'auto' }}>
          {stale ? <Pill kind="stale">stale</Pill> : <Pill kind="live">live</Pill>}
        </span>
      </div>

      {m.privacy && (
        <div className="mcard-pills">
          <Pill kind={m.privacy.source} sm>
            {hostnameModeLabel(m.privacy.source)}
          </Pill>
          <Pill kind={m.privacy.level} sm>
            {privacyLevelLabel(m.privacy.level)}
          </Pill>
          {m.thinkingCount > 0 && (
            <Pill kind="thinking" sm>
              {m.thinkingCount} thinking
            </Pill>
          )}
          {m.attentionCount > 0 && (
            <Pill kind="att" sm>
              {m.attentionCount} {m.attentionCount === 1 ? 'needs' : 'need'} attention
            </Pill>
          )}
        </div>
      )}

      <div className="counts">
        {c ? (
          <>
            <span>
              <b>{c.sessions}</b> {c.sessions === 1 ? 'session' : 'sessions'}
            </span>
            <span>
              <b>{c.tabs}</b> {c.tabs === 1 ? 'tab' : 'tabs'}
            </span>
            <span>
              <b>{c.panes}</b> {c.panes === 1 ? 'pane' : 'panes'}
            </span>
          </>
        ) : (
          <span className="muted">no snapshot received yet</span>
        )}
      </div>

      <div className="mcard-foot">
        <span>first seen {shortDate(m.firstSeenAt)}</span>
        <span className={stale ? 'warn' : undefined}>last seen {lastSeenLabel(m.lastSeenAt, now)}</span>
      </div>
    </button>
  )
}
