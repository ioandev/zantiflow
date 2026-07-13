// Pure release-selection logic — no I/O, so the no-regression rule is unit-testable in isolation.
import { compareSemVer, parseSemVer, type SemVer } from '../semver'
import type { GithubAsset, GithubRelease } from './client'

export interface PickOptions {
  allowPrerelease: boolean
}

export interface PickedRelease {
  release: GithubRelease
  version: SemVer
}

/** Releases eligible to be "latest": published (not draft) and, unless opted in, not pre-releases. */
export const eligibleReleases = (releases: GithubRelease[], opts: PickOptions): GithubRelease[] =>
  releases.filter((r) => !r.draft && (opts.allowPrerelease || !r.prerelease))

/** The eligible tags as a Set — used to tell whether a served version is still published (vs yanked). */
export const eligibleTags = (releases: GithubRelease[], opts: PickOptions): Set<string> =>
  new Set(eligibleReleases(releases, opts).map((r) => r.tag_name))

/**
 * Pick the highest-SemVer release — NOT the most recently published one. This is what makes updates
 * regression-free: a patch cut on an older line (e.g. `v1.1.5` published after `v1.2.0`) has a newer
 * date but a lower version, so it never wins. Unparseable tags are ignored. `null` if none qualify.
 */
export const pickLatestRelease = (releases: GithubRelease[], opts: PickOptions): PickedRelease | null => {
  let best: PickedRelease | null = null
  for (const release of eligibleReleases(releases, opts)) {
    const version = parseSemVer(release.tag_name)
    if (!version) continue
    if (!best || compareSemVer(version, best.version) > 0) best = { release, version }
  }
  return best
}

export const findAsset = (release: GithubRelease, name: string): GithubAsset | undefined =>
  release.assets.find((a) => a.name === name)

// Where a release publishes the wasm's SHA-256 (ADR-0022). The exact name isn't fixed yet, so we try
// a dedicated `<asset>.sha256` first, then a combined sums file.
const SUMS_NAMES = ['SHA256SUMS', 'SHA256SUMS.txt', 'checksums.txt', 'checksums-sha256.txt']

export const findChecksum = (release: GithubRelease, wasmName: string): GithubAsset | undefined =>
  release.assets.find((a) => a.name === `${wasmName}.sha256`) ?? release.assets.find((a) => SUMS_NAMES.includes(a.name))

const HEX64 = /\b[0-9a-fA-F]{64}\b/

/**
 * Extract the expected SHA-256 (lower-case hex) for `wasmName` from a checksum file's text. Handles
 * `<hex>  file`, `<hex> *file`, a bare `<hex>`, and multi-file sums lists. A line naming our file
 * wins; otherwise a lone digest is accepted. `null` if none is found.
 */
export const parseChecksumText = (text: string, wasmName: string): string | null => {
  let bareHex: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const hexMatch = HEX64.exec(trimmed)
    if (!hexMatch) continue
    const hex = hexMatch[0].toLowerCase()
    if (trimmed.includes(wasmName)) return hex
    if (bareHex === null && /^[0-9a-fA-F]{64}$/.test(trimmed)) bareHex = hex
  }
  return bareHex
}
