import { describe, expect, it } from 'vitest'
import type { GithubAsset, GithubRelease } from '../src/github/client'
import { findAsset, findChecksum, parseChecksumText, pickLatestRelease } from '../src/github/releases'

const asset = (name: string): GithubAsset => ({ name, size: 0, browser_download_url: `https://dl/${name}` })
const rel = (tag: string, over: Partial<GithubRelease> = {}): GithubRelease => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  assets: [asset('zantiflow.wasm')],
  ...over,
})

const opts = { allowPrerelease: false }

describe('pickLatestRelease', () => {
  it('picks the highest SemVer, not the most recently published', () => {
    // v1.1.5 comes LAST in the list (most recent publish) but is a patch to an older line.
    const releases = [rel('v1.2.0'), rel('v1.0.0'), rel('v1.1.5')]
    expect(pickLatestRelease(releases, opts)?.release.tag_name).toBe('v1.2.0')
  })

  it('ignores drafts and (by default) pre-releases', () => {
    const releases = [rel('v1.2.0'), rel('v1.3.0', { draft: true }), rel('v1.4.0', { prerelease: true })]
    expect(pickLatestRelease(releases, opts)?.release.tag_name).toBe('v1.2.0')
  })

  it('considers pre-releases when opted in', () => {
    const releases = [rel('v1.2.0'), rel('v1.4.0-rc.1', { prerelease: true })]
    expect(pickLatestRelease(releases, { allowPrerelease: true })?.release.tag_name).toBe('v1.4.0-rc.1')
  })

  it('skips unparseable tags and returns null when nothing qualifies', () => {
    expect(pickLatestRelease([rel('v1.2.0'), rel('nightly')], opts)?.release.tag_name).toBe('v1.2.0')
    expect(pickLatestRelease([rel('nightly'), rel('latest')], opts)).toBeNull()
  })
})

describe('findAsset / findChecksum', () => {
  it('finds the wasm asset by exact name', () => {
    expect(findAsset(rel('v1'), 'zantiflow.wasm')?.name).toBe('zantiflow.wasm')
    expect(findAsset(rel('v1'), 'missing.wasm')).toBeUndefined()
  })

  it('prefers a dedicated <asset>.sha256, then a sums file', () => {
    const withSingle = rel('v1', { assets: [asset('zantiflow.wasm'), asset('zantiflow.wasm.sha256')] })
    expect(findChecksum(withSingle, 'zantiflow.wasm')?.name).toBe('zantiflow.wasm.sha256')
    const withSums = rel('v1', { assets: [asset('zantiflow.wasm'), asset('SHA256SUMS')] })
    expect(findChecksum(withSums, 'zantiflow.wasm')?.name).toBe('SHA256SUMS')
    expect(findChecksum(rel('v1'), 'zantiflow.wasm')).toBeUndefined()
  })
})

describe('parseChecksumText', () => {
  const hex = 'a'.repeat(64)
  it('reads `<hex>  file` and `<hex> *file`', () => {
    expect(parseChecksumText(`${hex}  zantiflow.wasm\n`, 'zantiflow.wasm')).toBe(hex)
    expect(parseChecksumText(`${hex} *zantiflow.wasm\n`, 'zantiflow.wasm')).toBe(hex)
  })
  it('reads a bare digest', () => {
    expect(parseChecksumText(`${hex}\n`, 'zantiflow.wasm')).toBe(hex)
  })
  it('picks the line naming our file out of a multi-file sums list', () => {
    const other = 'b'.repeat(64)
    const text = `${other}  other.bin\n${hex}  zantiflow.wasm\n`
    expect(parseChecksumText(text, 'zantiflow.wasm')).toBe(hex)
  })
  it('returns null when no digest is present', () => {
    expect(parseChecksumText('no checksum here\n', 'zantiflow.wasm')).toBeNull()
  })
})
