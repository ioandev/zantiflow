import { describe, expect, it } from 'vitest'
import {
  coerceSortMode,
  filterSessionsToClaude,
  isClaudePane,
  machineLastActiveMs,
  paneDisplayName,
  sortMachines,
} from '../lib/machineView'
import type { MachineDetail, MachineSummary, WirePane, WireSession } from '../lib/types'

const machine = (over: Partial<MachineSummary>): MachineSummary => ({
  id: 'm',
  displayName: 'host',
  tokenId: null,
  firstSeenAt: '2026-01-01T00:00:00Z',
  lastSeenAt: '2026-01-01T00:00:00Z',
  online: true,
  privacy: { source: 'real', level: 'full' },
  counts: { sessions: 1, tabs: 1, panes: 1 },
  attentionCount: 0,
  thinkingCount: 0,
  ...over,
})
const ids = (ms: MachineSummary[]) => ms.map((m) => m.id)

describe('coerceSortMode', () => {
  it('accepts the known modes and defaults everything else to recent', () => {
    expect(coerceSortMode('recent')).toBe('recent')
    expect(coerceSortMode('name')).toBe('name')
    expect(coerceSortMode('attention')).toBe('attention')
    expect(coerceSortMode(null)).toBe('recent')
    expect(coerceSortMode('garbage')).toBe('recent')
    expect(coerceSortMode(undefined)).toBe('recent')
  })
})

describe('sortMachines', () => {
  const a = machine({
    id: 'a',
    displayName: 'banana',
    lastSeenAt: '2026-01-01T00:00:01Z',
    attentionCount: 0,
    thinkingCount: 1,
  })
  const b = machine({
    id: 'b',
    displayName: 'apple',
    lastSeenAt: '2026-01-01T00:00:03Z',
    attentionCount: 2,
    thinkingCount: 0,
  })
  const c = machine({
    id: 'c',
    displayName: null,
    lastSeenAt: '2026-01-01T00:00:02Z',
    attentionCount: 2,
    thinkingCount: 5,
  })
  const input = [a, b, c]

  it('recent: ranks by Claude activity bucket, most-recent first', () => {
    const lastActive = { a: 90_000, b: 60_000, c: 30_000 } // buckets 3, 2, 1 (30s window)
    expect(ids(sortMachines(input, 'recent', lastActive))).toEqual(['a', 'b', 'c'])
  })
  it('recent: de-jitters within a bucket — stable by id, not exact ms', () => {
    // a & b are 5s apart but in the same 30s bucket → held stable by id ('a' < 'b'), so b (newer by
    // exact ms) does NOT leapfrog a on the next tick.
    expect(ids(sortMachines(input, 'recent', { a: 100_000, b: 105_000, c: 0 }))).toEqual(['a', 'b', 'c'])
  })
  it('recent: machines with no Claude activity sink to the bottom', () => {
    expect(ids(sortMachines(input, 'recent', { b: 90_000 }))).toEqual(['b', 'a', 'c']) // b active; a,c bucket 0 by id
  })
  it('name: A–Z, hidden (null) name last', () => {
    expect(ids(sortMachines(input, 'name'))).toEqual(['b', 'a', 'c'])
  })
  it('attention: attentionCount desc, then thinking, then recency', () => {
    // b and c both have 2 attentions; c has more thinking, so c precedes b; a (0) last.
    expect(ids(sortMachines(input, 'attention'))).toEqual(['c', 'b', 'a'])
  })
  it('does not mutate the input array', () => {
    const original = [...input]
    sortMachines(input, 'name')
    expect(input).toEqual(original)
  })
})

describe('machineLastActiveMs', () => {
  // A one-tab machine detail whose panes carry the given names, plus an activity map (paneKey → ISO).
  const detail = (panes: { id: number; name: string }[], activity: Record<string, string>): MachineDetail => ({
    ...machine({ id: 'm' }),
    capturedAtTick: 1,
    receivedAt: '2026-01-01T00:00:00Z',
    activity,
    snapshot: {
      version: 4,
      machineId: 'm',
      capturedAtTick: 1,
      machine: { source: 'real', name: 'm' },
      sessions: [
        {
          sid: 's1',
          name: 's1',
          isCurrent: true,
          state: 'live',
          diedSecondsAgo: null,
          tabs: [
            {
              tabId: 0,
              name: 'Tab #1',
              position: 0,
              active: true,
              panes: panes.map((p) => ({
                id: p.id,
                name: p.name,
                command: null,
                isFocused: false,
                exited: false,
                contentFingerprint: 'x',
              })),
            },
          ],
        },
      ],
    },
  })

  it('counts only Claude panes, ignoring more-recent non-Claude activity', () => {
    const d = detail(
      [
        { id: 1, name: '✳ Claude Code' },
        { id: 2, name: 'nordic@host:~' }, // a shell that changed MORE recently
      ],
      { 's1:0:1': '2026-01-01T00:00:30Z', 's1:0:2': '2026-01-01T00:00:40Z' },
    )
    expect(machineLastActiveMs(d)).toBe(Date.parse('2026-01-01T00:00:30Z')) // shell's 00:00:40 ignored
  })
  it('takes the newest across multiple Claude panes', () => {
    const d = detail(
      [
        { id: 1, name: '✳ idle' },
        { id: 2, name: '⠐ thinking' },
      ],
      { 's1:0:1': '2026-01-01T00:00:10Z', 's1:0:2': '2026-01-01T00:00:50Z' },
    )
    expect(machineLastActiveMs(d)).toBe(Date.parse('2026-01-01T00:00:50Z'))
  })
  it('returns 0 with no Claude activity, no snapshot, or undefined', () => {
    expect(machineLastActiveMs(detail([{ id: 1, name: 'bash' }], { 's1:0:1': '2026-01-01T00:00:40Z' }))).toBe(0)
    expect(machineLastActiveMs(detail([{ id: 1, name: '✳ a' }], {}))).toBe(0) // claude pane, no activity yet
    expect(machineLastActiveMs(undefined)).toBe(0)
  })
})

describe('isClaudePane', () => {
  const pane = (name: string | null, command: string | null = null): WirePane => ({
    id: 1,
    name,
    command,
    isFocused: false,
    exited: false,
    contentFingerprint: 'x',
  })
  it('matches the idle ✳ sparkle (U+2733) leading the pane name', () => {
    expect(isClaudePane(pane('✳ Claude Code'))).toBe(true)
    expect(isClaudePane(pane('  ✳ padded'))).toBe(true) // leading whitespace tolerated
  })
  it('matches a leading Braille spinner frame (U+2801..U+28FF, thinking/spinning)', () => {
    expect(isClaudePane(pane('⠐ github actions'))).toBe(true) // U+2810, seen live
    expect(isClaudePane(pane('⠂ coloured text'))).toBe(true) // U+2802, seen live
    expect(isClaudePane(pane('⠙ Fixing the parser'))).toBe(true)
  })
  it('falls back to a claude command when the title is not set yet', () => {
    expect(isClaudePane(pane('claude --resume', 'claude --resume'))).toBe(true)
    expect(isClaudePane(pane('some-title', '/usr/bin/Claude'))).toBe(true)
  })
  it('rejects shells, other glyphs, non-leading markers, redaction, and the blank Braille pattern', () => {
    expect(isClaudePane(pane('nordic@nordic-standardpc:~'))).toBe(false)
    expect(isClaudePane(pane('python3 -m http.server 8088'))).toBe(false)
    expect(isClaudePane(pane('● Done'))).toBe(false) // a bullet is not the sparkle/spinner
    expect(isClaudePane(pane('build ⠐ step'))).toBe(false) // marker must be leading
    expect(isClaudePane(pane('⠀ idle'))).toBe(false) // U+2800 blank pattern excluded
    expect(isClaudePane(pane(null, null))).toBe(false) // fully redacted
    expect(isClaudePane(pane(''))).toBe(false)
  })
})

describe('paneDisplayName', () => {
  it('strips the leading ✳ sparkle or Braille spinner marker and following whitespace', () => {
    expect(paneDisplayName('✳ Claude Code')).toBe('Claude Code')
    expect(paneDisplayName('⠂ bug-tile-not-updated')).toBe('bug-tile-not-updated') // the frozen "." glyph
    expect(paneDisplayName('⠐ github actions')).toBe('github actions')
    expect(paneDisplayName('  ✳   padded')).toBe('padded') // leading + inter whitespace trimmed
  })
  it('leaves non-Claude names, redaction, and marker-only titles alone', () => {
    expect(paneDisplayName('npm run dev')).toBe('npm run dev')
    expect(paneDisplayName('nordic@host:~')).toBe('nordic@host:~')
    expect(paneDisplayName('● Done')).toBe('● Done') // a bullet is not the marker
    expect(paneDisplayName(null)).toBe(null) // redacted stays redacted
    expect(paneDisplayName('✳')).toBe('✳') // marker-only → keep, never blank
    expect(paneDisplayName('✳   ')).toBe('✳   ') // nothing after the marker → keep original
  })
})

describe('filterSessionsToClaude', () => {
  const pane = (id: number, name: string): WirePane => ({
    id,
    name,
    command: null, // Zellij usually reports the launch command as null — the pane NAME is the signal
    isFocused: false,
    exited: false,
    contentFingerprint: 'x',
  })
  // tabs: list of pane-name lists — a name's leading ✳/Braille marker decides Claude-ness.
  const session = (sid: string, tabs: string[][], state: WireSession['state'] = 'live'): WireSession => ({
    sid,
    name: sid,
    isCurrent: false,
    state,
    diedSecondsAgo: state === 'live' ? null : 5,
    tabs: tabs.map((names, i) => ({
      tabId: i,
      name: `Tab #${i + 1}`, // Zellij's default — no marker on the tab
      position: i,
      active: i === 0,
      panes: names.map((nm, j) => pane(i * 10 + j, nm)),
    })),
  })

  it('keeps only Claude panes, drops empty tabs and Claude-free sessions', () => {
    const sessions = [
      session('s1', [
        ['✳ Claude Code', 'nordic@host:~'], // tab 0: keep only the ✳ pane
        ['npm run dev'], // tab 1: no claude → dropped
      ]),
      session('s2', [['python3 -m http.server 8088']]), // no claude → session dropped
    ]
    const out = filterSessionsToClaude(sessions)
    expect(out.map((s) => s.sid)).toEqual(['s1'])
    expect(out[0].tabs.map((t) => t.tabId)).toEqual([0])
    expect(out[0].tabs[0].panes.map((p) => p.name)).toEqual(['✳ Claude Code'])
  })

  it('keeps a spinning (Braille) pane too', () => {
    const out = filterSessionsToClaude([session('s1', [['⠐ github actions']])])
    expect(out.map((s) => s.sid)).toEqual(['s1'])
  })

  it('drops dead sessions (no pane detail) and returns [] when nothing matches', () => {
    expect(filterSessionsToClaude([session('d', [], 'resurrectable')])).toEqual([])
    expect(filterSessionsToClaude([session('s1', [['bash']])])).toEqual([])
    expect(filterSessionsToClaude([])).toEqual([])
  })

  it('does not mutate the input', () => {
    const sessions = [session('s1', [['✳ Claude Code', 'nordic@host:~']])]
    filterSessionsToClaude(sessions)
    expect(sessions[0].tabs[0].panes).toHaveLength(2)
  })
})
