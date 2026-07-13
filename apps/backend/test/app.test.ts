import { PrismaClient } from '@prisma/client'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { parseConfig } from '../src/config'
import { createApp } from '../src/http/app'
import { nullLogger } from '../src/log'

const config = parseConfig({
  DATABASE_URL: 'mysql://u:p@localhost:3306/zantiflow',
  TOKEN_SECRET: 'x'.repeat(32),
  WEB_ORIGIN: 'https://app.example',
})
// The skeleton routes exercised here (health, 404, headers) never query — an unconnected client is fine.
const prisma = new PrismaClient({ adapter: new PrismaMariaDb(config.databaseUrl) })
const app = createApp({ config, logger: nullLogger, prisma })

describe('createApp — HTTP skeleton', () => {
  it('GET /healthz → 200 ok, with the build identity', async () => {
    const res = await request(app).get('/healthz')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    // Version/commit come from the image (APP_VERSION/GIT_SHA); unset in tests → pkg version + 'unknown'.
    expect(typeof res.body.version).toBe('string')
    expect(res.body.commit).toBe('unknown')
  })

  it('GET /readyz → 200 ready by default', async () => {
    const res = await request(app).get('/readyz')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ready')
  })

  it('GET /readyz → 503 when the readiness check fails', async () => {
    const notReady = createApp({ config, logger: nullLogger, prisma, readiness: () => false })
    const res = await request(notReady).get('/readyz')
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('not_ready')
  })

  it('unknown route → 404 in the standard error envelope', async () => {
    const res = await request(app).get('/api/v1/nope')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: { code: 'not_found', message: 'Not Found' } })
  })

  it('sets hardening headers and reflects the locked CORS origin', async () => {
    const res = await request(app).get('/healthz').set('Origin', 'https://app.example')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-powered-by']).toBeUndefined()
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example')
  })

  it('rejects a malformed JSON body with a 400 envelope', async () => {
    const res = await request(app).post('/api/v1/nope').set('Content-Type', 'application/json').send('{bad json')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })
})
