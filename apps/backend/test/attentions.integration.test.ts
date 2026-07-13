// Backend attention engine against a REAL MariaDB (testcontainers, ADR-0005 §5): episodes, tier-gated
// firing (server-side — a client can't unlock pro cadence), cooldown, and clearing. Time is injected
// so the 5-min / 1-min thresholds are exercised deterministically.
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MariaDbContainer, type StartedMariaDbContainer } from '@testcontainers/mariadb'
import { PrismaClient } from '@prisma/client'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import type { Attention } from '@zantiflow/protocol'
import { processAttentions } from '../src/attentions/service'
import { containerRuntimeUp, socketPath } from './helpers/runtime'

const runtimeUp = await containerRuntimeUp()
if (!runtimeUp) {
  console.warn(`[attentions.integration] no container runtime at ${socketPath} — skipping`)
}
const suite = runtimeUp ? describe : describe.skip

const wire = (over: Partial<Attention> = {}): Attention => ({
  type: 'claude.needs-input',
  target: { sessionSid: 's1', tabId: 0, paneId: 1 },
  state: 'active',
  since: 0,
  ...over,
})

suite('attentions engine (testcontainers MariaDB)', () => {
  let container: StartedMariaDbContainer
  let prisma: PrismaClient
  let seq = 0

  const setup = async (tier: string) => {
    const acc = await prisma.account.create({
      data: { oauthProvider: 'google', oauthId: `a-${seq++}`, name: 'O', tier },
    })
    const m = await prisma.machine.create({ data: { id: `m-${seq++}`, accountId: acc.id } })
    return { accountId: acc.id, machineId: m.id }
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
  }, 240_000)

  afterAll(async () => {
    await prisma?.$disconnect()
    await container?.stop()
  })

  it('starts an episode and fires only after the free (5-min) threshold', async () => {
    const { accountId, machineId } = await setup('free')
    const t0 = new Date('2026-07-11T00:00:00Z')

    let r = await processAttentions(prisma, accountId, machineId, [wire()], 'free', t0)
    expect(r.changed).toBe(true)
    expect(r.fired).toHaveLength(0)
    const row = await prisma.attention.findFirst({ where: { machineId } })
    expect(row?.state).toBe('active')
    expect(row?.lastFiredAt).toBeNull()

    r = await processAttentions(prisma, accountId, machineId, [wire()], 'free', new Date(t0.getTime() + 240_000))
    expect(r.fired).toHaveLength(0) // 4 min < 5 min

    r = await processAttentions(prisma, accountId, machineId, [wire()], 'free', new Date(t0.getTime() + 300_000))
    expect(r.fired).toHaveLength(1) // 5 min → fires
    expect((await prisma.attention.findFirst({ where: { machineId } }))?.lastFiredAt).not.toBeNull()
  })

  it('pro tier fires at 1 min — enforced server-side by the account tier, not the request', async () => {
    const { accountId, machineId } = await setup('pro')
    const t0 = new Date('2026-07-11T00:00:00Z')
    await processAttentions(prisma, accountId, machineId, [wire()], 'pro', t0)
    // A free-tier request for the same account still uses free timing (caller passes account.tier).
    const early = await processAttentions(
      prisma,
      accountId,
      machineId,
      [wire()],
      'free',
      new Date(t0.getTime() + 61_000),
    )
    expect(early.fired).toHaveLength(0)
    const pro = await processAttentions(prisma, accountId, machineId, [wire()], 'pro', new Date(t0.getTime() + 61_000))
    expect(pro.fired).toHaveLength(1)
  })

  it('respects the cooldown (no re-fire within 5 min of the last fire)', async () => {
    const { accountId, machineId } = await setup('pro')
    const t0 = new Date('2026-07-11T00:00:00Z')
    await processAttentions(prisma, accountId, machineId, [wire()], 'pro', t0)
    await processAttentions(prisma, accountId, machineId, [wire()], 'pro', new Date(t0.getTime() + 61_000)) // fires
    const again = await processAttentions(
      prisma,
      accountId,
      machineId,
      [wire()],
      'pro',
      new Date(t0.getTime() + 120_000),
    )
    expect(again.fired).toHaveLength(0) // still in cooldown
  })

  it('clears an attention on explicit `cleared` and on omission', async () => {
    const { accountId, machineId } = await setup('free')
    const t0 = new Date('2026-07-11T00:00:00Z')

    await processAttentions(prisma, accountId, machineId, [wire()], 'free', t0)
    expect(await prisma.attention.count({ where: { machineId } })).toBe(1)

    await processAttentions(prisma, accountId, machineId, [wire({ state: 'cleared' })], 'free', t0)
    expect(await prisma.attention.count({ where: { machineId } })).toBe(0)

    await processAttentions(prisma, accountId, machineId, [wire()], 'free', t0)
    const omitted = await processAttentions(prisma, accountId, machineId, [], 'free', t0)
    expect(omitted.changed).toBe(true)
    expect(await prisma.attention.count({ where: { machineId } })).toBe(0)
  })

  it('scopes the end-of-tick clear to the reported sessions (per-session instances)', async () => {
    const { accountId, machineId } = await setup('free')
    const t0 = new Date('2026-07-11T00:00:00Z')
    const at = (sid: string): Attention => wire({ target: { sessionSid: sid, tabId: 0, paneId: 1 } })
    // Two Zellij sessions on one machine, each reported by its OWN plugin instance (scoped sids).
    await processAttentions(prisma, accountId, machineId, [at('s1')], 'free', t0, new Set(['s1']))
    await processAttentions(prisma, accountId, machineId, [at('s2')], 'free', t0, new Set(['s2']))
    expect(await prisma.attention.count({ where: { machineId, state: 'active' } })).toBe(2)

    // s1's instance reports no attention this tick → ONLY s1's clears; s2's (another instance) survives.
    await processAttentions(prisma, accountId, machineId, [], 'free', t0, new Set(['s1']))
    const active = await prisma.attention.findMany({ where: { machineId, state: 'active' } })
    expect(active.map((r) => r.targetKey)).toEqual(['s2:0:1'])
  })

  it('scopes attentions to the owning account', async () => {
    const a = await setup('free')
    const b = await setup('free')
    await processAttentions(prisma, a.accountId, a.machineId, [wire()], 'free', new Date())
    expect(await prisma.attention.count({ where: { accountId: a.accountId } })).toBe(1)
    expect(await prisma.attention.count({ where: { accountId: b.accountId } })).toBe(0)
  })
})
