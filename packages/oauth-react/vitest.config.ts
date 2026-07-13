import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// jsdom + React plugin so the popup hook (`renderHook`) gets a real `window` with
// `window.open`, `postMessage`/`MessageEvent` and timers. Tests live in `test/`.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['test/**/*.{test,spec}.{ts,tsx}'],
  },
})
