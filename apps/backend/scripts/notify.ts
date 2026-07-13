// Dev-only "just notify": fire a notification for an account through the REAL `createForFired` path —
// the exact code that runs when an attention fires (ADR-0006/0009). Deliveries (web-push + Discord/
// Telegram) are created from the account's ACTUAL channels and effective tier, so the running backend's
// dispatch sweep then delivers them for real (e.g. a Telegram DM). No fake rows.
//
// Run:
//   pnpm --filter @zantiflow/backend exec tsx --env-file=.env scripts/notify.ts [type] [accountId] [machineId]
//   # or the shorthands:  pnpm --filter @zantiflow/backend notify claude.idle   |   just notify claude.idle
//
// Args (all optional):
//   type       attention type → notification text. Default `claude.idle` ("All Claude sessions are idle").
//              Others: `machine.offline`, `claude.needs-input`, `claude.thinking`, `session.stopped`.
//   accountId  target account. Default: an account that actually has a delivery channel (push sub or an
//              active chat link) so something is sent; otherwise the first account.
//   machineId  source machine id recorded on the notification. Default: one of the account's machines.
import { disconnectPrisma, getPrisma } from '../src/db'
import { createForFired, notificationText } from '../src/notifications/service'
import { effectiveTier } from '../src/tiers/service'

// `|| undefined` so empty positional args (e.g. from the Justfile defaults) fall back to the defaults.
const type = process.argv[2] || 'claude.idle'
const accountArg = process.argv[3] || undefined
const machineArg = process.argv[4] || undefined

const prisma = getPrisma()

/** Pick the target account: the CLI arg, else one with a real delivery channel, else any account. */
async function resolveAccountId(): Promise<string> {
  if (accountArg) return accountArg
  const sub = await prisma.pushSubscription.findFirst({ select: { accountId: true } })
  if (sub) return sub.accountId
  const link = await prisma.channelLink.findFirst({ where: { status: 'active' }, select: { accountId: true } })
  if (link) return link.accountId
  const any = await prisma.account.findFirst({ select: { id: true } })
  if (!any) throw new Error('no accounts in the database')
  return any.id
}

async function main() {
  const accountId = await resolveAccountId()
  const acc = await prisma.account.findUnique({
    where: { id: accountId },
    select: { tier: true, tierExpiresAt: true },
  })
  if (!acc) throw new Error(`account ${accountId} not found`)
  const tier = effectiveTier(acc)
  const machine = machineArg ? { id: machineArg } : await prisma.machine.findFirst({ where: { accountId } })
  const machineId = machine?.id ?? 'sim-machine'

  // `::` is the machine-level targetKey; for per-session types it's only recorded on the source, the
  // text (what the user sees) comes from `type`.
  const created = await createForFired(prisma, accountId, tier, [{ machineId, type, targetKey: '::' }])
  const notif = await prisma.notification.findFirst({ where: { accountId }, orderBy: { createdAt: 'desc' } })
  const deliveries = await prisma.notificationDelivery.findMany({
    where: { notificationId: notif?.id },
    select: { channel: true, status: true },
  })
  const summary = deliveries.map((d) => `${d.channel}:${d.status}`).join(', ')

  console.log(`account   ${accountId}  (tier: ${tier})`)
  console.log(`machine   ${machineId}`)
  console.log(`type      ${type}`)
  console.log(`text      ${JSON.stringify(notificationText(type))}`)
  console.log(
    `created   ${created} delivery row(s)${summary ? `: ${summary}` : ' — no channel configured for this account/tier'}`,
  )
  if (created > 0)
    console.log(
      `The backend's dispatch sweep delivers pending rows within ~10s (start it with \`pnpm dev\` if it isn't running).`,
    )
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => disconnectPrisma())
