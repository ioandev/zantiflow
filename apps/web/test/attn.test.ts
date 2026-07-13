import { describe, expect, it } from 'vitest'
import { AttentionIndex, parseTargetKey } from '../lib/attn'
import type { AttentionView } from '../lib/types'

const attn = (targetKey: string, type = 'claude.needs-input'): AttentionView => ({
  id: targetKey,
  machineId: 'm1',
  type,
  targetKey,
  activeSince: '2026-07-11T12:00:00Z',
  lastFiredAt: null,
})

describe('parseTargetKey', () => {
  it('splits sid:tabId:paneId, tolerating empty segments', () => {
    expect(parseTargetKey('s1:0:7')).toEqual({ sid: 's1', tabId: '0', paneId: '7' })
    expect(parseTargetKey('s1::')).toEqual({ sid: 's1', tabId: '', paneId: '' })
  })
})

describe('AttentionIndex', () => {
  it('flags the exact pane and counts per session', () => {
    const idx = new AttentionIndex([attn('s1:0:7'), attn('s1:1:3'), attn('s2::', 'session.detached')])
    expect(idx.paneNeedsAttention('s1', 0, 7)).toBe(true)
    expect(idx.paneNeedsAttention('s1', 0, 9)).toBe(false)
    expect(idx.sessionAttentions('s1')).toBe(2)
    expect(idx.sessionAttentions('s2')).toBe(1) // session-level (detached) still counts for the session
    expect(idx.sessionAttentions('none')).toBe(0)
  })

  it('tracks thinking separately and keeps it out of the needs-attention count', () => {
    const idx = new AttentionIndex([attn('s1:0:7', 'claude.thinking'), attn('s1:1:3', 'claude.needs-input')])
    // The thinking pane is "thinking", not "needs attention".
    expect(idx.paneThinking('s1', 0, 7)).toBe(true)
    expect(idx.paneNeedsAttention('s1', 0, 7)).toBe(false)
    // The needs-input pane is the reverse.
    expect(idx.paneNeedsAttention('s1', 1, 3)).toBe(true)
    expect(idx.paneThinking('s1', 1, 3)).toBe(false)
    // Session: thinking flagged, but the needs count excludes it (only the needs-input pane).
    expect(idx.sessionThinking('s1')).toBe(true)
    expect(idx.sessionAttentions('s1')).toBe(1)
    expect(idx.sessionThinking('none')).toBe(false)
  })
})
