// Token management + ingest-auth against a REAL MariaDB (testcontainers): mint/list/revoke, the
// ≤10-active cap (incl. concurrency), IDOR (B can't revoke A's token), and server-side
// expiry/revocation on ingest auth. Owner sessions are crafted directly via signSession (the OAuth
// flow itself is covered by auth.integration.test.ts).
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { MariaDbContainer, type StartedMariaDbContainer } from '@testcontainers/mariadb'
import { PrismaClient } from '@prisma/client'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import type { Express } from 'express'
import { signSession } from '../src/auth/tokens'
import { parseConfig, type Config } from '../src/config'
import { createApp } from '../src/http/app'
import { nullLogger } from '../src/log'
import { authenticateIngest, MAX_ACTIVE_TOKENS } from '../src/tokens/service'
import { containerRuntimeUp, socketPath } from './helpers/runtime'

const runtimeUp = await containerRuntimeUp()
if (!runtimeUp) {
  console.warn(`[tokens.integration] no container runtime at ${socketPath} — skipping token integration tests`)
}
const suite = runtimeUp ? describe : describe.skip

suite('tokens integration (testcontainers MariaDB)', () => {
  let container: StartedMariaDbContainer
  let prisma: PrismaClient
  let app: Express
  let config: Config
  let seq = 0

  // Create a fresh account and return its owner-session cookie.
  const newAccount = async (): Promise<{ id: string; cookie: string }> => {
    const acc = await prisma.account.create({
      data: { oauthProvider: 'google', oauthId: `sub-${seq++}`, name: 'Owner' },
    })
    const cookie = `ztf_session=${signSession(config.tokenSecret, { accountId: acc.id, epoch: acc.sessionEpoch }, 14)}`
    return { id: acc.id, cookie }
  }

  beforeAll(async () => {
    container = await new MariaDbContainer('mariadb:11.4')
      .withDatabase('zantiflow')
      .withUsername('zantiflow')
      .withUserPassword('zantiflow')
      .start()
    const url = `mysql://zantiflow:zantiflow@${container.getHost()}:${container.getPort()}/zantiflow`
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ adapter: new PrismaMariaDb(url) })
    await prisma.$connect()
    config = parseConfig({ DATABASE_URL: url, TOKEN_SECRET: 'x'.repeat(40), COOKIE_SECURE: 'false' })
    app = createApp({ config, logger: nullLogger, prisma })
  }, 240_000)

  afterAll(async () => {
    await prisma?.$disconnect()
    await container?.stop()
  })

  it('requires an owner session (401 without one)', async () => {
    expect((await request(app).get('/api/v1/tokens')).status).toBe(401)
    expect((await request(app).post('/api/v1/tokens').send({})).status).toBe(401)
  })

  it('mints a token (secret shown once), lists metadata only, and authenticates ingest', async () => {
    const { id: accountId, cookie } = await newAccount()
    const mint = await request(app).post('/api/v1/tokens').set('Cookie', cookie).send({ label: 'laptop', ttl: '30d' })
    expect(mint.status).toBe(201)
    expect(mint.body.secret).toMatch(/^ztf_/)
    expect(mint.headers['cache-control']).toBe('no-store')

    const list = await request(app).get('/api/v1/tokens').set('Cookie', cookie)
    expect(list.status).toBe(200)
    expect(list.body.tokens).toHaveLength(1)
    expect(list.body.tokens[0]).toMatchObject({ label: 'laptop', status: 'active' })
    // NEVER leak the secret or its hash.
    expect(JSON.stringify(list.body)).not.toContain(mint.body.secret)
    expect(JSON.stringify(list.body)).not.toMatch(/secretHash|lookupPrefix/)

    const principal = await authenticateIngest(prisma, `Bearer ${mint.body.secret}`)
    expect(principal).toEqual({ accountId, tokenId: mint.body.id })
  })

  it('revokes a token → ingest auth then fails', async () => {
    const { cookie } = await newAccount()
    const mint = await request(app).post('/api/v1/tokens').set('Cookie', cookie).send({})
    expect(await authenticateIngest(prisma, `Bearer ${mint.body.secret}`)).not.toBeNull()

    // DELETE now also forgets the token's machines and reports how many (0 here — nothing ingested).
    const del = await request(app).delete(`/api/v1/tokens/${mint.body.id}`).set('Cookie', cookie)
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ forgotten: 0 })
    expect(await authenticateIngest(prisma, `Bearer ${mint.body.secret}`)).toBeNull()

    const list = await request(app).get('/api/v1/tokens').set('Cookie', cookie)
    expect(list.body.tokens[0].status).toBe('revoked')
  })

  it('renames a token in place (label only; secret unchanged), empty clears it', async () => {
    const { cookie } = await newAccount()
    const mint = await request(app).post('/api/v1/tokens').set('Cookie', cookie).send({ label: 'old' })

    const rename = await request(app)
      .patch(`/api/v1/tokens/${mint.body.id}`)
      .set('Cookie', cookie)
      .send({ label: 'laptop-2024' })
    expect(rename.status).toBe(204)
    let list = await request(app).get('/api/v1/tokens').set('Cookie', cookie)
    expect(list.body.tokens[0]).toMatchObject({ label: 'laptop-2024', status: 'active' })

    // The token still authenticates ingest — only the label changed.
    expect(await authenticateIngest(prisma, `Bearer ${mint.body.secret}`)).not.toBeNull()

    // An empty/whitespace label clears it to null.
    const clear = await request(app).patch(`/api/v1/tokens/${mint.body.id}`).set('Cookie', cookie).send({ label: '  ' })
    expect(clear.status).toBe(204)
    list = await request(app).get('/api/v1/tokens').set('Cookie', cookie)
    expect(list.body.tokens[0].label).toBeNull()

    // Over-long labels are rejected at the boundary.
    const tooLong = await request(app)
      .patch(`/api/v1/tokens/${mint.body.id}`)
      .set('Cookie', cookie)
      .send({ label: 'x'.repeat(101) })
    expect(tooLong.status).toBe(400)
  })

  it('prevents cross-tenant rename (IDOR → 404)', async () => {
    const a = await newAccount()
    const b = await newAccount()
    const mint = await request(app).post('/api/v1/tokens').set('Cookie', a.cookie).send({ label: 'a-token' })

    const attempt = await request(app)
      .patch(`/api/v1/tokens/${mint.body.id}`)
      .set('Cookie', b.cookie)
      .send({ label: 'hijack' })
    expect(attempt.status).toBe(404)

    // A's label is unchanged.
    const list = await request(app).get('/api/v1/tokens').set('Cookie', a.cookie)
    expect(list.body.tokens[0].label).toBe('a-token')
  })

  it('bulk-revokes all of an account tokens → count returned, ingest auth fails, IDOR-safe', async () => {
    const a = await newAccount()
    const b = await newAccount()
    const secrets: string[] = []
    for (let i = 0; i < 3; i++) {
      const m = await request(app)
        .post('/api/v1/tokens')
        .set('Cookie', a.cookie)
        .send({ label: `t${i}` })
      secrets.push(m.body.secret)
    }
    // B has its own token that must survive A's bulk revoke.
    const bMint = await request(app).post('/api/v1/tokens').set('Cookie', b.cookie).send({})

    const del = await request(app).delete('/api/v1/tokens').set('Cookie', a.cookie)
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ revoked: 3 })

    // All of A's tokens now fail ingest auth; all listed as revoked.
    for (const s of secrets) expect(await authenticateIngest(prisma, `Bearer ${s}`)).toBeNull()
    const list = await request(app).get('/api/v1/tokens').set('Cookie', a.cookie)
    expect(list.body.tokens.every((t: { status: string }) => t.status === 'revoked')).toBe(true)

    // Idempotent: a second bulk revoke reports 0.
    const again = await request(app).delete('/api/v1/tokens').set('Cookie', a.cookie)
    expect(again.body).toEqual({ revoked: 0 })

    // B's token is untouched.
    expect(await authenticateIngest(prisma, `Bearer ${bMint.body.secret}`)).not.toBeNull()
  })

  it('bulk revoke requires an owner session (401 without one)', async () => {
    expect((await request(app).delete('/api/v1/tokens')).status).toBe(401)
  })

  it('rejects ingest auth for an expired token (server-side expiry)', async () => {
    const { id: accountId } = await newAccount()
    // Insert a token whose expiresAt is already in the past.
    const { generateToken } = await import('../src/tokens/secret')
    const t = generateToken()
    await prisma.token.create({
      data: {
        accountId,
        lookupPrefix: t.lookupPrefix,
        secretHash: t.secretHash,
        expiresAt: new Date(Date.now() - 60_000),
      },
    })
    expect(await authenticateIngest(prisma, `Bearer ${t.secret}`)).toBeNull()
  })

  it('enforces the ≤10-active cap (11th → 409)', async () => {
    const { cookie } = await newAccount()
    for (let i = 0; i < MAX_ACTIVE_TOKENS; i++) {
      expect((await request(app).post('/api/v1/tokens').set('Cookie', cookie).send({})).status).toBe(201)
    }
    const over = await request(app).post('/api/v1/tokens').set('Cookie', cookie).send({})
    expect(over.status).toBe(409)
    expect(over.body.error.code).toBe('token_limit_reached')
  })

  it('enforces the cap atomically under concurrency (exactly 10 of 15 succeed)', async () => {
    const { cookie } = await newAccount()
    const results = await Promise.all(
      Array.from({ length: 15 }, () => request(app).post('/api/v1/tokens').set('Cookie', cookie).send({})),
    )
    const created = results.filter((r) => r.status === 201).length
    const rejected = results.filter((r) => r.status === 409).length
    expect(created).toBe(MAX_ACTIVE_TOKENS)
    expect(rejected).toBe(15 - MAX_ACTIVE_TOKENS)
  })

  it('prevents cross-tenant revoke (IDOR → 404)', async () => {
    const a = await newAccount()
    const b = await newAccount()
    const mint = await request(app).post('/api/v1/tokens').set('Cookie', a.cookie).send({})

    // Account B tries to revoke Account A's token.
    const attempt = await request(app).delete(`/api/v1/tokens/${mint.body.id}`).set('Cookie', b.cookie)
    expect(attempt.status).toBe(404)

    // A's token is still valid.
    expect(await authenticateIngest(prisma, `Bearer ${mint.body.secret}`)).not.toBeNull()
  })
})
