import { defineConfig } from 'vitest/config'

// Node environment (default); tests live in `test/` (outside `src/` so `tsc` never
// emits them into `dist`) and import straight from `src/` — Vitest transpiles the TS.
// The providers call the global `fetch` (no injection seam), so the client tests stub
// `globalThis.fetch`; the Apple client-secret test uses real `node:crypto`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.{test,spec}.ts'],
  },
})
