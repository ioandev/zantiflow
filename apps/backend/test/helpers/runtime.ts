// Shared testcontainers runtime helper. Works with Docker or rootless Podman (DOCKER_HOST → its
// socket). Ryuk can't run under rootless Podman, so it's disabled by default (integration tests
// stop their containers explicitly in afterAll); a CI with real Docker can re-enable it via
// TESTCONTAINERS_RYUK_DISABLED=false. Integration suites SKIP (not fail) when no runtime is up.
import http from 'node:http'

process.env.TESTCONTAINERS_RYUK_DISABLED ||= 'true'

export const socketPath = process.env.DOCKER_HOST?.startsWith('unix://')
  ? process.env.DOCKER_HOST.slice('unix://'.length)
  : '/var/run/docker.sock'

export const containerRuntimeUp = (): Promise<boolean> =>
  new Promise((resolve) => {
    const req = http.request({ socketPath, path: '/_ping', method: 'GET', timeout: 2000 }, (res) => {
      res.resume()
      resolve((res.statusCode ?? 500) < 500)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
