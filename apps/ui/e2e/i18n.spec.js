// German and English: default from the browser language, the language switch, react-admin's own texts in German.
import { test, expect } from '@playwright/test';
import { readEnv } from './env.js';

const env = readEnv();
const lang = (page) => page.evaluate(() => document.documentElement.lang);

test.describe('browser language de-DE', () => {
  test.use({ locale: 'de-DE' });

  test('the login page is German; so are errors', async ({ page }) => {
    await page.goto('./');
    await expect(page.getByLabel('E-Mail')).toBeVisible();
    await expect(page.getByLabel('Passwort')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Anmelden' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Passwort vergessen?' })).toBeVisible();
    expect(await lang(page)).toBe('de');
    await page.getByLabel('E-Mail').fill('admin@example.com');
    await page.getByLabel('Passwort').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Anmelden' }).click();
    await expect(page.getByRole('alert')).toContainText('E-Mail oder Passwort ist falsch');
  });

  test('inside the app: our texts and react-admin\'s own are German, the switch changes them without a reload', async ({ page }) => {
    await page.goto('./');
    await page.getByLabel('E-Mail').fill('admin@example.com');
    await page.getByLabel('Passwort').fill(env.TEST_USER_PASSWORD);
    await page.getByRole('button', { name: 'Anmelden' }).click();
    await expect(page.getByTestId('role')).toContainText('Datenbankrolle: cms_admin');
    await expect(page.getByRole('menuitem', { name: 'Sicherheit' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Übersicht' })).toBeVisible();      // react-admin: ra.page.dashboard

    await page.goto('./#/nordwind.products');
    await expect(page.getByRole('link', { name: 'Erstellen' })).toBeVisible();
    await expect(page.getByText('Zeilen pro Seite:')).toBeVisible();
    await expect(page.getByText(/^1–\d+ von \d+$/)).toBeVisible();
    await expect(page.getByLabel('Suchen')).toBeVisible();

    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.getByRole('link', { name: 'Create' })).toBeVisible();
    await expect(page.getByText('Rows per page:')).toBeVisible();
    expect(await lang(page)).toBe('en');
  });

  test('an invitation link page is German', async ({ page }) => {
    await page.goto('./#/set-password');
    await expect(page.getByRole('alert')).toContainText('unvollständig oder abgelaufen');
  });
});

test.describe('browser language en-US, with the switch', () => {
  test.use({ locale: 'en-US' });

  test('default English; the choice survives a reload and wins over the browser', async ({ page }) => {
    await page.goto('./');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    expect(await lang(page)).toBe('en');
    await page.getByRole('button', { name: 'Deutsch' }).click();
    await expect(page.getByRole('button', { name: 'Anmelden' })).toBeVisible();
    expect(await lang(page)).toBe('de');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Anmelden' })).toBeVisible();
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });
});

test.describe('other browser languages', () => {
  test.use({ locale: 'de-AT' });
  test('de-AT counts as German', async ({ page }) => {
    await page.goto('./');
    await expect(page.getByRole('button', { name: 'Anmelden' })).toBeVisible();
  });
});

test.describe('unsupported browser language', () => {
  test.use({ locale: 'fr-FR' });
  test('falls back to English', async ({ page }) => {
    await page.goto('./');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    expect(await lang(page)).toBe('en');
  });
});
