// The unified /login surface (ADR-0035). The same web image serves a Google-only hosted deployment
// and self-hosters who set a secret; the page asks GET /auth/methods and renders accordingly. These
// specs drive each shape via `state.authMethods` (+ `state.localSecret` for the secret path).
import { expect, test } from '@playwright/test'
import { authedState, type MockState } from './fixtures'
import { installApiMocks } from './mock'

const SECRET = 'correct-horse-battery-staple-x9q2' // ≥32 chars, like a real SELF_HOST_SECRET
const anon = (over: Partial<MockState>): MockState => ({
  me: null,
  machines: [],
  details: {},
  attentions: [],
  tokens: [],
  ...over,
})

test.describe('login (/login) — owner sign-in surface (ADR-0035)', () => {
  test('a Google-only deployment forwards straight to Google (stays one-click)', async ({ page }) => {
    await installApiMocks(page, anon({ authMethods: { google: true, local: false } }))
    await page.goto('/login?redirect=/dashboard')
    // No secret form; the page auto-forwards to the backend Google entrypoint carrying the redirect.
    await expect(page).toHaveURL(/\/api\/v1\/auth\/google\?redirect=/)
  })

  test('a secret-only deployment shows the secret form and signs in on the correct secret', async ({ page }) => {
    await installApiMocks(page, anon({ authMethods: { google: false, local: true }, localSecret: SECRET }))
    await page.goto('/login?redirect=/dashboard')

    const input = page.getByLabel('Sign-in secret')
    await expect(input).toBeVisible()
    await expect(page.getByRole('link', { name: 'Sign in with Google' })).toHaveCount(0) // no Google in secret-only

    await input.fill(SECRET)
    await page.getByRole('button', { name: 'Sign in' }).click()
    // On success the page navigates to the target, which now renders (the session is set).
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.getByRole('heading', { name: 'Machines' })).toBeVisible()
  })

  test('a wrong secret shows an error and does not sign in', async ({ page }) => {
    await installApiMocks(page, anon({ authMethods: { google: false, local: true }, localSecret: SECRET }))
    await page.goto('/login?redirect=/dashboard')

    await page.getByLabel('Sign-in secret').fill('not-the-secret')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByText('Incorrect secret.')).toBeVisible()
    await expect(page).toHaveURL(/\/login/)
  })

  test('when both methods are enabled, both surfaces render', async ({ page }) => {
    await installApiMocks(page, anon({ authMethods: { google: true, local: true }, localSecret: SECRET }))
    await page.goto('/login?redirect=/dashboard')
    await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible()
    await expect(page.getByLabel('Sign-in secret')).toBeVisible()
  })

  test('an already-signed-in visitor is bounced to the target', async ({ page }) => {
    await installApiMocks(page, authedState())
    await page.goto('/login?redirect=/dashboard')
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.getByRole('heading', { name: 'Machines' })).toBeVisible()
  })
})
