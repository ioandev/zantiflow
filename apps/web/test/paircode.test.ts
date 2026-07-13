import { describe, it, expect } from 'vitest'
import { approveErrorMessage, formatUserCode, isCompleteCode, stripUserCode } from '../lib/paircode'

describe('pairing code input helpers', () => {
  it('strips to the 8 significant base32 characters, uppercased', () => {
    expect(stripUserCode('abcd-efgh')).toBe('ABCDEFGH')
    expect(stripUserCode('  ab cd ef gh  ')).toBe('ABCDEFGH')
    expect(stripUserCode('ABCDEFGHIJK')).toBe('ABCDEFGH') // capped at 8
  })

  it('formats as XXXX-XXXX only once past four characters', () => {
    expect(formatUserCode('ab')).toBe('AB')
    expect(formatUserCode('abcd')).toBe('ABCD')
    expect(formatUserCode('abcde')).toBe('ABCD-E')
    expect(formatUserCode('abcdefgh')).toBe('ABCD-EFGH')
    // re-formatting an already-formatted value is stable
    expect(formatUserCode('ABCD-EFGH')).toBe('ABCD-EFGH')
  })

  it('is complete only with all eight characters', () => {
    expect(isCompleteCode('ABCD-EFG')).toBe(false)
    expect(isCompleteCode('ABCD-EFGH')).toBe(true)
    expect(isCompleteCode('abcdefgh')).toBe(true)
  })
})

describe('approve error messages', () => {
  it('maps known backend codes to actionable copy', () => {
    expect(approveErrorMessage('invalid_code')).toMatch(/recognized/i)
    expect(approveErrorMessage('code_expired')).toMatch(/expired/i)
    expect(approveErrorMessage('code_not_pending')).toMatch(/already used/i)
  })

  it('special-cases rate limiting, and falls back otherwise', () => {
    expect(approveErrorMessage('rate_limited', 429)).toMatch(/too many/i)
    expect(approveErrorMessage('weird')).toMatch(/try again/i)
  })
})
