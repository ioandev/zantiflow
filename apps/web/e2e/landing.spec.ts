import { expect, test } from '@playwright/test'
import { authedState, type MockState } from './fixtures'
import { installApiMocks } from './mock'

test.describe('landing / auth gate', () => {
  test('anonymous visitor sees the sign-in call to action', async ({ page }) => {
    const state: MockState = { me: null, machines: [], details: {}, attentions: [], tokens: [] }
    await installApiMocks(page, state)

    await page.goto('/')

    await expect(page.getByRole('heading', { name: 'Know the moment your terminal needs you.' })).toBeVisible()
    // The nav + hero + final-CTA now carry a generic "Sign in" link → the unified /login page
    // (ADR-0035, so the same image works Google-only or self-host); assert the first one.
    const signIn = page.getByRole('link', { name: 'Sign in', exact: true }).first()
    await expect(signIn).toBeVisible()
    // The link points at /login with a post-login redirect (login page then picks the method).
    await expect(signIn).toHaveAttribute('href', /\/login\?redirect=/)
  })

  test('a signed-in visitor stays on the landing page with a logged-in header', async ({ page }) => {
    await installApiMocks(page, authedState())

    await page.goto('/')

    // No longer redirected away — the marketing page stays visible…
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('heading', { name: 'Know the moment your terminal needs you.' })).toBeVisible()
    // …but the header + primary CTA reflect the session instead of prompting sign-in. ('Dashboard' is
    // exact so it doesn't also match the hero/final "Open dashboard" links.)
    await expect(page.getByRole('link', { name: 'Dashboard', exact: true })).toBeVisible()
    await expect(page.locator('.hp-nav .avatar')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open dashboard' }).first()).toBeVisible()
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveCount(0)
  })
})
