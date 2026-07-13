// Promo codes + tiers against a REAL MariaDB (testcontainers, ADR-0011): generate → current →
// redeem → PRO (capped), double-redeem guard, generic errors, and the expiry lapse. Time is injected
// so the 30-/60-day windows are deterministic.
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MariaDbContainer, type StartedMariaDbContainer } from '@testcontainers/mariadb'
import { PrismaClient } from '@prisma/client'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import { currentCode, ensureCurrentCode, generateAutoCode, redeem } from '../src/promo/service'
import { effectiveTier, lapseExpiredTiers } from '../src/tiers/service'
import { containerRuntimeUp, socketPath } from './helpers/runtime'

const runtimeUp = await containerRuntimeUp()
if (!runtimeUp) {
  console.warn(`[promo.integration] no container runtime at ${socketPath} — skipping`)
}
const suite = runtimeUp ? describe : describe.skip

const DAY = 86_400_000

suite('promo + tiers (testcontainers MariaDB)', () => {
  let container: StartedMariaDbContainer
  let prisma: PrismaClient
  let seq = 0
  const newAccount = () =>
    prisma.account.create({ data: { oauthProvider: 'google', oauthId: `a-${seq++}`, name: 'O' } })

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
  }, 240_000)

  afterAll(async () => {
    await prisma?.$disconnect()
    await container?.stop()
  })

  it('effectiveTier is pro only while tierExpiresAt is in the future', () => {
    const now = new Date()
    expect(effectiveTier({ tier: 'pro', tierExpiresAt: new Date(now.getTime() + 1000) }, now)).toBe('pro')
    expect(effectiveTier({ tier: 'pro', tierExpiresAt: new Date(now.getTime() - 1000) }, now)).toBe('free')
    expect(effectiveTier({ tier: 'free', tierExpiresAt: null }, now)).toBe('free')
  })

  it('generates a ZTF- code and surfaces it as the current homepage code', async () => {
    const now = new Date()
    await generateAutoCode(prisma, now)
    const cur = await currentCode(prisma, now)
    expect(cur?.code).toMatch(/^ZTF-[A-HJ-NP-Z2-9]{8}$/)
    expect(cur?.durationDays).toBe(30)
  })

  it('ensureCurrentCode creates one only when none exists', async () => {
    await prisma.promoRedemption.deleteMany({})
    await prisma.promoCode.deleteMany({})
    const now = new Date()
    await ensureCurrentCode(prisma, now)
    await ensureCurrentCode(prisma, now)
    expect(await prisma.promoCode.count()).toBe(1)
  })

  it('redeems a code → PRO for 30 days', async () => {
    const acc = await newAccount()
    const now = new Date('2026-07-11T00:00:00Z')
    const promo = await generateAutoCode(prisma, now)
    const expiry = await redeem(prisma, acc.id, promo.code, now)
    expect(expiry.getTime()).toBe(now.getTime() + 30 * DAY)
    const updated = await prisma.account.findUnique({ where: { id: acc.id } })
    expect(updated?.tier).toBe('pro')
    expect(effectiveTier(updated!, now)).toBe('pro')
  })

  it('extends an existing PRO window but caps it at 60 days', async () => {
    const acc = await newAccount()
    const now = new Date('2026-07-11T00:00:00Z')
    await prisma.account.update({
      where: { id: acc.id },
      data: { tier: 'pro', tierExpiresAt: new Date(now.getTime() + 50 * DAY) },
    })
    const promo = await generateAutoCode(prisma, now)
    const expiry = await redeem(prisma, acc.id, promo.code, now) // 50 + 30 = 80 → capped 60
    expect(expiry.getTime()).toBe(now.getTime() + 60 * DAY)
  })

  it('rejects a second redemption by the same account', async () => {
    const acc = await newAccount()
    const now = new Date()
    const promo = await generateAutoCode(prisma, now)
    await redeem(prisma, acc.id, promo.code, now)
    await expect(redeem(prisma, acc.id, promo.code, now)).rejects.toMatchObject({ code: 'already_redeemed' })
  })

  it('returns a generic error for unknown or expired codes (no enumeration)', async () => {
    const acc = await newAccount()
    const now = new Date()
    await expect(redeem(prisma, acc.id, 'ZTF-NOPENOPE', now)).rejects.toMatchObject({ code: 'invalid_code' })
    const expired = await prisma.promoCode.create({
      data: {
        code: 'ZTF-EXPIRED1',
        grantsTier: 'pro',
        durationDays: 30,
        perAccountLimit: 1,
        expiresAt: new Date(now.getTime() - 1000),
        createdBy: 'auto',
      },
    })
    await expect(redeem(prisma, acc.id, expired.code, now)).rejects.toMatchObject({ code: 'invalid_code' })
  })

  it('lapses expired PRO accounts back to free', async () => {
    const acc = await newAccount()
    const now = new Date()
    await prisma.account.update({
      where: { id: acc.id },
      data: { tier: 'pro', tierExpiresAt: new Date(now.getTime() - 1000) },
    })
    const lapsed = await lapseExpiredTiers(prisma, now)
    expect(lapsed).toBeGreaterThanOrEqual(1)
    expect((await prisma.account.findUnique({ where: { id: acc.id } }))?.tier).toBe('free')
  })
})
