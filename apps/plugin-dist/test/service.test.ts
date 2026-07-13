import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseConfig, type Config } from '../src/config'
import type { GithubClient, GithubRelease } from '../src/github/client'
import { nullLogger } from '../src/log'
import { refreshWasm } from '../src/wasm/service'
import { createWasmStore, type WasmStore } from '../src/wasm/store'

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

const asset = (name: string) => ({ name, size: 0, browser_download_url: `https://dl/${name}` })
const rel = (tag: string, over: Partial<GithubRelease> = {}): GithubRelease => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  assets: [asset('zantiflow.wasm')],
  ...over,
})

// A fake GithubClient backed by an in-memory url->content map, with call spies.
const fakeClient = (releases: GithubRelease[], files: Record<string, Buffer | string>) => {
  const downloadBytes = vi.fn(async (url: string) => {
    const f = files[url]
    if (f === undefined) throw new Error(`404 ${url}`)
    return Buffer.isBuffer(f) ? f : Buffer.from(f)
  })
  const downloadText = vi.fn(async (url: string) => {
    const f = files[url]
    if (f === undefined) throw new Error(`404 ${url}`)
    return Buffer.isBuffer(f) ? f.toString('utf8') : f
  })
  const client: GithubClient = { listReleases: vi.fn(async () => releases), downloadBytes, downloadText }
  return { client, downloadBytes, downloadText }
}

const config = (over: Partial<Config> = {}): Config => ({ ...parseConfig({}), ...over })

const deps = (client: GithubClient, store: WasmStore, over: Partial<Config> = {}) => ({
  client,
  store,
  config: config(over),
  logger: nullLogger,
  now: () => '2026-07-12T00:00:00.000Z',
})

describe('refreshWasm', () => {
  let store: WasmStore
  beforeEach(() => {
    store = createWasmStore()
  })

  it('mirrors the highest release and verifies its checksum', async () => {
    const bytes = Buffer.from('\0asm-v1.2.0')
    const releases = [
      rel('v1.2.0', { assets: [asset('zantiflow.wasm'), asset('zantiflow.wasm.sha256')] }),
      rel('v1.1.5'),
    ]
    const c = fakeClient(releases, {
      'https://dl/zantiflow.wasm': bytes,
      'https://dl/zantiflow.wasm.sha256': `${sha256(bytes)}  zantiflow.wasm\n`,
    })
    const res = await refreshWasm(deps(c.client, store))
    expect(res).toEqual({ changed: true, version: 'v1.2.0' })
    const art = store.get()!
    expect(art.version).toBe('v1.2.0')
    expect(art.sha256).toBe(sha256(bytes))
    expect(art.etag).toBe(`"${sha256(bytes)}"`)
    expect(art.verified).toBe(true)
    expect(Buffer.compare(art.bytes, bytes)).toBe(0)
  })

  it('picks the highest SemVer even when a lower patch was published more recently', async () => {
    const bytes = Buffer.from('bytes')
    // v1.1.5 is last in the list (most recent) but v1.2.0 must win.
    const c = fakeClient([rel('v1.2.0'), rel('v1.1.5')], { 'https://dl/zantiflow.wasm': bytes })
    const res = await refreshWasm(deps(c.client, store))
    expect(res.version).toBe('v1.2.0')
  })

  it('is a no-op when the latest tag is unchanged (no re-download)', async () => {
    const bytes = Buffer.from('bytes')
    const c = fakeClient([rel('v1.2.0')], { 'https://dl/zantiflow.wasm': bytes })
    await refreshWasm(deps(c.client, store))
    expect(c.downloadBytes).toHaveBeenCalledTimes(1)
    const again = await refreshWasm(deps(c.client, store))
    expect(again).toEqual({ changed: false, version: 'v1.2.0' })
    expect(c.downloadBytes).toHaveBeenCalledTimes(1)
  })

  it('never regresses to a lower version than the one already served', async () => {
    const bytes = Buffer.from('bytes')
    // First load v1.2.0.
    await refreshWasm(deps(fakeClient([rel('v1.2.0')], { 'https://dl/zantiflow.wasm': bytes }).client, store))
    expect(store.get()!.version).toBe('v1.2.0')
    // Now the API only reports lower versions (e.g. the top release vanished, or a partial response).
    const c = fakeClient([rel('v1.1.6'), rel('v1.1.5')], { 'https://dl/zantiflow.wasm': bytes })
    const res = await refreshWasm(deps(c.client, store))
    expect(res).toEqual({ changed: false, version: 'v1.2.0' })
    expect(store.get()!.version).toBe('v1.2.0')
    expect(c.downloadBytes).not.toHaveBeenCalled()
  })

  it('upgrades when a genuinely higher release appears', async () => {
    const b1 = Buffer.from('v120')
    await refreshWasm(deps(fakeClient([rel('v1.2.0')], { 'https://dl/zantiflow.wasm': b1 }).client, store))
    const b2 = Buffer.from('v130')
    const c = fakeClient([rel('v1.3.0'), rel('v1.2.0')], { 'https://dl/zantiflow.wasm': b2 })
    const res = await refreshWasm(deps(c.client, store))
    expect(res).toEqual({ changed: true, version: 'v1.3.0' })
    expect(Buffer.compare(store.get()!.bytes, b2)).toBe(0)
  })

  it('refuses to serve bytes that fail an existing checksum', async () => {
    const bytes = Buffer.from('bytes')
    const releases = [rel('v1.2.0', { assets: [asset('zantiflow.wasm'), asset('zantiflow.wasm.sha256')] })]
    const c = fakeClient(releases, {
      'https://dl/zantiflow.wasm': bytes,
      'https://dl/zantiflow.wasm.sha256': `${'f'.repeat(64)}  zantiflow.wasm\n`, // wrong digest
    })
    const res = await refreshWasm(deps(c.client, store))
    expect(res.changed).toBe(false)
    expect(store.get()).toBeNull()
  })

  it('serves but flags verified:false when no checksum is published', async () => {
    const bytes = Buffer.from('bytes')
    const c = fakeClient([rel('v1.2.0')], { 'https://dl/zantiflow.wasm': bytes })
    await refreshWasm(deps(c.client, store))
    expect(store.get()!.verified).toBe(false)
  })

  it('keeps the last artifact when the winning release lacks the wasm asset', async () => {
    const bytes = Buffer.from('bytes')
    await refreshWasm(deps(fakeClient([rel('v1.2.0')], { 'https://dl/zantiflow.wasm': bytes }).client, store))
    const c = fakeClient([rel('v1.3.0', { assets: [asset('notes.txt')] }), rel('v1.2.0')], {})
    const res = await refreshWasm(deps(c.client, store))
    expect(res).toEqual({ changed: false, version: 'v1.2.0' })
    expect(store.get()!.version).toBe('v1.2.0')
  })

  it('warns and does nothing when there is no eligible release', async () => {
    const c = fakeClient([rel('nightly'), rel('v1.0.0', { draft: true })], {})
    const res = await refreshWasm(deps(c.client, store))
    expect(res).toEqual({ changed: false })
    expect(store.get()).toBeNull()
  })
})
