// Machine-level `claude.idle` (ADR-0027) — pure logic, no DB. The tier-aware threshold, the Claude-pane
// enumeration (scope + exited exclusion), and the "all provably idle" predicate incl. its conservative
// false-negatives (missing / Unknown activity → not idle).
import { describe, expect, it } from 'vitest'
import type { ActivityMap } from '../src/machines/activity'
import { computeMachineIdle, idleThresholdSeconds, isClaudeCommand, watchedPaneKeys } from '../src/attentions/idle'

describe('isClaudeCommand', () => {
  it('matches claude case-insensitively, rejects others/null', () => {
    expect(isClaudeCommand('claude')).toBe(true)
    expect(isClaudeCommand('/usr/bin/Claude --resume')).toBe(true)
    expect(isClaudeCommand('nvim')).toBe(false)
    expect(isClaudeCommand(null)).toBe(false)
    expect(isClaudeCommand(undefined)).toBe(false)
  })
})

describe('idleThresholdSeconds', () => {
  it('is tier-aware: 1 min pro / 5 min free', () => {
    expect(idleThresholdSeconds('pro')).toBe(60)
    expect(idleThresholdSeconds('free')).toBe(300)
    expect(idleThresholdSeconds('anything-else')).toBe(300)
  })
})

// A session tree with mixed panes: s1 has a claude pane + an nvim pane; s2 has only a shell.
const sessions = () => [
  {
    sid: 's1',
    tabs: [
      {
        tabId: 0,
        panes: [
          { id: 1, command: 'claude', exited: false },
          { id: 2, command: 'nvim', exited: false },
        ],
      },
    ],
  },
  { sid: 's2', tabs: [{ tabId: 0, panes: [{ id: 1, command: 'zsh', exited: false }] }] },
]

describe('watchedPaneKeys', () => {
  it('claude-only (default): just the claude panes', () => {
    expect(watchedPaneKeys(sessions())).toEqual(['s1:0:1'])
  })

  it('claude-sessions: every pane in a session that holds a claude pane', () => {
    expect(watchedPaneKeys(sessions(), 'claude-sessions')).toEqual(['s1:0:1', 's1:0:2'])
  })

  it('all: every live pane on the machine', () => {
    expect(watchedPaneKeys(sessions(), 'all')).toEqual(['s1:0:1', 's1:0:2', 's2:0:1'])
  })

  it('excludes exited panes', () => {
    const s = [{ sid: 's1', tabs: [{ tabId: 0, panes: [{ id: 1, command: 'claude', exited: true }] }] }]
    expect(watchedPaneKeys(s)).toEqual([])
  })

  it('is empty when no pane runs claude', () => {
    const s = [{ sid: 's1', tabs: [{ tabId: 0, panes: [{ id: 1, command: 'nvim', exited: false }] }] }]
    expect(watchedPaneKeys(s)).toEqual([])
  })
})

describe('computeMachineIdle', () => {
  const now = new Date('2026-07-12T00:05:00Z')
  const ago = (sec: number) => new Date(now.getTime() - sec * 1000).toISOString()
  const map = (entries: Record<string, string | null>): ActivityMap =>
    Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, { fp: 'x', updatedAt: v }]))

  it('active when every watched pane is idle past the threshold', () => {
    const a = map({ 's1:0:1': ago(120), 's2:0:1': ago(90) })
    expect(computeMachineIdle(['s1:0:1', 's2:0:1'], a, now, 60)).toBe('active')
  })

  it('cleared when any watched pane is still fresh', () => {
    const a = map({ 's1:0:1': ago(120), 's2:0:1': ago(10) })
    expect(computeMachineIdle(['s1:0:1', 's2:0:1'], a, now, 60)).toBe('cleared')
  })

  it('cleared when a watched pane was never observed to change (Unknown)', () => {
    const a = map({ 's1:0:1': null })
    expect(computeMachineIdle(['s1:0:1'], a, now, 60)).toBe('cleared')
  })

  it('cleared when a watched pane has no activity entry at all', () => {
    expect(computeMachineIdle(['s1:0:1'], {}, now, 60)).toBe('cleared')
  })

  it('cleared when there are no watched panes (no vacuous fire)', () => {
    expect(computeMachineIdle([], map({}), now, 60)).toBe('cleared')
  })

  it('fires at exactly the threshold boundary', () => {
    const a = map({ 's1:0:1': ago(60) })
    expect(computeMachineIdle(['s1:0:1'], a, now, 60)).toBe('active')
  })
})
