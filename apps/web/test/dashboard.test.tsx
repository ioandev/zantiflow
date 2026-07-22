import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { FilterNudge } from '../components/dashboard/FilterNudge'
import { MachineCard } from '../components/dashboard/MachineCard'
import { MachineDetail as MachineDetailView } from '../components/dashboard/MachineDetail'
import { PaneRow } from '../components/dashboard/PaneRow'
import type { AttentionView, MachineDetail, MachineSummary, WirePane } from '../lib/types'

const base: MachineSummary = {
  id: 'm_9f3c1a70',
  displayName: 'red-laptop',
  tokenId: null,
  firstSeenAt: '2026-03-12T00:00:00Z',
  lastSeenAt: new Date().toISOString(),
  online: true,
  privacy: { source: 'real', level: 'full' },
  counts: { sessions: 3, tabs: 3, panes: 6 },
  attentionCount: 1,
  thinkingCount: 0,
}
const pane = (over: Partial<WirePane>): WirePane => ({
  id: 7,
  name: 'claude',
  command: 'claude',
  isFocused: false,
  exited: false,
  contentFingerprint: 'x',
  ...over,
})

describe('MachineCard', () => {
  it('renders a live machine with counts, privacy and attention', () => {
    const html = renderToStaticMarkup(<MachineCard m={base} onOpen={() => {}} />)
    expect(html).toContain('red-laptop')
    expect(html).toContain('real hostname')
    expect(html).toContain('privacy: full')
    expect(html).toContain('1 needs attention')
    expect(html).toContain('sessions')
  })

  it('renders a stale, hidden machine with restricted privacy', () => {
    const m: MachineSummary = {
      ...base,
      displayName: null,
      online: false,
      privacy: { source: 'hidden', level: 'restricted' },
      attentionCount: 0,
    }
    const html = renderToStaticMarkup(<MachineCard m={m} onOpen={() => {}} />)
    expect(html).toContain('&lt;machine hidden&gt;') // redacted name, escaped (XSS-safe)
    expect(html).toContain('stale')
    expect(html).toContain('privacy: restricted (all names)')
    expect(html).not.toContain('needs attention')
  })

  it('shows a "N thinking" pill distinct from needs-attention', () => {
    const html = renderToStaticMarkup(
      <MachineCard m={{ ...base, attentionCount: 0, thinkingCount: 2 }} onOpen={() => {}} />,
    )
    expect(html).toContain('2 thinking')
    expect(html).not.toContain('need attention')
  })
})

describe('PaneRow activity + flags', () => {
  const row = (p: WirePane, needsAttention: boolean, updatedAt?: string, thinking = false) =>
    renderToStaticMarkup(
      <PaneRow
        machineId="m1"
        sessionSid="s1"
        tabId={0}
        pane={p}
        needsAttention={needsAttention}
        thinking={thinking}
        updatedAt={updatedAt}
      />,
    )

  it('shows "quiet Xm" + a needs-attention flag for a flagged pane', () => {
    const html = row(pane({}), true, new Date(Date.now() - 12 * 60_000).toISOString())
    expect(html).toContain('claude')
    expect(html).toContain('needs attention')
    expect(html).toContain('quiet 12m')
  })

  it('shows a busy "thinking…" indicator, not the needs-attention state', () => {
    const html = row(pane({}), false, new Date().toISOString(), true)
    expect(html).toContain('thinking')
    expect(html).toContain('thinking…')
    expect(html).not.toContain('quiet')
    expect(html).not.toContain('needs attention')
  })

  it('shows "Unknown" when no change has been observed', () => {
    const html = row(pane({ id: 8, name: 'htop', command: 'htop' }), false, undefined)
    expect(html).toContain('Unknown')
  })

  it('marks an exited pane', () => {
    const html = row(pane({ id: 9, name: 'ssh-prod', command: 'ssh', exited: true }), false, new Date().toISOString())
    expect(html).toContain('exited')
  })

  it('renders a redacted pane name as escaped <hidden>', () => {
    const html = row(pane({ id: 10, name: null, command: null }), false, undefined)
    expect(html).toContain('&lt;hidden&gt;')
  })
})

// The full path an attention actually travels on the website: the backend's `AttentionView[]` is
// handed to <MachineDetail>, which builds the AttentionIndex and joins each attention onto its
// session/pane. The earlier tests short-circuited this by passing `thinking` straight to <PaneRow>,
// so a break between "backend returns a claude.thinking attention" and "the pane shows thinking"
// went uncaught. This renders the real components end-to-end.
describe('MachineDetail joins attentions onto panes (full render path)', () => {
  const detail = (over: Partial<MachineDetail> = {}): MachineDetail => ({
    id: 'm1',
    displayName: 'red-laptop',
    tokenId: null,
    firstSeenAt: '2026-03-12T00:00:00Z',
    lastSeenAt: new Date().toISOString(),
    online: true,
    privacy: { source: 'real', level: 'full' },
    counts: { sessions: 1, tabs: 1, panes: 1 },
    attentionCount: 0,
    thinkingCount: 1,
    capturedAtTick: 7,
    receivedAt: new Date().toISOString(),
    activity: {},
    snapshot: {
      version: 4,
      machineId: 'm1',
      capturedAtTick: 7,
      machine: { source: 'real', name: 'red-laptop' },
      sessions: [
        {
          sid: 's1',
          name: 'main',
          isCurrent: true,
          state: 'live',
          diedSecondsAgo: null,
          tabs: [
            {
              tabId: 0,
              name: 'editor',
              position: 0,
              active: true,
              panes: [
                { id: 7, name: 'claude', command: 'claude', isFocused: true, exited: false, contentFingerprint: 'x' },
              ],
            },
          ],
        },
      ],
    },
    ...over,
  })
  const attn = (type: string, targetKey: string): AttentionView => ({
    id: `${type}:${targetKey}`,
    machineId: 'm1',
    type,
    targetKey,
    activeSince: new Date().toISOString(),
    lastFiredAt: null,
  })

  it('shows the busy "thinking…" indicator for the pane a claude.thinking attention targets', () => {
    const html = renderToStaticMarkup(
      <MachineDetailView detail={detail()} attentions={[attn('claude.thinking', 's1:0:7')]} anchorId="m-m1" />,
    )
    expect(html).toContain('thinking…') // the busy activity indicator on the pane row
    expect(html).toContain('thinking') // the pill
    expect(html).not.toContain('needs attention') // NOT the amber needs-attention state
  })

  it('shows "needs attention", not thinking, for a claude.needs-input attention on the same pane', () => {
    const html = renderToStaticMarkup(
      <MachineDetailView
        detail={detail({ attentionCount: 1, thinkingCount: 0 })}
        attentions={[attn('claude.needs-input', 's1:0:7')]}
        anchorId="m-m1"
      />,
    )
    expect(html).toContain('needs attention')
    expect(html).not.toContain('thinking…')
  })
})

// The "Claude only" filter (page toolbar) is applied by MachineDetail via its claudeOnly prop. A pane
// is "Claude" by its NAME's leading glyph — a `✳` sparkle (idle) or a Braille spinner (thinking) —
// which is what Claude Code writes into the pane title (the tab stays "Tab #1"), not the command.
describe('MachineDetail "Claude only" filter', () => {
  const p = (id: number, name: string): WirePane => ({
    id,
    name,
    command: null, // Zellij typically reports the launch command as null; the pane name is the signal
    isFocused: false,
    exited: false,
    contentFingerprint: 'x',
  })
  const mixed = (over: Partial<MachineDetail> = {}): MachineDetail => ({
    id: 'm1',
    displayName: 'red-laptop',
    tokenId: null,
    firstSeenAt: '2026-03-12T00:00:00Z',
    lastSeenAt: new Date().toISOString(),
    online: true,
    privacy: { source: 'real', level: 'full' },
    counts: { sessions: 2, tabs: 3, panes: 4 },
    attentionCount: 0,
    thinkingCount: 0,
    capturedAtTick: 7,
    receivedAt: new Date().toISOString(),
    activity: {},
    snapshot: {
      version: 4,
      machineId: 'm1',
      capturedAtTick: 7,
      machine: { source: 'real', name: 'red-laptop' },
      sessions: [
        {
          sid: 's1',
          name: 'agent',
          isCurrent: true,
          state: 'live',
          diedSecondsAgo: null,
          tabs: [
            {
              tabId: 0,
              name: 'Tab #1',
              position: 0,
              active: true,
              // one Claude pane (✳ title) beside a plain shell pane in the same tab
              panes: [p(1, '✳ claude-here'), p(2, 'shell-here')],
            },
            { tabId: 1, name: 'Tab #2', position: 1, active: false, panes: [p(3, 'devserver-here')] },
          ],
        },
        {
          sid: 's2',
          name: 'plain',
          isCurrent: false,
          state: 'live',
          diedSecondsAgo: null,
          tabs: [{ tabId: 0, name: 'Tab #1', position: 0, active: true, panes: [p(4, 'python-here')] }],
        },
      ],
    },
    ...over,
  })

  it('keeps every pane when the filter is off', () => {
    const html = renderToStaticMarkup(<MachineDetailView detail={mixed()} attentions={[]} anchorId="m-m1" />)
    expect(html).toContain('claude-here')
    expect(html).toContain('shell-here')
    expect(html).toContain('devserver-here')
    expect(html).toContain('python-here')
  })

  it('keeps only Claude panes and drops Claude-free tabs/sessions when the filter is on', () => {
    const html = renderToStaticMarkup(<MachineDetailView detail={mixed()} attentions={[]} anchorId="m-m1" claudeOnly />)
    expect(html).toContain('claude-here') // the ✳ pane survives
    expect(html).not.toContain('shell-here') // plain pane in the same tab → removed
    expect(html).not.toContain('devserver-here') // non-Claude tab → removed
    expect(html).not.toContain('python-here') // whole session had no Claude pane → removed
    expect(html).not.toContain('No Claude Code panes')
  })

  it('shows the empty state for a machine with no Claude panes', () => {
    const noClaude = mixed({
      snapshot: {
        version: 4,
        machineId: 'm1',
        capturedAtTick: 7,
        machine: { source: 'real', name: 'red-laptop' },
        sessions: [
          {
            sid: 's2',
            name: 'plain',
            isCurrent: false,
            state: 'live',
            diedSecondsAgo: null,
            tabs: [{ tabId: 0, name: 'Tab #1', position: 0, active: true, panes: [p(4, 'python-here')] }],
          },
        ],
      },
    })
    const html = renderToStaticMarkup(
      <MachineDetailView detail={noClaude} attentions={[]} anchorId="m-m1" claudeOnly />,
    )
    expect(html).toContain('No Claude Code panes on this machine.')
    expect(html).not.toContain('python-here')
  })
})

describe('FilterNudge (ADR-0053)', () => {
  it('renders the filter hint with a troubleshooting link and a dismiss control', () => {
    const html = renderToStaticMarkup(<FilterNudge onDismiss={() => {}} />)
    expect(html).toContain('Not finding what you’re looking for? Check the filters at the top')
    expect(html).toContain('https://ioandev.github.io/zantiflow/troubleshooting/')
    expect(html).toContain('Troubleshooting guide')
    expect(html).toContain('aria-label="Dismiss"')
  })
})
