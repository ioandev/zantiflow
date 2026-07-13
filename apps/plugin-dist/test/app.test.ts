import { createHash } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config'
import { createApp } from '../src/http/app'
import { nullLogger } from '../src/log'
import { createWasmStore, type WasmArtifact, type WasmStore } from '../src/wasm/store'

const bytes = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]) // wasm magic + version
const sha256 = createHash('sha256').update(bytes).digest('hex')

const artifact = (): WasmArtifact => ({
  version: 'v1.2.3',
  bytes,
  size: bytes.length,
  sha256,
  etag: `"${sha256}"`,
  contentType: 'application/wasm',
  fetchedAt: '2026-07-12T00:00:00.000Z',
  verified: true,
})

const build = (store: WasmStore): express.Express =>
  createApp({ config: parseConfig({}), logger: nullLogger, store, readiness: () => store.get() !== null })

// Supertest doesn't buffer an `application/wasm` body by default — collect the raw bytes.
const rawParser = (res: request.Response, cb: (err: Error | null, body: Buffer) => void): void => {
  const chunks: Buffer[] = []
  res.on('data', (c: Buffer) => chunks.push(c))
  res.on('end', () => cb(null, Buffer.concat(chunks)))
}

describe('plugin-dist HTTP', () => {
  let store: WasmStore
  beforeEach(() => {
    store = createWasmStore()
  })

  it('503s /zantiflow.wasm and /readyz before an artifact is loaded', async () => {
    const app = build(store)
    await request(app).get('/zantiflow.wasm').expect(503).expect('Retry-After', '10')
    await request(app).get('/readyz').expect(503)
    await request(app).get('/healthz').expect(200)
  })

  it('serves the wasm bytes with the right headers', async () => {
    store.set(artifact())
    const res = await request(build(store)).get('/zantiflow.wasm').buffer(true).parse(rawParser)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/wasm')
    expect(res.headers['content-length']).toBe(String(bytes.length))
    expect(res.headers['etag']).toBe(`"${sha256}"`)
    expect(res.headers['cache-control']).toBe('public, max-age=300')
    expect(res.headers['x-zantiflow-plugin-version']).toBe('v1.2.3')
    expect(Buffer.compare(res.body, bytes)).toBe(0)
  })

  it('honors If-None-Match with a 304', async () => {
    store.set(artifact())
    await request(build(store)).get('/zantiflow.wasm').set('If-None-Match', `"${sha256}"`).expect(304)
    await request(build(store)).get('/zantiflow.wasm').set('If-None-Match', '*').expect(304)
    await request(build(store)).get('/zantiflow.wasm').set('If-None-Match', '"stale"').expect(200)
  })

  it('answers HEAD with headers and no body', async () => {
    store.set(artifact())
    const res = await request(build(store)).head('/zantiflow.wasm').expect(200)
    expect(res.headers['content-length']).toBe(String(bytes.length))
    expect(res.text).toBeUndefined()
  })

  it('exposes the checksum and version metadata', async () => {
    store.set(artifact())
    const app = build(store)
    await request(app)
      .get('/zantiflow.wasm.sha256')
      .expect(200)
      .expect('Content-Type', /text\/plain/)
      .expect(`${sha256}  zantiflow.wasm\n`)
    const meta = await request(app).get('/version').expect(200)
    expect(meta.body).toMatchObject({ version: 'v1.2.3', sha256, size: bytes.length, verified: true })
  })

  it('serves /readyz 200 once ready and 404s unknown paths', async () => {
    store.set(artifact())
    const app = build(store)
    await request(app).get('/readyz').expect(200)
    await request(app)
      .get('/nope')
      .expect(404)
      .expect((r) => expect(r.body.error.code).toBe('not_found'))
  })
})
