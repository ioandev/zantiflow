// The build identity of this web image — the version + commit it was compiled from. Injected at
// build time via the APP_VERSION / GIT_SHA build args (apps/web/Dockerfile +
// .github/workflows/docker-publish.yml) and inlined into the bundle by next.config's `env` map, so
// both server and client components can read it with no runtime env lookup. Falls back to a dev
// marker for a local `next dev` build.
export const APP_VERSION = process.env.APP_VERSION || 'dev'
export const GIT_SHA = process.env.GIT_SHA || 'unknown'

/** Compact footer label, e.g. `1.2.3 · a1b2c3d` — or just the version when no commit was injected. */
export const versionLabel = GIT_SHA === 'unknown' ? APP_VERSION : `${APP_VERSION} · ${GIT_SHA}`
