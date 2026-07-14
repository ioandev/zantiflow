// Manual refresh + presence (ADR-0026): clicking "refresh" asks the machine to push a fresh snapshot
// (POST /machines/:id/refresh), the button acknowledges + rate-limit-cools-down, and the resulting
// snapshot renders via the SSE re-emit — the whole refresh → push → render path, end-to-end.
import { expect, test } from '@playwright/test'
import { authedState, machine, session } from './fixtures'
import { installApiMocks } from './mock'

test.describe('manual refresh + presence (ADR-0026)', () => {
  test('the refresh button asks for a fresh snapshot and the update renders', async ({ page }) => {
    const state = authedState()
    const id = state.machines[0].id
    await installApiMocks(page, state)

    await page.goto('/dashboard')
    const btn = page.getByTitle('Ask this machine to send a fresh snapshot now')
    await expect(btn).toBeVisible()
    await expect(btn).toHaveText('↻ refresh')
    // The dashboard defaults to a "Claude only" view; the refreshed snapshot injects a non-Claude
    // session, so show the full tree — otherwise the filter hides it and the render assertion fails.
    await page.getByRole('checkbox', { name: 'Claude only' }).uncheck()

    // Click → POST /machines/:id/refresh (recorded by the mock) → the button acknowledges.
    await btn.click()
    await expect.poll(() => state.refreshCalls).toContain(id)
    await expect(btn).toHaveText(/requested|refreshing/)

    // The fresh snapshot arrives as it would over the plugin → backend → SSE path: mutate the detail
    // and the mocked SSE re-emit drives a refetch that renders the new session — no reload.
    state.details[id] = machine(id, { counts: { sessions: 2, tabs: 2, panes: 2 } }, [
      session(),
      session({
        sid: 's2',
        name: 'fresh-after-refresh',
        isCurrent: false,
        tabs: [{ tabId: 9, name: 'x', position: 1, active: false, panes: [] }],
      }),
    ]).detail
    await expect(page.getByText('fresh-after-refresh')).toBeVisible()

    // Re-enables after the ~5 s client cooldown (matches the server-side ≥5 s rate limit).
    await expect(btn).toHaveText('↻ refresh', { timeout: 8000 })
    await expect(btn).toBeEnabled()
  })

  test('a rate-limited refresh (429) surfaces "slow down"', async ({ page }) => {
    const state = authedState()
    state.refreshStatus = 429
    await installApiMocks(page, state)

    await page.goto('/dashboard')
    const btn = page.getByTitle('Ask this machine to send a fresh snapshot now')
    await btn.click()
    await expect(btn).toHaveText('slow down')
  })
})
