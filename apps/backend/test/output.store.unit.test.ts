// Unit tests for the in-memory pane-output store (ADR-0032) — pure, no DB. The store is what makes
// "captured pane content is never stored" true: content lives here only, keyed by the pane's full
// identity, and is dropped on re-request, machine-forget, or the retention sweep.
import { describe, expect, it } from 'vitest'
import { createPaneOutputStore, PANE_OUTPUT_RETENTION_SEC } from '../src/output/store'

const AT = new Date('2026-07-12T00:00:00.000Z')

describe('PaneOutputStore', () => {
  it('holds and returns the latest capture for a pane (last-write-wins)', () => {
    const s = createPaneOutputStore()
    s.put('acc', 'm1', 's1:0:1', ['old'], AT)
    s.put('acc', 'm1', 's1:0:1', ['new'], AT)
    expect(s.get('acc', 'm1', 's1:0:1')).toEqual({ lines: ['new'], capturedAt: AT })
    expect(s.size()).toBe(1)
  })

  it('scopes by account, machine, and full pane key — no cross-bleed', () => {
    const s = createPaneOutputStore()
    s.put('acc', 'm1', 's1:0:1', ['a'], AT)
    // Same numeric paneId but a different session/tab must NOT collide.
    s.put('acc', 'm1', 's2:1:1', ['b'], AT)
    s.put('other', 'm1', 's1:0:1', ['c'], AT)
    expect(s.get('acc', 'm1', 's1:0:1')?.lines).toEqual(['a'])
    expect(s.get('acc', 'm1', 's2:1:1')?.lines).toEqual(['b'])
    expect(s.get('other', 'm1', 's1:0:1')?.lines).toEqual(['c'])
    expect(s.get('acc', 'm1', 's9:9:9')).toBeUndefined()
  })

  it('drops a single pane on delete (fresh-on-open re-request)', () => {
    const s = createPaneOutputStore()
    s.put('acc', 'm1', 's1:0:1', ['x'], AT)
    s.delete('acc', 'm1', 's1:0:1')
    expect(s.get('acc', 'm1', 's1:0:1')).toBeUndefined()
  })

  it('purges every pane of one machine on deleteMachine — and no other machine', () => {
    const s = createPaneOutputStore()
    s.put('acc', 'm1', 's1:0:1', ['a'], AT)
    s.put('acc', 'm1', 's1:0:2', ['b'], AT)
    // A machine whose id has m1 as a prefix must NOT be swept by m1's purge.
    s.put('acc', 'm12', 's1:0:1', ['keep'], AT)
    s.put('acc', 'm2', 's1:0:1', ['keep2'], AT)
    s.deleteMachine('acc', 'm1')
    expect(s.get('acc', 'm1', 's1:0:1')).toBeUndefined()
    expect(s.get('acc', 'm1', 's1:0:2')).toBeUndefined()
    expect(s.get('acc', 'm12', 's1:0:1')?.lines).toEqual(['keep'])
    expect(s.get('acc', 'm2', 's1:0:1')?.lines).toEqual(['keep2'])
  })

  it('prunes captures older than the retention window, keeps fresh ones (on receipt time)', () => {
    let clock = 1_000_000
    const s = createPaneOutputStore({ now: () => clock })
    s.put('acc', 'm1', 's1:0:1', ['stale'], AT)
    clock += 10_000
    s.put('acc', 'm1', 's1:0:2', ['fresh'], AT)

    // A sweep just past the first capture's retention window drops it but keeps the newer one.
    s.prune(new Date(1_000_000 + PANE_OUTPUT_RETENTION_SEC * 1000 + 5_000))
    expect(s.get('acc', 'm1', 's1:0:1')).toBeUndefined()
    expect(s.get('acc', 'm1', 's1:0:2')?.lines).toEqual(['fresh'])
  })
})
