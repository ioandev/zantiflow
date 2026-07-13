import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Transform JSX in test files with the automatic runtime (no plugin needed for renderToStaticMarkup).
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  // Mirror the tsconfig path alias (`@/*` → project root) so component imports resolve under vitest.
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
  },
})
