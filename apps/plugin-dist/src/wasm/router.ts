// Serves the mirrored artifact: `GET|HEAD /<asset>` (with ETag/conditional-GET), a convenience
// `GET /<asset>.sha256`, and a small `GET /version` status. Reads the store on every request, so a
// background swap is picked up with no restart.
import { Router } from 'express'
import type { Config } from '../config'
import { asyncHandler } from '../http/async'
import { serviceUnavailable } from '../http/errors'
import type { WasmStore } from './store'

// Does an `If-None-Match` header match our strong ETag? Handles `*`, comma lists, and `W/` weak tags.
const ifNoneMatchHit = (header: string | undefined, etag: string): boolean => {
  if (!header) return false
  if (header.trim() === '*') return true
  return header
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .includes(etag)
}

export const wasmRouter = (store: WasmStore, config: Config): Router => {
  const r = Router()
  const path = `/${config.wasmAssetName}`

  const serve = async (
    req: import('express').Request,
    res: import('express').Response,
    headOnly: boolean,
  ): Promise<void> => {
    const art = store.get()
    if (!art) {
      res.setHeader('Retry-After', '10')
      throw serviceUnavailable('Plugin artifact is not available yet')
    }
    res.setHeader('ETag', art.etag)
    res.setHeader('Cache-Control', `public, max-age=${config.cacheMaxAgeSeconds}`)
    res.setHeader('X-Zantiflow-Plugin-Version', art.version)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Last-Modified', new Date(art.fetchedAt).toUTCString())
    if (ifNoneMatchHit(req.headers['if-none-match'], art.etag)) {
      res.status(304).end()
      return
    }
    res.setHeader('Content-Type', art.contentType)
    res.setHeader('Content-Length', String(art.size))
    res.setHeader('Content-Disposition', `inline; filename="${config.wasmAssetName}"`)
    if (headOnly) {
      res.status(200).end()
      return
    }
    res.status(200).end(art.bytes)
  }

  r.get(
    path,
    asyncHandler((req, res) => serve(req, res, false)),
  )
  r.head(
    path,
    asyncHandler((req, res) => serve(req, res, true)),
  )

  // Convenience: the SHA-256 of exactly what we're serving (ADR-0022 recommends verifying it).
  r.get(
    `${path}.sha256`,
    asyncHandler(async (_req, res) => {
      const art = store.get()
      if (!art) {
        res.setHeader('Retry-After', '10')
        throw serviceUnavailable('Plugin artifact is not available yet')
      }
      res.type('text/plain').send(`${art.sha256}  ${config.wasmAssetName}\n`)
    }),
  )

  // Small JSON status — which version is live and whether it was checksum-verified.
  r.get('/version', (_req, res) => {
    const art = store.get()
    res.json({
      version: art?.version ?? null,
      sha256: art?.sha256 ?? null,
      size: art?.size ?? null,
      verified: art?.verified ?? false,
      fetchedAt: art?.fetchedAt ?? null,
    })
  })

  return r
}
