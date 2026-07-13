// Per-pane activity derivation (ADR-0001 §4). Pure fingerprint-diff logic — no DB. Verifies the
// three states the design renders: freshly-changed (timestamp), unchanged (kept), and never-changed
// ("Unknown" = null → omitted from the wire map).
import { describe, expect, it } from 'vitest'
import type { SnapshotV4 } from '@zantiflow/protocol'
import { activityToWire, asActivityMap, deriveActivity, paneKeyOf } from '../src/machines/activity'

const pane = (id: number, fp: string) => ({
  id,
  name: `p${id}`,
  command: null,
  isFocused: false,
  exited: false,
  contentFingerprint: fp,
})

// One session `s1`, one tab `0`, with the given panes.
const snap = (panes: ReturnType<typeof pane>[]): SnapshotV4 =>
  ({
    version: 4,
    machineId: 'm1',
    capturedAtTick: 1,
    privacy: { full: true, machine: 'real', sessionNames: 'send', tabNames: 'send', paneNames: 'send' },
    machine: { source: 'real', name: 'host' },
    attentions: [],
    sessions: [{ sid: 's1', name: 'main', isCurrent: true, state: 'live', diedSecondsAgo: null, tabs: [{ tabId: 0, name: 't', position: 0, active: true, panes }] }],
  }) as SnapshotV4

const t1 = new Date('2026-07-11T00:00:01Z')
const t2 = new Date('2026-07-11T00:00:02Z')
const t3 = new Date('2026-07-11T00:00:03Z')

describe('deriveActivity', () => {
  it('marks first-ever observations as Unknown (updatedAt null)', () => {
    const m = deriveActivity({}, snap([pane(7, 'aaa')]), t1)
    expect(m[paneKeyOf('s1', 0, 7)]).toEqual({ fp: 'aaa', updatedAt: null })
    // Unknown panes are omitted from the wire projection.
    expect(activityToWire(m)).toEqual({})
  })

  it('stamps a backend timestamp when a fingerprint changes', () => {
    const first = deriveActivity({}, snap([pane(7, 'aaa')]), t1)
    const second = deriveActivity(first, snap([pane(7, 'bbb')]), t2)
    expect(second[paneKeyOf('s1', 0, 7)]).toEqual({ fp: 'bbb', updatedAt: t2.toISOString() })
    expect(activityToWire(second)).toEqual({ 's1:0:7': t2.toISOString() })
  })

  it('keeps the prior timestamp when the fingerprint is unchanged', () => {
    const first = deriveActivity({}, snap([pane(7, 'aaa')]), t1)
    const changed = deriveActivity(first, snap([pane(7, 'bbb')]), t2)
    const same = deriveActivity(changed, snap([pane(7, 'bbb')]), t3)
    // Unchanged since t2 → time stays t2, not t3.
    expect(same[paneKeyOf('s1', 0, 7)]?.updatedAt).toBe(t2.toISOString())
  })

  it('drops panes that are no longer present (closed)', () => {
    const first = deriveActivity({}, snap([pane(7, 'aaa'), pane(8, 'ccc')]), t1)
    const second = deriveActivity(first, snap([pane(7, 'aaa')]), t2)
    expect(second[paneKeyOf('s1', 0, 8)]).toBeUndefined()
    expect(second[paneKeyOf('s1', 0, 7)]).toBeDefined()
  })

  it('tolerates a missing/legacy stored map', () => {
    expect(asActivityMap(null)).toEqual({})
    expect(asActivityMap('nope')).toEqual({})
    expect(asActivityMap({ 'a:b:c': { fp: 'x', updatedAt: null } })).toEqual({ 'a:b:c': { fp: 'x', updatedAt: null } })
  })
})
