import { describe, expect, it } from 'vitest'
import {
  durationAgo,
  hostnameModeLabel,
  lastSeenLabel,
  longDate,
  paneActivity,
  pluralize,
  privacyLevelLabel,
  relativeAgo,
  shortDate,
} from '../lib/format'

const NOW = Date.parse('2026-07-11T12:00:00Z')
const ago = (secs: number) => new Date(NOW - secs * 1000).toISOString()

describe('relative time', () => {
  it('formats seconds/minutes/hours/days', () => {
    expect(relativeAgo(ago(3), NOW)).toBe('3s ago')
    expect(relativeAgo(ago(90), NOW)).toBe('2m ago')
    expect(relativeAgo(ago(3600), NOW)).toBe('1h ago')
    expect(relativeAgo(ago(2 * 86400), NOW)).toBe('2d ago')
  })
  it('never goes negative on clock skew', () => {
    expect(relativeAgo(new Date(NOW + 5000).toISOString(), NOW)).toBe('0s ago')
  })
  it('collapses the freshest window to "just now" for last-seen', () => {
    expect(lastSeenLabel(ago(2), NOW)).toBe('just now')
    expect(lastSeenLabel(ago(42 * 60), NOW)).toBe('42m ago')
  })
  it('durationAgo formats a raw seconds count', () => {
    expect(durationAgo(300)).toBe('5m ago')
    expect(durationAgo(5)).toBe('5s ago')
  })
})

describe('dates (UTC)', () => {
  it('shortDate / longDate', () => {
    expect(shortDate('2026-03-12T00:00:00Z')).toBe('Mar 12')
    expect(longDate('2026-03-12T00:00:00Z')).toBe('Mar 12, 2026')
  })
})

describe('labels', () => {
  it('hostname + privacy', () => {
    expect(hostnameModeLabel('real')).toBe('real hostname')
    expect(hostnameModeLabel('alias')).toBe('alias')
    expect(privacyLevelLabel('full')).toBe('privacy: full')
    expect(privacyLevelLabel('restricted')).toBe('privacy: restricted (all names)')
  })
  it('pluralize', () => {
    expect(pluralize(1, 'tab')).toBe('1 tab')
    expect(pluralize(2, 'tab')).toBe('2 tabs')
    expect(pluralize(1, 'needs attention', 'need attention')).toBe('1 needs attention')
  })
})

describe('paneActivity — the design activity column', () => {
  it('fresh (green dot) when changed within 10s', () => {
    expect(paneActivity({ updatedAt: ago(3), needsAttention: false, exited: false, now: NOW })).toEqual({
      kind: 'fresh',
      label: '3s ago',
    })
  })
  it('plain when changed longer ago', () => {
    expect(paneActivity({ updatedAt: ago(41), needsAttention: false, exited: false, now: NOW })).toEqual({
      kind: 'plain',
      label: '41s ago',
    })
  })
  it('quiet Xm when the pane has an attention', () => {
    expect(paneActivity({ updatedAt: ago(12 * 60), needsAttention: true, exited: false, now: NOW })).toEqual({
      kind: 'quiet',
      label: 'quiet 12m',
    })
  })
  it('thinking when claude is busy, taking precedence over needs-attention', () => {
    expect(paneActivity({ updatedAt: ago(3), needsAttention: false, thinking: true, exited: false, now: NOW })).toEqual({
      kind: 'thinking',
    })
    // If both were somehow set, "busy" wins over "waiting".
    expect(paneActivity({ updatedAt: ago(3), needsAttention: true, thinking: true, exited: false, now: NOW })).toEqual({
      kind: 'thinking',
    })
  })
  it('Unknown when no change has ever been observed', () => {
    expect(paneActivity({ updatedAt: undefined, needsAttention: false, exited: false, now: NOW })).toEqual({
      kind: 'unknown',
    })
  })
  it('exited renders a faint plain time and wins over attention', () => {
    expect(paneActivity({ updatedAt: ago(3600), needsAttention: true, exited: true, now: NOW })).toEqual({
      kind: 'plain',
      label: '1h ago',
      faint: true,
    })
  })
})
