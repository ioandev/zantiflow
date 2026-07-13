// Environment configuration — parsed + validated once, fail-fast (ADR-0018 §4). Secrets come
// from env only; nothing is hardcoded. `parseConfig` is pure (takes an env bag) so tests can
// build a Config without touching process.env; `getConfig` is the lazy process-wide singleton.
import { z } from 'zod'

const RawEnv = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    // Prisma connection URL (MariaDB/MySQL). Required to boot the real server.
    DATABASE_URL: z.string().min(1),
    // HMAC key for `ztf_session` cookies + OAuth `state`. ≥256-bit (ADR-0004 §4).
    TOKEN_SECRET: z.string().min(32, 'must be at least 32 chars (256-bit)'),
    // Owner-session cookie lifetime (ADR-0004 §2; shortened per security-audit).
    SESSION_TTL_DAYS: z.coerce.number().int().positive().default(14),
    // The web origin allowed to call the API with credentials (CORS; ADR-0018 §8).
    WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
    // Express `trust proxy` setting — derive client IP from X-Forwarded-For only for these hops.
    TRUST_PROXY: z.string().default('loopback'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    // Google OAuth app (ADR-0004) — optional until auth is wired / configured by the deployer.
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_REDIRECT_URI: z.string().url().optional(),
    // Self-host owner sign-in secret (ADR-0035) — OPTIONAL, self-host only. When set, the owner can
    // sign in with this single long secret instead of Google. Empty string is treated as unset so a
    // blank `.env` line doesn't brick boot; when present it must be ≥32 chars (like TOKEN_SECRET).
    SELF_HOST_SECRET: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(32, 'must be at least 32 chars (256-bit); generate with `openssl rand -base64 48`').optional(),
    ),
    // Web Push VAPID keypair (ADR-0006) — optional until push is configured by the deployer.
    VAPID_PUBLIC_KEY: z.string().optional(),
    VAPID_PRIVATE_KEY: z.string().optional(),
    VAPID_SUBJECT: z.string().default('mailto:admin@zantiflow.local'),
    // Notification-delivery retention window (ADR-0009 §cron), hours.
    NOTIFICATION_RETENTION_HOURS: z.coerce.number().int().positive().default(6),
    // Shared secret each notification bot presents on the internal WS (ADR-0007 §6).
    BOT_SERVICE_SECRET: z.string().optional(),
  })
  .superRefine((e, ctx) => {
    // Reusing TOKEN_SECRET as the login secret would let a leak of the login secret forge session
    // cookies directly (TOKEN_SECRET is the HMAC key). Keep them distinct (ADR-0035 §security).
    if (e.SELF_HOST_SECRET && e.SELF_HOST_SECRET === e.TOKEN_SECRET)
      ctx.addIssue({
        code: 'custom',
        path: ['SELF_HOST_SECRET'],
        message: 'must differ from TOKEN_SECRET (reusing it would let a leaked login secret forge session cookies)',
      })
  })

export interface Config {
  nodeEnv: 'development' | 'test' | 'production'
  isProd: boolean
  port: number
  databaseUrl: string
  tokenSecret: string
  sessionTtlDays: number
  webOrigin: string
  trustProxy: string
  cookieSecure: boolean
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  google: { clientId?: string; clientSecret?: string; redirectUri?: string }
  /** Self-host owner sign-in secret (ADR-0035); undefined = feature off (Google-only). */
  selfHostSecret?: string
  vapid: { publicKey?: string; privateKey?: string; subject: string }
  notificationRetentionHours: number
  botServiceSecret?: string
}

const truthy = (v: string | undefined, fallback: boolean): boolean =>
  v === undefined ? fallback : /^(1|true|yes|on)$/i.test(v)

export const parseConfig = (env: NodeJS.ProcessEnv): Config => {
  const parsed = RawEnv.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  const e = parsed.data
  const isProd = e.NODE_ENV === 'production'
  return {
    nodeEnv: e.NODE_ENV,
    isProd,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    tokenSecret: e.TOKEN_SECRET,
    sessionTtlDays: e.SESSION_TTL_DAYS,
    webOrigin: e.WEB_ORIGIN,
    trustProxy: e.TRUST_PROXY,
    // Secure cookies default ON in prod; `COOKIE_SECURE` can force it either way (ADR-0004 §2).
    cookieSecure: truthy(env.COOKIE_SECURE, isProd),
    logLevel: e.LOG_LEVEL,
    google: {
      clientId: e.GOOGLE_CLIENT_ID,
      clientSecret: e.GOOGLE_CLIENT_SECRET,
      redirectUri: e.GOOGLE_REDIRECT_URI,
    },
    selfHostSecret: e.SELF_HOST_SECRET,
    vapid: {
      publicKey: e.VAPID_PUBLIC_KEY,
      privateKey: e.VAPID_PRIVATE_KEY,
      subject: e.VAPID_SUBJECT,
    },
    notificationRetentionHours: e.NOTIFICATION_RETENTION_HOURS,
    botServiceSecret: e.BOT_SERVICE_SECRET,
  }
}

let cached: Config | undefined
export const getConfig = (): Config => (cached ??= parseConfig(process.env))
