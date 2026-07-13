// Process entrypoint: load+validate config (fail-fast), build the app, listen, and shut down
// cleanly on SIGTERM/SIGINT. The compose entrypoint runs `prisma migrate deploy` before this.
import { sweepMachineAttentions } from './attentions/idle'
import { buildGoogleProvider } from './auth/google'
import { attachBotWs } from './bots/ws'
import { pruneLinkTokens } from './bots/linkToken'
import { getConfig } from './config'
import { checkDbReady, disconnectPrisma, getPrisma } from './db'
import { createWebPushSender } from './delivery/webpush'
import { dispatchBotDeliveries, dispatchPending } from './delivery/dispatcher'
import { createApp } from './http/app'
import { createLogger } from './log'
import { pruneNotifications } from './notifications/service'
import { createPaneOutputStore } from './output/store'
import { ensureCurrentCode, generateAutoCode } from './promo/service'
import { createBus } from './sse/bus'
import { lapseExpiredTiers } from './tiers/service'
import { getVersion } from './version'

const SWEEP_MS = 10_000
const PRUNE_MS = 5 * 60_000
const PROMO_GEN_MS = 14 * 24 * 60 * 60_000 // ~2 weeks (ADR-0011/0020)
// Evaluate the machine-level `claude.idle` attention (ADR-0027) on a timer, NOT at ingest: an idle,
// unwatched machine stops sending under ADR-0026, so only a backend sweep observes the idle window.
const MACHINE_SWEEP_MS = 20_000

const main = (): void => {
  const config = getConfig()
  const logger = createLogger({ level: config.logLevel })
  const version = getVersion()
  logger.info('backend_starting', {
    version: version.version,
    commit: version.commit,
    node: version.node,
    env: config.nodeEnv,
  })
  const prisma = getPrisma()
  const google = buildGoogleProvider(config)
  if (!google) logger.warn('google_oauth_unconfigured', { hint: 'set GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI' })
  // With neither Google nor a self-host secret, the backend boots but has NO owner sign-in path
  // (the ingest plane is independent — a machine can push, but nobody can view). Be loud (ADR-0035).
  if (!google && !config.selfHostSecret)
    logger.warn('owner_auth_unconfigured', { hint: 'no owner sign-in configured — set GOOGLE_* or SELF_HOST_SECRET' })
  if (!config.vapid.publicKey) logger.warn('web_push_unconfigured', { hint: 'set VAPID_PUBLIC_KEY/PRIVATE_KEY' })

  // Share one SSE bus between the HTTP app (ingest publish / stream subscribe) and the idle sweep, so a
  // swept `claude.idle` change reaches live dashboards the same way an ingest-driven one does.
  const bus = createBus()

  // Pane output is relayed through memory only (ADR-0032) — this store holds it, never the DB. Owned
  // here so the sweep below can prune it on the same cadence the app serves reads from it.
  const outputStore = createPaneOutputStore()

  // /readyz stays 503 until the DB is reachable (migrations are applied by the entrypoint first).
  const app = createApp({
    config,
    logger,
    prisma,
    bus,
    outputStore,
    authProviders: google ? [google] : [],
    readiness: () => checkDbReady(prisma),
  })

  const server = app.listen(config.port, () => {
    logger.info('backend_listening', { port: config.port, env: config.nodeEnv })
  })

  // Bot channels (ADR-0007): the WS hub lives on the same server at /internal/bots.
  const hub = attachBotWs(server, prisma, config, logger)
  if (!config.botServiceSecret) logger.warn('bots_unconfigured', { hint: 'set BOT_SERVICE_SECRET to enable chat bots' })

  // Durable notification delivery (ADR-0009): the sweep drains pending web-push + chat deliveries
  // (replaying any that survived a restart); a slower prune enforces retention.
  const sender = createWebPushSender(config.vapid)
  const sweep = setInterval(() => {
    void dispatchPending(prisma, sender).catch((e) => logger.error('dispatch_failed', { err: String(e) }))
    void dispatchBotDeliveries(prisma, hub).catch((e) => logger.error('bot_dispatch_failed', { err: String(e) }))
    // Pane output is ephemeral and memory-only (ADR-0030/0032): drop captures past the short
    // retention window promptly so scrubbed content doesn't linger in memory between views.
    try {
      outputStore.prune()
    } catch (e) {
      logger.error('output_prune_failed', { err: String(e) })
    }
  }, SWEEP_MS)
  const prune = setInterval(() => {
    void pruneNotifications(prisma, config.notificationRetentionHours).catch((e) =>
      logger.error('prune_failed', { err: String(e) }),
    )
    // Drop link tokens that can no longer be redeemed (used or expired) so remints can't accrete.
    void pruneLinkTokens(prisma).catch((e) => logger.error('link_token_prune_failed', { err: String(e) }))
    // Lapse any expired PRO tiers back to free (ADR-0011 §1).
    void lapseExpiredTiers(prisma).catch((e) => logger.error('lapse_failed', { err: String(e) }))
  }, PRUNE_MS)

  // Promo codes: ensure one now, then mint a fresh homepage code every ~2 weeks (no admin, ADR-0020).
  void ensureCurrentCode(prisma).catch((e) => logger.error('promo_ensure_failed', { err: String(e) }))
  const promo = setInterval(() => {
    void generateAutoCode(prisma).catch((e) => logger.error('promo_gen_failed', { err: String(e) }))
  }, PROMO_GEN_MS)

  // Machine-level backend-derived attentions (ADR-0027/0028): `claude.idle` (all Claude panes quiet past
  // the tier threshold) and `machine.offline` (the machine stopped reporting). Both need a timer, not
  // ingest — an idle/offline machine sends nothing.
  const machineSweep = setInterval(() => {
    void sweepMachineAttentions(prisma, bus).catch((e) => logger.error('machine_sweep_failed', { err: String(e) }))
  }, MACHINE_SWEEP_MS)

  sweep.unref()
  prune.unref()
  promo.unref()
  machineSweep.unref()

  const shutdown = (signal: string): void => {
    logger.info('shutting_down', { signal })
    clearInterval(sweep)
    clearInterval(prune)
    clearInterval(promo)
    clearInterval(machineSweep)
    server.close(() => {
      void disconnectPrisma().finally(() => process.exit(0))
    })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

if (require.main === module) main()
