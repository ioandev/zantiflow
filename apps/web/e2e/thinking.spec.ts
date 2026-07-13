// OPT-IN e2e spec — excluded from the default `playwright test` run; executes only when
// E2E_THINKING=1 is set (e.g. `pnpm --filter @zantiflow/web test:e2e:thinking`).
//
// Purpose: the `claude.thinking` indicator (ADR-0025) never showed on the website. This spec FAKES a
// `claude.thinking` attention at the browser's network layer (no plugin, no backend) and asserts the
// site renders the indicator end-to-end. It isolates the frontend: if this passes, the render path is
// correct and any remaining "no thinking label" is upstream (plugin detection / backend / cadence).
import { expect, test } from '@playwright/test'
import { authedState } from './fixtures'
import { installApiMocks } from './mock'

const OPT_IN = !!process.env.E2E_THINKING

test.describe('claude.thinking indicator (opt-in)', () => {
  test.skip(!OPT_IN, 'opt-in only — run with E2E_THINKING=1 (pnpm --filter @zantiflow/web test:e2e:thinking)')

  test('renders the thinking indicator when a claude.thinking attention is active', async ({ page }) => {
    const state = authedState()
    const id = state.machines[0].id // 'm_red' → session s1 / tab 1 / pane 1 (a `claude` pane)

    // Fake what the plugin+backend would produce: a claude.thinking attention targeting that exact
    // pane (targetKey = sid:tabId:paneId), plus the machine-summary count that drives the card badge.
    const nowIso = new Date().toISOString()
    state.attentions = [
      { id: 'attn_think', machineId: id, type: 'claude.thinking', targetKey: 's1:1:1', activeSince: nowIso, lastFiredAt: nowIso },
    ]
    state.machines[0].thinkingCount = 1
    await installApiMocks(page, state)

    await page.goto('/dashboard')

    // Overview card badge: "1 thinking".
    await expect(page.getByText('1 thinking')).toBeVisible()
    // Pane-level activity indicator: the animated "thinking…" label (U+2026 ellipsis).
    await expect(page.getByText('thinking…')).toBeVisible()
    // The session/pane "thinking" pills render too (at least one).
    await expect(page.locator('.pill.thinking')).not.toHaveCount(0)
    // Thinking is "Claude is busy", NOT "needs you" — no needs-attention pill (pane `.pill.needs`)
    // or count badge (`.pill.att`) is rendered for it. (The page footer legend mentions the phrase
    // "needs attention" statically, so we assert on the pills, not on page text.)
    await expect(page.locator('.pill.needs')).toHaveCount(0)
    await expect(page.locator('.pill.att')).toHaveCount(0)
  })

  test('does NOT render thinking for an idle claude pane (proves it is data-driven)', async ({ page }) => {
    await installApiMocks(page, authedState()) // no attentions, thinkingCount 0
    await page.goto('/dashboard')

    await expect(page.getByText('claude').first()).toBeVisible() // the pane still renders…
    await expect(page.getByText('thinking…')).toHaveCount(0) // …but with no thinking indicator
    await expect(page.locator('.pill.thinking')).toHaveCount(0)
  })
})
