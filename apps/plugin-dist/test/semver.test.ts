import { describe, expect, it } from 'vitest'
import { compareSemVer, parseSemVer } from '../src/semver'

describe('parseSemVer', () => {
  it('parses tags with and without a leading v', () => {
    expect(parseSemVer('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
    expect(parseSemVer('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
  })

  it('parses pre-release identifiers and ignores build metadata', () => {
    expect(parseSemVer('v1.2.3-rc.1')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ['rc', '1'] })
    expect(parseSemVer('v1.2.3+build.7')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
  })

  it('rejects non-SemVer tags', () => {
    for (const bad of ['latest', 'v1', 'v1.2', '1.2.3.4', 'nightly', '']) {
      expect(parseSemVer(bad)).toBeNull()
    }
  })
})

describe('compareSemVer', () => {
  const cmp = (a: string, b: string): number => compareSemVer(parseSemVer(a)!, parseSemVer(b)!)

  it('orders by major, minor, then patch', () => {
    expect(cmp('v1.2.0', 'v1.1.5')).toBe(1)
    expect(cmp('v2.0.0', 'v1.9.9')).toBe(1)
    expect(cmp('v1.2.3', 'v1.2.4')).toBe(-1)
    expect(cmp('v1.2.3', 'v1.2.3')).toBe(0)
  })

  it('ranks a pre-release below the same released version', () => {
    expect(cmp('v1.2.3-rc.1', 'v1.2.3')).toBe(-1)
    expect(cmp('v1.2.3', 'v1.2.3-rc.1')).toBe(1)
  })

  it('orders pre-release identifiers per the spec (numeric < alphanumeric, longer wins)', () => {
    expect(cmp('v1.0.0-alpha', 'v1.0.0-alpha.1')).toBe(-1)
    expect(cmp('v1.0.0-alpha.1', 'v1.0.0-alpha.beta')).toBe(-1)
    expect(cmp('v1.0.0-1', 'v1.0.0-alpha')).toBe(-1)
  })
})
