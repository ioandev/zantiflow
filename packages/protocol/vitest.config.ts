import { defineConfig } from 'vitest/config'

// Tests live in `test/` (outside `src/`, so `tsc` never emits them) and import from `src/`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.{test,spec}.ts'],
  },
})
