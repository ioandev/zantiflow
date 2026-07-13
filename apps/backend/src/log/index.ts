// Minimal structured JSON logger with built-in secret redaction. A tiny custom logger (vs a
// heavy dep) keeps the redaction rules — never emit tokens, cookies, secrets, or pane content
// (ADR-0018 §6) — in one auditable place. Redaction runs on every record before it is written.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

// Keys whose values are secrets regardless of content.
const SECRET_KEY =
  /^(authorization|cookie|set-cookie|token|secret|secrethash|password|passwd|id_token|client_secret|token_secret|ztf_session|apikey|api_key|servicesecret|service_secret)$/i
// Secret-shaped VALUES that may appear inside otherwise-innocent strings.
const SECRET_VALUE: RegExp[] = [
  /ztf_[A-Za-z0-9]{6,}/g, // ingest tokens
  /Bearer\s+[A-Za-z0-9._-]+/gi, // bearer credentials
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, // JWTs
]
const MASK = '«redacted»'

export const redact = (value: unknown, depth = 0): unknown => {
  if (depth > 8) return MASK // don't recurse into pathological structures
  if (typeof value === 'string') {
    let v = value
    for (const re of SECRET_VALUE) v = v.replace(re, MASK)
    return v
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? MASK : redact(v, depth + 1)
    }
    return out
  }
  return value
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  child(bindings: Record<string, unknown>): Logger
}

export interface LoggerOptions {
  level?: LogLevel
  bindings?: Record<string, unknown>
  /** Where each JSON line goes. Default: stdout. Overridable for tests. */
  sink?: (line: string) => void
}

export const createLogger = (opts: LoggerOptions = {}): Logger => {
  const level = opts.level ?? 'info'
  const min = LEVELS[level]
  const bindings = opts.bindings ?? {}
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line + '\n'))

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVELS[lvl] < min) return
    const rec = { level: lvl, time: new Date().toISOString(), msg, ...bindings, ...(fields ?? {}) }
    sink(JSON.stringify(redact(rec)))
  }

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (b) => createLogger({ level, bindings: { ...bindings, ...b }, sink }),
  }
}

/** A no-op logger for tests that don't assert on output. */
export const nullLogger: Logger = createLogger({ level: 'error', sink: () => {} })
