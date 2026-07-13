import { expect, test } from '@playwright/test'
import { authedState, machine, pane, session } from './fixtures'
import { installApiMocks } from './mock'

test.describe('dashboard', () => {
  test('renders the machine → session → tab → pane tree', async ({ page }) => {
    await installApiMocks(page, authedState())

    await page.goto('/dashboard')

    await expect(page.getByRole('heading', { name: 'Machines' })).toBeVisible()
    // Overview card + detail section for the reporting machine.
    await expect(page.getByText('red-laptop').first()).toBeVisible()
    await expect(page.getByText('1 reporting for this account')).toBeVisible()
    // The tree: session name, tab name, pane name all rendered from the snapshot.
    await expect(page.getByText('main').first()).toBeVisible()
    await expect(page.getByText('editor').first()).toBeVisible()
    await expect(page.getByText('claude').first()).toBeVisible()
  })

  test('an anonymous user hitting /dashboard directly is asked to sign in', async ({ page }) => {
    await installApiMocks(page, { me: null, machines: [], details: {}, attentions: [], tokens: [] })

    await page.goto('/dashboard')

    await expect(page.getByText('Please sign in to see your machines.')).toBeVisible()
    const signIn = page.getByRole('link', { name: 'Sign in', exact: true })
    await expect(signIn).toBeVisible()
    await expect(signIn).toHaveAttribute('href', '/login?redirect=%2Fdashboard')
  })

  test('live-updates the tree when an ingest arrives over the SSE stream', async ({ page }) => {
    const state = authedState()
    const id = state.machines[0].id
    await installApiMocks(page, state)

    await page.goto('/dashboard')
    await expect(page.getByText('main').first()).toBeVisible()
    // The new session is not present yet.
    await expect(page.getByText('night-deploy')).toHaveCount(0)

    // Simulate the plugin pushing a new snapshot: swap in a detail with a second session. The mocked
    // SSE stream re-emits `machine.update` on its next reconnect, which the dashboard turns into a
    // refetch — so the new session appears with no page reload.
    const updated = machine(id, { counts: { sessions: 2, tabs: 2, panes: 2 } }, [
      session(),
      session({
        sid: 's2',
        name: 'night-deploy',
        isCurrent: false,
        tabs: [
          {
            tabId: 9,
            name: 'deploy',
            position: 1,
            active: false,
            panes: [pane({ id: 2, name: 'ansible', command: 'ansible-playbook' })],
          },
        ],
      }),
    ])
    state.details[id] = updated.detail

    await expect(page.getByText('night-deploy')).toBeVisible()
    await expect(page.getByText('ansible').first()).toBeVisible()
  })

  test('renders untrusted terminal names as inert text (XSS-safe)', async ({ page }) => {
    const state = authedState()
    const id = state.machines[0].id
    // Names come straight from the user's terminal; React must escape them, never execute them.
    const scriptPayload = '<script>window.__xssRan=1</script>'
    const imgPayload = '<img src=x onerror="window.__xssRan=1">'
    const m = machine(id, {}, [
      session({
        name: scriptPayload,
        tabs: [{ tabId: 1, name: 'tab', position: 0, active: true, panes: [pane({ name: imgPayload })] }],
      }),
    ])
    state.details[id] = m.detail
    await installApiMocks(page, state)

    await page.goto('/dashboard')

    // The raw payload text is visible (escaped), proving it rendered as text, not markup...
    await expect(page.getByText(scriptPayload).first()).toBeVisible()
    // ...and neither payload executed.
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => (window as unknown as { __xssRan?: number }).__xssRan)).toBeUndefined()
    // No injected element made it into the DOM.
    expect(await page.locator('img[src="x"]').count()).toBe(0)
  })
})
