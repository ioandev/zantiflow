// Machine-level `claude.idle` (ADR-0027) against a REAL MariaDB (testcontainers): the backend-derived
// evaluation over persisted per-session slices + activity maps, the self-timed firing through the
// episode engine (threshold 0 + 300s cooldown + clear-on-resume), that the machine-level clear never
// clobbers a live per-session attention (and vice versa), the freshness filter dropping a closed session,
// and the end-to-end sweep → Attention row + Notification. Time is injected for determinism.
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MariaDbContainer, type StartedMariaDbContainer } from '@testcontainers/mariadb'
import { Prisma, PrismaClient } from '@prisma/client'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import type { Attention } from '@zantiflow/protocol'
import { evaluateMachineIdle, sweepMachineAttentions } from '../src/attentions/idle'
import { processAttentions } from '../src/attentions/service'
import type { SseBus, SseListener } from '../src/sse/bus'
import { containerRuntimeUp, socketPath } from './helpers/runtime'

const runtimeUp = await containerRuntimeUp()
if (!runtimeUp) {
  console.warn(`[idle.integration] no container runtime at ${socketPath} — skipping`)
}
const suite = runtimeUp ? describe : describe.skip

const json = (x: unknown): Prisma.InputJsonValue => x as unknown as Prisma.InputJsonValue
const idleAttn = (machineId: string, state: 'active' | 'cleared' = 'active'): Attention => ({
  type: 'claude.idle',
  target: { machineId },
  state,
  since: 0,
})
// A bus that just records the event names it was asked to publish.
const recordingBus = (): { bus: SseBus; events: string[] } => {
  const events: string[] = []
  const bus: SseBus = {
    publish: (_acc, ev) => events.push(ev.event),
    subscribe: (_acc: string, _l: SseListener) => () => {},
    countFor: () => 0,
  }
  return { bus, events }
}

suite('claude.idle (testcontainers MariaDB)', () => {
  let container: StartedMariaDbContainer
  let prisma: PrismaClient
  let seq = 0

  const setup = async (tier = 'pro') => {
    const acc = await prisma.account.create({
      data: {
        oauthProvider: 'google',
        oauthId: `a-${seq++}`,
        name: 'O',
        tier,
        tierExpiresAt: tier === 'pro' ? new Date(Date.now() + 3_600_000) : null,
      },
    })
    const m = await prisma.machine.create({ data: { id: `m-${seq++}`, accountId: acc.id } })
    return { accountId: acc.id, machineId: m.id }
  }

  // Seed one live session's slice + its per-pane activity map. `updatedAt` is the pane's last-observed
  // fingerprint change (the silence clock); `receivedAt` backdates the slice to simulate a closed session.
  const seedSlice = async (
    accountId: string,
    machineId: string,
    opts: { sid?: string; command?: string | null; exited?: boolean; updatedAt: string | null; receivedAt?: Date },
  ) => {
    const sid = opts.sid ?? 's1'
    const data = {
      version: 4,
      machineId,
      capturedAtTick: 1,
      sessions: [
        {
          sid,
          name: 'main',
          isCurrent: true,
          state: 'live',
          diedSecondsAgo: null,
          tabs: [
            {
              tabId: 0,
              name: 't',
              position: 0,
              active: true,
              panes: [
                {
                  id: 1,
                  name: null,
                  command: opts.command === undefined ? 'claude' : opts.command,
                  isFocused: true,
                  exited: opts.exited ?? false,
                  contentFingerprint: 'fp',
                },
              ],
            },
          ],
        },
      ],
    }
    await prisma.snapshot.create({
      data: {
        machineId,
        sid,
        accountId,
        version: 4,
        capturedAtTick: 1,
        data: json(data),
        ...(opts.receivedAt ? { receivedAt: opts.receivedAt } : {}),
      },
    })
    await prisma.paneActivity.create({
      data: { machineId, sid, accountId, activity: json({ [`${sid}:0:1`]: { fp: 'fp', updatedAt: opts.updatedAt } }) },
    })
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

  // `sweepMachineAttentions` scans ALL machines in the lookback window, so isolate each test's state.
  beforeEach(async () => {
    await prisma.attention.deleteMany({})
    await prisma.notificationDelivery.deleteMany({})
    await prisma.notification.deleteMany({})
    await prisma.snapshot.deleteMany({})
    await prisma.paneActivity.deleteMany({})
    await prisma.machine.deleteMany({})
  })

  it('evaluates active only once every claude pane is idle past the tier threshold', async () => {
    const { accountId, machineId } = await setup()
    const now = new Date()
    await seedSlice(accountId, machineId, { updatedAt: new Date(now.getTime() - 61_000).toISOString() })
    expect((await evaluateMachineIdle(prisma, accountId, machineId, 'pro', now)).state).toBe('active')
    // Free needs 5 min → 61s of silence is still "fresh".
    expect((await evaluateMachineIdle(prisma, accountId, machineId, 'free', now)).state).toBe('cleared')
  })

  it('stays cleared while a claude pane is still producing output', async () => {
    const { accountId, machineId } = await setup()
    const now = new Date()
    await seedSlice(accountId, machineId, { updatedAt: new Date(now.getTime() - 5_000).toISOString() })
    expect((await evaluateMachineIdle(prisma, accountId, machineId, 'pro', now)).state).toBe('cleared')
  })

  it('stays cleared when the machine runs no claude pane', async () => {
    const { accountId, machineId } = await setup()
    const now = new Date()
    await seedSlice(accountId, machineId, {
      command: 'nvim',
      updatedAt: new Date(now.getTime() - 600_000).toISOString(),
    })
    expect((await evaluateMachineIdle(prisma, accountId, machineId, 'pro', now)).state).toBe('cleared')
  })

  it('drops a closed session (stale slice) so it cannot false-fire', async () => {
    const { accountId, machineId } = await setup()
    const now = new Date()
    // The claude pane is long-idle, BUT its slice is 2 min stale → excluded from the live view.
    await seedSlice(accountId, machineId, {
      updatedAt: new Date(now.getTime() - 600_000).toISOString(),
      receivedAt: new Date(now.getTime() - 120_000),
    })
    expect((await evaluateMachineIdle(prisma, accountId, machineId, 'pro', now)).state).toBe('cleared')
  })

  it('fires immediately (self-timed, threshold 0) then respects the 300s cooldown', async () => {
    const { accountId, machineId } = await setup()
    const t0 = new Date('2026-07-12T00:00:00Z')
    const scope = new Set([''])
    let r = await processAttentions(prisma, accountId, machineId, [idleAttn(machineId)], 'pro', t0, scope)
    expect(r.fired).toHaveLength(1)
    expect(r.fired[0]).toMatchObject({ type: 'claude.idle', targetKey: '::' })
    // Still idle 2 min later, within the 300s cooldown → no re-fire.
    r = await processAttentions(
      prisma,
      accountId,
      machineId,
      [idleAttn(machineId)],
      'pro',
      new Date(t0.getTime() + 120_000),
      scope,
    )
    expect(r.fired).toHaveLength(0)
    // Past the cooldown → re-fires.
    r = await processAttentions(
      prisma,
      accountId,
      machineId,
      [idleAttn(machineId)],
      'pro',
      new Date(t0.getTime() + 301_000),
      scope,
    )
    expect(r.fired).toHaveLength(1)
  })

  it('clears the machine attention when output resumes', async () => {
    const { accountId, machineId } = await setup()
    const t0 = new Date('2026-07-12T00:00:00Z')
    const scope = new Set([''])
    await processAttentions(prisma, accountId, machineId, [idleAttn(machineId)], 'pro', t0, scope)
    expect(await prisma.attention.count({ where: { machineId, type: 'claude.idle' } })).toBe(1)
    await processAttentions(prisma, accountId, machineId, [idleAttn(machineId, 'cleared')], 'pro', t0, scope)
    expect(await prisma.attention.count({ where: { machineId, type: 'claude.idle' } })).toBe(0)
  })

  it('partitions the clear: machine-level and per-session attentions never clobber each other', async () => {
    const { accountId, machineId } = await setup()
    const t0 = new Date('2026-07-12T00:00:00Z')
    const needs: Attention = {
      type: 'claude.needs-input',
      target: { sessionSid: 's1', tabId: 0, paneId: 1 },
      state: 'active',
      since: 0,
    }
    await processAttentions(prisma, accountId, machineId, [needs], 'pro', t0, new Set(['s1']))
    await processAttentions(prisma, accountId, machineId, [idleAttn(machineId)], 'pro', t0, new Set(['']))
    // The idle sweep (scope {''}) reports only claude.idle → the live needs-input survives.
    await processAttentions(prisma, accountId, machineId, [idleAttn(machineId)], 'pro', t0, new Set(['']))
    expect(await prisma.attention.count({ where: { machineId, type: 'claude.needs-input', state: 'active' } })).toBe(1)
    // An ordinary ingest (scope {'s1'}) reports only needs-input → the machine idle survives.
    await processAttentions(prisma, accountId, machineId, [needs], 'pro', t0, new Set(['s1']))
    expect(await prisma.attention.count({ where: { machineId, type: 'claude.idle', state: 'active' } })).toBe(1)
  })

  it('sweep fires claude.idle for an online machine, publishes, and enqueues the notification', async () => {
    const { accountId, machineId } = await setup('pro')
    const now = new Date()
    await seedSlice(accountId, machineId, { updatedAt: new Date(now.getTime() - 61_000).toISOString() })
    const { bus, events } = recordingBus()
    await sweepMachineAttentions(prisma, bus, now)

    const row = await prisma.attention.findFirst({ where: { machineId, type: 'claude.idle' } })
    expect(row?.state).toBe('active')
    expect(row?.lastFiredAt).not.toBeNull()
    const notif = await prisma.notification.findFirst({ where: { accountId } })
    expect(notif?.text).toBe('All Claude sessions are idle')
    expect(events).toContain('attention.update')
    // The online machine is NOT offline → no machine.offline row.
    expect(await prisma.attention.count({ where: { machineId, type: 'machine.offline' } })).toBe(0)
  })

  it('sweep does not fire claude.idle for a free machine below its 5-min threshold', async () => {
    const { accountId, machineId } = await setup('free')
    const now = new Date()
    await seedSlice(accountId, machineId, { updatedAt: new Date(now.getTime() - 61_000).toISOString() })
    await sweepMachineAttentions(prisma, recordingBus().bus, now)
    expect(await prisma.attention.count({ where: { machineId, type: 'claude.idle' } })).toBe(0)
  })

  // --- machine.offline (ADR-0028): the whole machine stopped reporting ---
  const setLastSeen = (machineId: string, at: Date) =>
    prisma.machine.update({ where: { id: machineId }, data: { lastSeenAt: at } })

  it('fires machine.offline once when a machine stops reporting, then respects the cooldown', async () => {
    const { accountId, machineId } = await setup('pro')
    const now = new Date()
    await setLastSeen(machineId, new Date(now.getTime() - 120_000)) // 2 min silent → offline, within lookback
    const { bus, events } = recordingBus()
    await sweepMachineAttentions(prisma, bus, now)

    const row = await prisma.attention.findFirst({ where: { machineId, type: 'machine.offline' } })
    expect(row?.state).toBe('active')
    expect(row?.lastFiredAt).not.toBeNull()
    expect((await prisma.notification.findFirst({ where: { accountId } }))?.text).toBe('A machine went offline')
    expect(events).toContain('attention.update')
    // A second sweep while still offline must NOT re-fire (long cooldown → one per disconnect).
    const before = await prisma.notification.count({ where: { accountId } })
    await sweepMachineAttentions(prisma, recordingBus().bus, now)
    expect(await prisma.notification.count({ where: { accountId } })).toBe(before)
  })

  it('clears machine.offline when the machine comes back online', async () => {
    const { machineId } = await setup('pro')
    const t0 = new Date()
    await setLastSeen(machineId, new Date(t0.getTime() - 120_000))
    await sweepMachineAttentions(prisma, recordingBus().bus, t0)
    expect(await prisma.attention.count({ where: { machineId, type: 'machine.offline', state: 'active' } })).toBe(1)
    // The plugin reports again → lastSeenAt fresh → offline clears.
    const t1 = new Date()
    await setLastSeen(machineId, t1)
    await sweepMachineAttentions(prisma, recordingBus().bus, t1)
    expect(await prisma.attention.count({ where: { machineId, type: 'machine.offline' } })).toBe(0)
  })

  it('does not raise machine.offline for an online machine, nor one dead beyond the lookback', async () => {
    const now = new Date()
    const online = await setup('pro') // lastSeenAt defaults to ~now → online
    const dead = await setup('pro')
    await setLastSeen(dead.machineId, new Date(now.getTime() - 20 * 60_000)) // 20 min → outside 15-min lookback
    await sweepMachineAttentions(prisma, recordingBus().bus, now)
    expect(await prisma.attention.count({ where: { machineId: online.machineId, type: 'machine.offline' } })).toBe(0)
    expect(await prisma.attention.count({ where: { machineId: dead.machineId, type: 'machine.offline' } })).toBe(0)
  })
})
