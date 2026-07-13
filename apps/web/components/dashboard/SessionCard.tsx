// A live session card: header (name, current/live/attention badges, tab·pane counts) → tab groups →
// pane rows. Dead (resurrectable) sessions are rendered by MachineDetail as a leaf, not here.
import type { WireSession } from '@/lib/types'
import type { AttentionIndex } from '@/lib/attn'
import { pluralize } from '@/lib/format'
import { Dot, Name, Pill } from './atoms'
import { PaneRow } from './PaneRow'

export function SessionCard({
  machineId,
  session,
  attn,
  activity,
}: {
  machineId: string
  session: WireSession
  attn: AttentionIndex
  activity: Record<string, string>
}) {
  const tabs = session.tabs
  const paneCount = tabs.reduce((n, t) => n + t.panes.length, 0)
  const sAttn = attn.sessionAttentions(session.sid)
  const sThinking = attn.sessionThinking(session.sid)
  return (
    <div className="sess">
      <div className="sess-head">
        <Dot kind="live" />
        <Name value={session.name} className="nm" />
        {session.isCurrent && <Pill kind="current">current</Pill>}
        <Pill kind="live">live</Pill>
        {sThinking && <Pill kind="thinking">thinking</Pill>}
        {sAttn > 0 && <Pill kind="att">{pluralize(sAttn, 'needs attention', 'need attention')}</Pill>}
        <span className="meta">
          {pluralize(tabs.length, 'tab')} · {pluralize(paneCount, 'pane')}
        </span>
      </div>
      <div className="sess-body">
        {tabs.map((t) => (
          <div className="tabg" key={t.tabId}>
            <div className="tabg-head">
              <span className="lbl">tab</span>
              <Name value={t.name} className="nm" />
              {t.active && (
                <Pill kind="active" sm>
                  active
                </Pill>
              )}
              <span className="meta">{pluralize(t.panes.length, 'pane')}</span>
            </div>
            <div className="tabg-body">
              {t.panes.map((p) => (
                <PaneRow
                  key={p.id}
                  machineId={machineId}
                  sessionSid={session.sid}
                  tabId={t.tabId}
                  pane={p}
                  needsAttention={attn.paneNeedsAttention(session.sid, t.tabId, p.id)}
                  thinking={attn.paneThinking(session.sid, t.tabId, p.id)}
                  updatedAt={activity[`${session.sid}:${t.tabId}:${p.id}`]}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
