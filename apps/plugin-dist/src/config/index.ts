// Environment configuration — parsed + validated once, fail-fast (ADR-0018 §4). `parseConfig` is
// pure (takes an env bag) so tests build a Config without touching process.env; `getConfig` is the
// lazy process-wide singleton. This app has no secrets of its own — GITHUB_TOKEN (optional) only
// raises the API rate limit.
import { z } from 'zod'
import type { LogLevel } from '../log'

const RawEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4500),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // Express `trust proxy` — derive client IP from X-Forwarded-For only for these hops (behind nginx).
  TRUST_PROXY: z.string().default('loopback'),
  // The GitHub repository whose Releases publish `zantiflow.wasm` (ADR-0022), as "owner/name".
  GITHUB_REPO: z
    .string()
    .regex(/^[^/\s]+\/[^/\s]+$/, 'must be "owner/name"')
    .default('ioandev/zantiflow'),
  // GitHub REST base — override for GitHub Enterprise or a test double.
  GITHUB_API_URL: z.string().url().default('https://api.github.com'),
  // Optional read-only PAT to raise the API rate limit (60/hr anon -> 5000/hr).
  GITHUB_TOKEN: z.string().optional(),
  // The release asset to mirror + the path we serve it under (`/<name>`).
  WASM_ASSET_NAME: z.string().min(1).default('zantiflow.wasm'),
  // How often to re-check GitHub for a higher-SemVer release.
  POLL_INTERVAL_MS: z.coerce.number().int().min(15_000).default(300_000),
  // `Cache-Control: public, max-age=` sent with the served asset.
  CACHE_MAX_AGE_SECONDS: z.coerce.number().int().nonnegative().default(300),
  // Per-request timeout for GitHub calls (list + download).
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  // Consider prerelease tags when picking "latest" (default: full releases only, ADR-0022).
  ALLOW_PRERELEASE: z.string().optional(),
})

export interface Config {
  nodeEnv: 'development' | 'test' | 'production'
  isProd: boolean
  port: number
  logLevel: LogLevel
  trustProxy: string
  repo: string
  githubApiUrl: string
  githubToken?: string
  wasmAssetName: string
  pollIntervalMs: number
  cacheMaxAgeSeconds: number
  requestTimeoutMs: number
  allowPrerelease: boolean
}

const truthy = (v: string | undefined): boolean => v !== undefined && /^(1|true|yes|on)$/i.test(v)

export const parseConfig = (env: NodeJS.ProcessEnv): Config => {
  const parsed = RawEnv.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  const e = parsed.data
  return {
    nodeEnv: e.NODE_ENV,
    isProd: e.NODE_ENV === 'production',
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    repo: e.GITHUB_REPO,
    githubApiUrl: e.GITHUB_API_URL.replace(/\/$/, ''),
    githubToken: e.GITHUB_TOKEN,
    wasmAssetName: e.WASM_ASSET_NAME,
    pollIntervalMs: e.POLL_INTERVAL_MS,
    cacheMaxAgeSeconds: e.CACHE_MAX_AGE_SECONDS,
    requestTimeoutMs: e.REQUEST_TIMEOUT_MS,
    allowPrerelease: truthy(e.ALLOW_PRERELEASE),
  }
}

let cached: Config | undefined
export const getConfig = (): Config => (cached ??= parseConfig(process.env))
