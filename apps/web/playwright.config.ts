import { defineConfig, devices } from '@playwright/test'

// E2E for the dashboard (ADR-0014's Playwright layer). The specs drive the REAL Next.js frontend and
// mock the backend at the browser's network layer (`page.route` over `/api/v1/**`) — the backend is an
// external here (it has its own real-MariaDB integration tests), so there's no DB/Google/testcontainers
// to stand up, and the always-open SSE stream that supertest can't hold open is finally exercised.
//
// A dedicated port keeps clear of the user's own dev servers (3000/4000 are often occupied here).
const PORT = Number(process.env.E2E_PORT ?? 3100)
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    // The specs mock the backend at the network layer (`page.route` over `/api/v1/**`). The app's PWA
    // service worker (`/sw.js`) calls `clients.claim()` and has a `fetch` handler, so if it registers
    // it takes control of the page and swallows those fetches before route interception sees them —
    // leaving the UI stuck on "Loading…". Block SWs so the mocks are always in the loop (no spec here
    // exercises the SW; PWA behaviour isn't covered by these tests).
    serviceWorkers: 'block',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Serve a production build (deterministic, matches what we ship) on the test port. `test:e2e` runs
  // `next build` first; locally a server already on the port is reused.
  webServer: {
    command: `pnpm exec next start -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
