import { describe, it, expect } from 'vitest'
import { parseSnapshot, WIRE_VERSION } from '../src'

const valid = {
  version: 4,
  machineId: 'm-abc',
  capturedAtTick: 42,
  privacy: { full: true, machine: 'alias', sessionNames: 'send', tabNames: 'send', paneNames: 'hidden' },
  machine: { source: 'alias', name: 'red-laptop' },
  attentions: [
    { type: 'claude.needs-input', target: { sessionSid: 's1', tabId: 0, paneId: 1 }, state: 'active', since: 40 },
  ],
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
          panes: [{ id: 1, name: null, command: null, isFocused: true, exited: false, contentFingerprint: 'ab12' }],
        },
      ],
    },
  ],
}

describe('parseSnapshot (wire v4)', () => {
  it('accepts a valid v4 snapshot', () => {
    expect(parseSnapshot(valid).ok).toBe(true)
  })

  it('ignores unknown fields (forward-compat)', () => {
    const r = parseSnapshot({ ...valid, futureField: 'x' })
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.snapshot as Record<string, unknown>).futureField).toBeUndefined()
  })

  it('per-pane claude flag (ADR-0055) is optional additive — still v4', () => {
    expect(parseSnapshot(valid).ok).toBe(true) // old plugins omit it
    const pane = {
      id: 1,
      name: 'Pane #1',
      command: null,
      isFocused: true,
      exited: false,
      contentFingerprint: 'ab12',
      claude: true,
    }
    const withFlag = structuredClone(valid)
    withFlag.sessions[0].tabs[0].panes = [pane]
    const r = parseSnapshot(withFlag)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.snapshot.sessions[0].tabs[0].panes[0].claude).toBe(true)
  })

  it('claudeActive (ADR-0051) is optional additive — still v4', () => {
    expect(parseSnapshot(valid).ok).toBe(true) // old plugins omit it
    const r = parseSnapshot({ ...valid, claudeActive: true })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.snapshot.claudeActive).toBe(true)
    expect(parseSnapshot({ ...valid, claudeActive: 'yes' }).ok).toBe(false)
  })

  it('rejects unknown-newer version', () => {
    const r = parseSnapshot({ ...valid, version: 5 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('unknown_wire_version')
  })

  it('rejects an unsupported older version', () => {
    const r = parseSnapshot({ ...valid, version: 3 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('unsupported_wire_version')
  })

  it('rejects a malformed body', () => {
    const r = parseSnapshot({ ...valid, machineId: 123 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('invalid_body')
  })

  it('rejects a non-object / missing version', () => {
    expect(parseSnapshot(null).ok).toBe(false)
    expect(parseSnapshot({}).ok).toBe(false)
  })

  it('enforces bounds (too many sessions → DoS guard)', () => {
    const r = parseSnapshot({ ...valid, sessions: Array(201).fill(valid.sessions[0]) })
    expect(r.ok).toBe(false)
  })

  it('accepts redacted (null) names and a resurrectable session with no tabs', () => {
    const r = parseSnapshot({
      ...valid,
      sessions: [{ sid: 'd1', name: null, isCurrent: false, state: 'resurrectable', diedSecondsAgo: 300, tabs: [] }],
    })
    expect(r.ok).toBe(true)
  })

  it('WIRE_VERSION is 4', () => {
    expect(WIRE_VERSION).toBe(4)
  })
})
