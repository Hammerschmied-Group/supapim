// Brand settings (@cms(singleton): one row per brand) and the currency dropdown of products.
//   admin  → the menu opens the settings row itself, saves and stays there; a product without a currency gets the
//            brand's default currency, a chosen one is kept
//   agency → reads the settings, cannot change them
// Writes only in suedwind and puts everything back (scripts/test-chain.mjs watches nordwind).
import { test, expect } from '@playwright/test';
import { signIn, tokenFor, rest } from './env.js';

const settings = async (token) => (await rest(token, 'GET', 'suedwind', 'settings?select=*')).json[0];

test('admin: Settings opens the one row of the brand, saves and stays on it', async ({ page }) => {
  const token = await tokenFor('admin@example.com');
  const before = await settings(token);
  try {
    await signIn(page, 'admin@example.com');
    const group = page.locator('nav[data-schema="suedwind"]');
    await expect(group.getByRole('menuitem').first()).toHaveText('Settings');      // first in the brand group
    await group.getByRole('menuitem', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/suedwind\.settings\/1$/);
    await expect(page.getByRole('textbox', { name: 'Display name' })).toHaveValue('Südwind');
    await expect(page.getByRole('combobox', { name: /Default currency/ })).toBeVisible();
    await expect(page.getByRole('combobox', { name: /Default locale/ })).toHaveText('de-DE');
    await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);       // one row: nothing to delete
    await expect(page.getByRole('textbox', { name: 'Id' })).toHaveCount(0);
    const text = `E2E ${Date.now()}`;
    await page.getByRole('textbox', { name: 'SEO description' }).fill(text);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Element updated')).toBeVisible();
    await expect(page).toHaveURL(/suedwind\.settings\/1$/);
    expect((await settings(token)).seo_description).toBe(text);

    // a website without http(s):// is refused by the database's check
    await page.getByRole('textbox', { name: 'Website' }).fill('suedwind.example');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(/website_url_check|violates check constraint/)).toBeVisible();
  } finally {
    await rest(token, 'PATCH', 'suedwind', 'settings?id=eq.1',
      { seo_description: before.seo_description, website_url: before.website_url });
  }
});

test('admin: currency is a dropdown; left empty, a new product gets the brand default currency', async ({ page }) => {
  const token = await tokenFor('admin@example.com');
  const before = await settings(token);
  const sku = `E2E-${Date.now()}`;
  try {
    await rest(token, 'PATCH', 'suedwind', 'settings?id=eq.1', { default_currency: 'CHF' });
    await signIn(page, 'admin@example.com');
    await page.goto('./#/suedwind.products/create');
    await page.getByRole('textbox', { name: 'Sku' }).fill(sku);
    await page.getByRole('textbox', { name: 'Name' }).fill('E2E currency default');
    await page.getByRole('spinbutton', { name: 'Price' }).fill('9.5');
    const currency = page.getByRole('combobox', { name: /Currency/ });
    await currency.click();
    for (const code of ['EUR', 'USD', 'GBP', 'CHF']) await expect(page.getByRole('option', { name: code })).toBeVisible();
    await page.getByRole('option').filter({ hasText: 'Default (when empty)' }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Element created')).toBeVisible();
    await expect(page.getByRole('combobox', { name: /Currency/ })).toHaveText('CHF');
    const row = (await rest(token, 'GET', 'suedwind', `products?sku=eq.${sku}&select=currency`)).json[0];
    expect(row.currency).toBe('CHF');

    // a chosen currency is kept
    await page.getByRole('combobox', { name: /Currency/ }).click();
    await page.getByRole('option', { name: 'GBP' }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Element updated')).toBeVisible();
    expect((await rest(token, 'GET', 'suedwind', `products?sku=eq.${sku}&select=currency`)).json[0].currency).toBe('GBP');
  } finally {
    await rest(token, 'DELETE', 'suedwind', `products?sku=eq.${sku}`);
    await rest(token, 'PATCH', 'suedwind', 'settings?id=eq.1', { default_currency: before.default_currency });
  }
});

test('agency: reads the settings of its brand, cannot change them', async ({ page }) => {
  await signIn(page, 'agentur.nordwind@example.com');
  await page.locator('nav[data-schema="nordwind"]').getByRole('menuitem', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/nordwind\.settings\/1\/show$/);
  await expect(page.locator('.RaShow-main').getByText('Nordwind', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
  const token = await tokenFor('agentur.nordwind@example.com');
  const r = await rest(token, 'PATCH', 'nordwind', 'settings?id=eq.1', { display_name: 'X' });
  expect(r.status).toBe(403);
});
