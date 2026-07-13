// The build identity of this process — the version + commit it was built from. Baked into the image
// at build time via APP_VERSION / GIT_SHA (Dockerfile); falls back to package.json for a local
// `pnpm dev` run. Logged once at startup and surfaced on /healthz so you can confirm which build is
// actually deployed.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface VersionInfo {
  version: string
  commit: string
  node: string
}

const pkgVersion = (): string => {
  try {
    // Resolves to the package root in both layouts: `src/version.ts` (dev, via tsx) and
    // `dist/version.js` (prod) are each one level under the package dir.
    const raw = readFileSync(join(__dirname, '..', 'package.json'), 'utf8')
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

let cached: VersionInfo | undefined

export const getVersion = (): VersionInfo =>
  (cached ??= {
    version: process.env.APP_VERSION?.trim() || pkgVersion(),
    commit: process.env.GIT_SHA?.trim() || 'unknown',
    node: process.version,
  })
