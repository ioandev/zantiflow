import { expect, test } from '@playwright/test'
import { machine, ME, type MockState } from './fixtures'
import type { TokenMeta } from '../lib/types'
import { installApiMocks } from './mock'

const signedIn = (over: Partial<MockState> = {}): MockState => ({
  me: ME,
  machines: [],
  details: {},
  attentions: [],
  tokens: [],
  ...over,
})

const tok = (over: Partial<TokenMeta> = {}): TokenMeta => ({
  id: 'tok_work',
  label: 'work-token',
  createdAt: '2026-03-01T00:00:00Z',
  expiresAt: null,
  lastUsedAt: null,
  status: 'active',
  ...over,
})

test.describe('ingest tokens', () => {
  test('mints a token (secret shown once), lists it, then revokes it', async ({ page }) => {
    await installApiMocks(page, signedIn())
    await page.goto('/tokens')

    await expect(page.getByRole('heading', { name: 'Ingest tokens' })).toBeVisible()
    await expect(page.getByText('No tokens yet.')).toBeVisible()

    // Mint.
    await page.getByPlaceholder('name (optional)').fill('ci-laptop')
    await page.getByRole('button', { name: 'Create token' }).click()

    // The one-time secret is shown, then dismissed.
    const secret = page.getByText(/^ztf_tok_1_secret_shown_once$/)
    await expect(secret).toBeVisible()
    await page.getByRole('button', { name: 'Done' }).click()
    await expect(secret).toBeHidden()

    // The new token is now listed as active, with no machines yet.
    const card = page.locator('.tok-card').filter({ hasText: 'ci-laptop' })
    await expect(card).toBeVisible()
    await expect(card.locator('.pill')).toHaveText('active')
    await expect(card).toContainText('No machines have reported with this token yet.')

    // Revoke — inline confirm (no browser dialog). With no machines the trigger is a plain "Revoke".
    await card.getByRole('button', { name: 'Revoke', exact: true }).click()
    await card.getByRole('button', { name: 'Confirm' }).click()

    await expect(card.locator('.pill')).toHaveText('revoked')
    await expect(card.getByRole('button', { name: /Revoke/ })).toHaveCount(0)
  })

  test("lists a token's machines with added/last-seen and kicks one", async ({ page }) => {
    const alpha = machine('m_alpha', { displayName: 'alpha', tokenId: 'tok_work' }).summary
    const beta = machine('m_beta', { displayName: 'beta', tokenId: 'tok_work' }).summary
    await installApiMocks(page, signedIn({ tokens: [tok()], machines: [alpha, beta] }))
    await page.goto('/tokens')

    const card = page.locator('.tok-card').filter({ hasText: 'work-token' })
    await expect(card).toBeVisible()

    // Both machines are listed under the token, with their machineId and when they were added.
    const alphaRow = card.locator('.mrow').filter({ hasText: 'alpha' })
    await expect(alphaRow.locator('.mid')).toHaveText('m_alpha')
    await expect(alphaRow).toContainText('added Mar 12, 2026')
    await expect(alphaRow).toContainText('online now')
    await expect(card.locator('.mrow')).toHaveCount(2)

    // The revoke button reflects the combined action + machine count.
    await expect(card.getByRole('button', { name: 'Revoke + forget 2 machines' })).toBeVisible()

    // Cancel backs out without deleting (the green button is the safe way out).
    await alphaRow.getByRole('button', { name: 'Kick' }).click()
    await alphaRow.getByRole('button', { name: 'Cancel' }).click()
    await expect(card.locator('.mrow')).toHaveCount(2)

    // Kick just one machine — click the trigger, then the inline Confirm.
    await alphaRow.getByRole('button', { name: 'Kick' }).click()
    await alphaRow.getByRole('button', { name: 'Confirm' }).click()

    await expect(card.locator('.mrow')).toHaveCount(1)
    await expect(card.locator('.mrow').filter({ hasText: 'alpha' })).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'Revoke + forget 1 machine' })).toBeVisible()
  })

  test('combined revoke forgets the token and its machines', async ({ page }) => {
    const alpha = machine('m_alpha', { displayName: 'alpha', tokenId: 'tok_work' }).summary
    await installApiMocks(page, signedIn({ tokens: [tok()], machines: [alpha] }))
    await page.goto('/tokens')

    const card = page.locator('.tok-card').filter({ hasText: 'work-token' })
    await card.getByRole('button', { name: 'Revoke + forget 1 machine' }).click()
    await card.getByRole('button', { name: 'Confirm' }).click()

    await expect(card.locator('.pill')).toHaveText('revoked')
    await expect(card).toContainText('No machines have reported with this token yet.')
    await expect(card.getByRole('button', { name: /Revoke/ })).toHaveCount(0)
  })

  test('renames a token in place', async ({ page }) => {
    await installApiMocks(page, signedIn({ tokens: [tok({ label: 'old-name' })] }))
    await page.goto('/tokens')

    await page.locator('.tok-card').filter({ hasText: 'old-name' }).getByRole('button', { name: 'Rename' }).click()

    // Editing swaps the label for an input, so the card no longer contains "old-name" text — query the
    // (single) rename input at page level rather than through a hasText: 'old-name' filter.
    await page.getByPlaceholder('token name').fill('renamed-laptop')
    await page.getByRole('button', { name: 'Save' }).click()

    await expect(page.locator('.tok-card').filter({ hasText: 'renamed-laptop' })).toBeVisible()
    await expect(page.getByText('old-name')).toHaveCount(0)
  })

  test('lists unlinked machines under "Other machines" and kicks them', async ({ page }) => {
    const orphan = machine('m_orphan', { displayName: 'orphan', tokenId: null }).summary
    await installApiMocks(page, signedIn({ machines: [orphan] }))
    await page.goto('/tokens')

    const other = page.locator('.tok-other')
    await expect(other.getByRole('heading', { name: 'Other machines' })).toBeVisible()
    const row = other.locator('.mrow').filter({ hasText: 'orphan' })
    await expect(row).toBeVisible()

    await row.getByRole('button', { name: 'Kick' }).click()
    await row.getByRole('button', { name: 'Confirm' }).click()

    await expect(page.locator('.tok-other')).toHaveCount(0)
  })

  test('gates the page behind sign-in', async ({ page }) => {
    await installApiMocks(page, { me: null, machines: [], details: {}, attentions: [], tokens: [] })
    await page.goto('/tokens')

    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Ingest tokens' })).toHaveCount(0)
  })
})
