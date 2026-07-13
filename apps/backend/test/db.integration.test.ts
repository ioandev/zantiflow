// Integration test against a REAL MariaDB (testcontainers), per ADR-0014: unit tests mock, but
// the DB is exercised for real. Spins up mariadb:11.4, applies the actual migration the compose
// entrypoint runs (`prisma migrate deploy`), then asserts connectivity + an accountId-scoped
// round-trip (the tenant-isolation invariant).
//
// Runtime: works with Docker or rootless Podman (DOCKER_HOST → its socket). We stop containers
// explicitly in afterAll, so Ryuk is disabled by default (rootless Podman can't run it) — a CI
// with real Docker can re-enable it via TESTCONTAINERS_RYUK_DISABLED=false. When no container
// runtime is reachable at all, the suite SKIPS (with a warning) instead of hard-failing.
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MariaDbContainer, type StartedMariaDbContainer } from '@testcontainers/mariadb'
import { PrismaClient } from '@prisma/client'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import { containerRuntimeUp, socketPath } from './helpers/runtime'

const runtimeUp = await containerRuntimeUp()
if (!runtimeUp) {
  console.warn(`[db.integration] no container runtime at ${socketPath} — skipping DB integration tests`)
}
const suite = runtimeUp ? describe : describe.skip

suite('db integration (testcontainers MariaDB)', () => {
  let container: StartedMariaDbContainer
  let prisma: PrismaClient

  beforeAll(async () => {
    container = await new MariaDbContainer('mariadb:11.4')
      .withDatabase('zantiflow')
      .withUsername('zantiflow')
      .withUserPassword('zantiflow')
      .start()

    // Prisma needs a `mysql://` URL — build it explicitly rather than relying on the URI scheme.
    const url = `mysql://zantiflow:zantiflow@${container.getHost()}:${container.getPort()}/zantiflow`

    // Apply the committed migration exactly as production does. cwd is the backend package root
    // (the test always runs via its own `test` script), where prisma/schema.prisma lives.
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    })

    prisma = new PrismaClient({ adapter: new PrismaMariaDb(url) })
    await prisma.$connect()
  }, 240_000)

  afterAll(async () => {
    await prisma?.$disconnect()
    await container?.stop()
  })

  it('connects and answers a trivial query', async () => {
    const rows = await prisma.$queryRaw`SELECT 1 AS one`
    expect(Array.isArray(rows)).toBe(true)
    expect(rows).toHaveLength(1)
  })

  it('created every table from the migration (spot-check core models)', async () => {
    // Each create proves its table exists with the expected columns + defaults.
    const acc = await prisma.account.create({
      data: { oauthProvider: 'google', oauthId: 'sub-1', name: 'Ann' },
    })
    expect(acc.tier).toBe('free')
    expect(acc.sessionEpoch).toBe(0)

    const machine = await prisma.machine.create({ data: { id: 'm-1', accountId: acc.id } })
    expect(machine.accountId).toBe(acc.id)
  })

  it('scopes queries by accountId (tenant isolation)', async () => {
    const a = await prisma.account.create({ data: { oauthProvider: 'google', oauthId: 'sub-a', name: 'A' } })
    const b = await prisma.account.create({ data: { oauthProvider: 'google', oauthId: 'sub-b', name: 'B' } })

    await prisma.token.create({ data: { accountId: a.id, lookupPrefix: 'ztf_a', secretHash: 'ha' } })
    await prisma.token.create({ data: { accountId: b.id, lookupPrefix: 'ztf_b', secretHash: 'hb' } })

    const aTokens = await prisma.token.findMany({ where: { accountId: a.id } })
    expect(aTokens).toHaveLength(1)
    expect(aTokens[0].lookupPrefix).toBe('ztf_a')
    // Account A's scope must never surface Account B's rows.
    expect(aTokens.every((t) => t.accountId === a.id)).toBe(true)
  })

  it('enforces the unique ingest-token lookupPrefix', async () => {
    const acc = await prisma.account.create({ data: { oauthProvider: 'google', oauthId: 'sub-u', name: 'U' } })
    await prisma.token.create({ data: { accountId: acc.id, lookupPrefix: 'ztf_dupe', secretHash: 'h1' } })
    await expect(
      prisma.token.create({ data: { accountId: acc.id, lookupPrefix: 'ztf_dupe', secretHash: 'h2' } }),
    ).rejects.toThrow()
  })
})
