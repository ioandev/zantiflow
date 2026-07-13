// Process entrypoint: load+validate config (fail-fast), build the app, start the GitHub poller, listen,
// and shut down cleanly on SIGTERM/SIGINT. The artifact is fetched in the background — `/readyz` stays
// 503 and `/zantiflow.wasm` returns 503 until the first release is mirrored.
import { getConfig } from './config'
import { createGithubClient } from './github/client'
import { createApp } from './http/app'
import { createLogger } from './log'
import { getVersion } from './version'
import { startWasmPolling } from './wasm/service'
import { createWasmStore } from './wasm/store'

const main = (): void => {
  const config = getConfig()
  const logger = createLogger({ level: config.logLevel })
  const version = getVersion()
  logger.info('plugin_dist_starting', {
    version: version.version,
    commit: version.commit,
    node: version.node,
    env: config.nodeEnv,
    repo: config.repo,
    asset: config.wasmAssetName,
  })

  const store = createWasmStore()
  const client = createGithubClient({
    apiUrl: config.githubApiUrl,
    repo: config.repo,
    token: config.githubToken,
    timeoutMs: config.requestTimeoutMs,
    userAgent: `zantiflow-plugin-dist/${version.version}`,
  })

  const app = createApp({ config, logger, store, readiness: () => store.get() !== null })
  const server = app.listen(config.port, () => {
    logger.info('plugin_dist_listening', { port: config.port, env: config.nodeEnv })
  })

  if (!config.githubToken) {
    logger.warn('github_token_unset', { hint: 'set GITHUB_TOKEN to raise the API rate limit (60 -> 5000/hr)' })
  }
  // Immediate first fetch, then re-check on the poll interval.
  const poller = startWasmPolling({ client, store, config, logger })

  const shutdown = (signal: string): void => {
    logger.info('shutting_down', { signal })
    poller.stop()
    server.close(() => process.exit(0))
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

if (require.main === module) main()
