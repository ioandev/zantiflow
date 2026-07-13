import { defineConfig } from 'vitest/config'

// Node environment (default); the router is driven over real HTTP against a live
// `express()` app with fake providers (see `test/router.test.ts`), so no DOM is needed.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.{test,spec}.ts'],
  },
})
