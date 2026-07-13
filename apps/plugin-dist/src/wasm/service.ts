// Refresh logic: resolve the highest-SemVer release, download its wasm, verify its checksum, and swap
// it into the store — plus a poller that runs it on an interval. This is where "latest without
// regression" is enforced (see the guard below). All I/O goes through the injected GithubClient, so
// the whole flow is unit-testable with a fake.
import { createHash } from 'node:crypto'
import type { Config } from '../config'
import type { GithubClient, GithubRelease } from '../github/client'
import { findAsset, findChecksum, parseChecksumText, pickLatestRelease } from '../github/releases'
import type { Logger } from '../log'
import { compareSemVer, parseSemVer } from '../semver'
import type { WasmStore } from './store'

export interface WasmServiceDeps {
  client: GithubClient
  store: WasmStore
  config: Config
  logger: Logger
  /** ISO-timestamp source — injectable so tests are deterministic. */
  now?: () => string
}

export interface RefreshResult {
  changed: boolean
  version?: string
}

const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** One refresh pass. Never throws for an "expected" miss (no release / missing asset / bad checksum) —
 *  it logs and keeps the last known-good artifact; only a transport failure from the client rejects. */
export const refreshWasm = async (deps: WasmServiceDeps): Promise<RefreshResult> => {
  const { client, store, config, logger } = deps
  const now = deps.now ?? (() => new Date().toISOString())
  const opts = { allowPrerelease: config.allowPrerelease }

  const releases = await client.listReleases()
  const picked = pickLatestRelease(releases, opts)
  if (!picked) {
    logger.warn('no_eligible_release', { repo: config.repo })
    return { changed: false }
  }

  const tag = picked.release.tag_name
  const current = store.get()
  if (current) {
    if (current.version === tag) return { changed: false, version: tag }
    // No-regression ratchet: only ever move to a HIGHER SemVer than we're already serving. A patch to
    // an older line (published later but numerically lower), or a transient/incomplete release list,
    // can never make us go backwards; a genuinely newer release is always higher, so it still wins. A
    // yanked top release keeps serving from memory until a restart.
    const currentParsed = parseSemVer(current.version)
    if (currentParsed && compareSemVer(picked.version, currentParsed) <= 0) {
      logger.info('skip_regression', { serving: current.version, candidate: tag })
      return { changed: false, version: current.version }
    }
  }

  const asset = findAsset(picked.release, config.wasmAssetName)
  if (!asset) {
    logger.warn('wasm_asset_missing', { tag, asset: config.wasmAssetName })
    return { changed: false, version: current?.version }
  }

  const bytes = await client.downloadBytes(asset.browser_download_url)
  const sha256 = sha256Hex(bytes)

  const verdict = await verifyChecksum(deps, picked.release, sha256)
  if (verdict === 'mismatch') {
    // Integrity is a security requirement (ADR-0022): refuse to serve tampered bytes; the last
    // known-good artifact stays in place.
    logger.error('wasm_checksum_mismatch', { tag, sha256 })
    return { changed: false, version: current?.version }
  }

  store.set({
    version: tag,
    bytes,
    size: bytes.length,
    sha256,
    etag: `"${sha256}"`,
    contentType: 'application/wasm',
    fetchedAt: now(),
    verified: verdict === 'ok',
  })
  logger.info('wasm_updated', { version: tag, size: bytes.length, sha256, verified: verdict === 'ok' })
  return { changed: true, version: tag }
}

type Verdict = 'ok' | 'unverified' | 'mismatch'

// Best-effort: verify against a published checksum when one exists; a missing/unparseable/unreachable
// checksum degrades to `unverified` (serve, but flag it) — only a real digest that disagrees is fatal.
const verifyChecksum = async (deps: WasmServiceDeps, release: GithubRelease, sha256: string): Promise<Verdict> => {
  const { client, config, logger } = deps
  const checksum = findChecksum(release, config.wasmAssetName)
  if (!checksum) {
    logger.warn('wasm_checksum_absent', { tag: release.tag_name })
    return 'unverified'
  }
  try {
    const text = await client.downloadText(checksum.browser_download_url)
    const expected = parseChecksumText(text, config.wasmAssetName)
    if (!expected) {
      logger.warn('wasm_checksum_unparsed', { tag: release.tag_name, asset: checksum.name })
      return 'unverified'
    }
    return expected === sha256 ? 'ok' : 'mismatch'
  } catch (e) {
    logger.warn('wasm_checksum_fetch_failed', { tag: release.tag_name, err: String(e) })
    return 'unverified'
  }
}

export interface WasmPoller {
  stop(): void
}

/** Kick an immediate refresh (so `/zantiflow.wasm` becomes ready ASAP), then re-check on an interval. */
export const startWasmPolling = (deps: WasmServiceDeps): WasmPoller => {
  const run = (): void => {
    void refreshWasm(deps).catch((e) => deps.logger.error('wasm_refresh_failed', { err: String(e) }))
  }
  run()
  const timer = setInterval(run, deps.config.pollIntervalMs)
  timer.unref()
  return { stop: () => clearInterval(timer) }
}
