import { describe, it, expect } from 'vitest'
import { ControlRequest, ControlResponse, jsonSchemas } from '../src'

describe('ControlRequest (ADR-0026)', () => {
  it('accepts a machineId + live session ids', () => {
    const r = ControlRequest.safeParse({ machineId: 'm-abc', liveSids: ['s1', 's2'] })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.liveSids).toEqual(['s1', 's2'])
  })

  it('accepts an empty liveSids array (a machine with no reported sessions yet)', () => {
    expect(ControlRequest.safeParse({ machineId: 'm-abc', liveSids: [] }).success).toBe(true)
  })

  it('rejects a missing machineId and a non-array liveSids', () => {
    expect(ControlRequest.safeParse({ liveSids: [] }).success).toBe(false)
    expect(ControlRequest.safeParse({ machineId: 'm', liveSids: 'nope' }).success).toBe(false)
  })

  it('bounds liveSids length (DoS guard)', () => {
    const many = Array.from({ length: 201 }, (_, i) => `s${i}`)
    expect(ControlRequest.safeParse({ machineId: 'm', liveSids: many }).success).toBe(false)
  })

  it('accepts an opt-in waitMs (long-poll, ADR-0029) and bounds it', () => {
    const ok = ControlRequest.safeParse({ machineId: 'm', liveSids: [], waitMs: 25_000 })
    expect(ok.success).toBe(true)
    if (ok.success) expect(ok.data.waitMs).toBe(25_000)
    // Omitted → undefined (the default immediate-response path).
    const none = ControlRequest.safeParse({ machineId: 'm', liveSids: [] })
    expect(none.success && none.data.waitMs).toBeUndefined()
    // Out of range / non-integer are rejected (DoS guard on how long a socket can be held).
    expect(ControlRequest.safeParse({ machineId: 'm', liveSids: [], waitMs: 60_000 }).success).toBe(false)
    expect(ControlRequest.safeParse({ machineId: 'm', liveSids: [], waitMs: -1 }).success).toBe(false)
    expect(ControlRequest.safeParse({ machineId: 'm', liveSids: [], waitMs: 1.5 }).success).toBe(false)
  })
})

describe('ControlResponse (ADR-0026)', () => {
  it('round-trips pendingOutput + viewers + refreshSeq', () => {
    const r = ControlResponse.safeParse({
      pendingOutput: [{ machineId: 'm-abc', sessionSid: 'sabc', tabId: 0, paneId: 1 }],
      viewers: { active: true },
      refreshSeq: 3,
    })
    expect(r.success).toBe(true)
  })

  it('rejects a negative refreshSeq', () => {
    expect(ControlResponse.safeParse({ pendingOutput: [], viewers: { active: false }, refreshSeq: -1 }).success).toBe(
      false,
    )
  })
})

describe('jsonSchemas', () => {
  it('exports the control contracts for language-neutral codegen', () => {
    expect(jsonSchemas.controlRequest).toBeDefined()
    expect(jsonSchemas.controlResponse).toBeDefined()
  })
})
