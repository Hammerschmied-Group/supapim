// 5a acceptance: the UI shows exactly what Postgres allows the signed-in role.
// Writes go to suedwind only: scripts/test-chain.mjs (Task 4) checks the latest audit rows of
// nordwind.products and counts the admin's rows in nordwind.faq, so this suite never writes there.
import { test, expect } from '@playwright/test';
import { signIn, tokenFor, rest } from './env.js';

const NW_1003 = '10000000-0000-4000-8000-000000000003';
const SW_2002 = '20000000-0000-4000-8000-000000000002';

const menu = (page) => page.locator('nav[data-schema]');

test.describe('agency Nordwind', () => {
  test('sees only its brand', async ({ page }) => {
    await signIn(page, 'agentur.nordwind@example.com');
    await expect(page.getByTestId('role')).toContainText('agency_nordwind');
    await expect(menu(page)).toHaveCount(1);
    await expect(page.locator('nav[data-schema="nordwind"]')).toBeVisible();
    await expect(page.locator('nav[data-schema="suedwind"]')).toHaveCount(0);
    await expect(page.locator('nav[data-schema="public"]')).toHaveCount(0);

    // the other brand is not even a route …
    await page.goto('./#/suedwind.products');
    await expect(page.getByText('Not Found')).toBeVisible();
    // … and the database refuses it, too
    const token = await tokenFor('agentur.nordwind@example.com');
    const r = await rest(token, 'GET', 'suedwind', 'products?select=id');
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('42501');
  });

  test('name editable, price read-only, no create or delete', async ({ page }) => {
    await signIn(page, 'agentur.nordwind@example.com');
    await page.locator('nav[data-schema="nordwind"]').getByRole('menuitem', { name: 'Products' }).click();
    await expect(page.getByRole('cell', { name: 'NW-1003' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create' })).toHaveCount(0);
    await expect(page.getByRole('checkbox')).toHaveCount(0);           // no bulk delete selection

    await page.getByRole('cell', { name: 'NW-1003' }).click();
    await expect(page).toHaveURL(new RegExp(`nordwind\\.products/${NW_1003}$`));
    await expect(page.getByRole('textbox', { name: 'Name' })).toBeEditable();
    await expect(page.getByRole('spinbutton', { name: 'Price' })).not.toBeEditable();
    await expect(page.getByRole('textbox', { name: 'Sku' })).not.toBeEditable();
    await expect(page.getByRole('textbox', { name: 'Description' })).not.toBeEditable();
    await expect(page.getByRole('combobox', { name: /Status/ })).not.toBeEditable();
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  });

  test('foreign keys are navigable relations', async ({ page }) => {
    await signIn(page, 'agentur.nordwind@example.com');
    await page.goto('./#/nordwind.product_images');
    const link = page.getByRole('link', { name: /Nordwind Fleece Midlayer/ });
    await link.click();
    await expect(page).toHaveURL(/nordwind\.products\/10000000-0000-4000-8000-000000000002$/);
    // reverse direction: the product shows its images (as a gallery, see gallery.spec.js)
    const gallery = page.getByTestId('gallery-nordwind.product_images');
    await expect(gallery.locator('[data-testid="gallery-card"][data-path="nordwind/fleece.png"]')).toBeVisible();
  });
});

test.describe('agency Südwind (writes)', () => {
  test('saves a name change; a price change is refused by Postgres', async ({ page }) => {
    const token = await tokenFor('agentur.suedwind@example.com');
    const before = (await rest(token, 'GET', 'suedwind', `products?id=eq.${SW_2002}&select=name,price`)).json[0];
    const newName = `${before.name} (UI ${Date.now()})`;
    try {
      await signIn(page, 'agentur.suedwind@example.com');
      await page.goto(`./#/suedwind.products/${SW_2002}`);
      await expect(page.getByRole('spinbutton', { name: 'Price' })).not.toBeEditable();
      await page.getByRole('textbox', { name: 'Name' }).fill(newName);
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText('Element updated')).toBeVisible();
      const after = (await rest(token, 'GET', 'suedwind', `products?id=eq.${SW_2002}&select=name,price`)).json[0];
      expect(after.name).toBe(newName);
      expect(after.price).toBe(before.price);

      // the same person, straight at the API: price is not theirs to change
      const denied = await rest(token, 'PATCH', 'suedwind', `products?id=eq.${SW_2002}`, { price: 1 });
      expect(denied.status).toBe(403);
      expect(denied.json.code).toBe('42501');
    } finally {
      await rest(token, 'PATCH', 'suedwind', `products?id=eq.${SW_2002}`, { name: before.name });
    }
  });
});

test.describe('HR', () => {
  test('sees no brand schemas, only the HR documents, read-only', async ({ page }) => {
    await signIn(page, 'hr@example.com');
    await expect(page.getByTestId('role')).toContainText('hr_editor');
    await expect(menu(page)).toHaveCount(1);
    await expect(page.locator('nav[data-schema="public"]')).toBeVisible();
    await expect(page.locator('nav[data-schema="nordwind"]')).toHaveCount(0);
    await expect(page.locator('nav[data-schema="suedwind"]')).toHaveCount(0);

    await page.locator('nav[data-schema="public"]').getByRole('menuitem', { name: 'Documents' }).click();
    const rows = page.locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    const brands = await rows.locator('td.column-brand').allInnerTexts();
    expect(brands.length).toBeGreaterThan(0);
    expect(new Set(brands)).toEqual(new Set(['hr']));
    await expect(page.getByRole('link', { name: 'Create' })).toHaveCount(0);

    await page.goto('./#/nordwind.products');
    await expect(page.getByText('Not Found')).toBeVisible();
  });
});

test.describe('admin', () => {
  test('creates and deletes a FAQ entry (create + delete buttons follow the grants)', async ({ page }) => {
    await signIn(page, 'admin@example.com');
    // the demo schemas; brands added with scripts/brand-bootstrap.sh show up as further groups
    for (const schema of ['nordwind', 'public', 'suedwind']) await expect(page.locator(`nav[data-schema="${schema}"]`)).toHaveCount(1);
    await page.goto('./#/suedwind.faq');
    await page.getByRole('link', { name: 'Create' }).click();
    const question = `E2E question ${Date.now()}`;
    await page.getByRole('textbox', { name: 'Question' }).fill(question);
    await page.getByRole('textbox', { name: 'Answer' }).fill('E2E answer');
    await expect(page.getByRole('switch', { name: 'Published' })).toBeChecked();   // DB default true prefilled
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Element created')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Question' })).toHaveValue(question);
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText('Element deleted')).toBeVisible();
    const token = await tokenFor('admin@example.com');
    const left = await rest(token, 'GET', 'suedwind', `faq?question=eq.${encodeURIComponent(question)}&select=id`);
    expect(left.json).toEqual([]);
  });
});

test('a person without a role sees no tables', async ({ page }) => {
  await signIn(page, 'ohne.rolle@example.com');
  await expect(page.getByTestId('no-tables')).toBeVisible();
  await expect(menu(page)).toHaveCount(0);
});

test('Administration and Security sit at the bottom of the sidebar, below the brands', async ({ page }) => {
  await signIn(page, 'admin@example.com');
  const bottom = page.getByTestId('menu-bottom');
  await expect(bottom.getByRole('menuitem')).toHaveText(['Administration', 'Security']);
  const box = await bottom.boundingBox();
  const lastBrand = await menu(page).last().boundingBox();
  expect(box.y).toBeGreaterThan(lastBrand.y + lastBrand.height);
  expect(box.y + box.height).toBeGreaterThan(page.viewportSize().height - 24);     // at the window edge
  await expect(bottom.getByRole('link', { name: 'AutomateThis!' })).toHaveAttribute('href', 'https://automatethis.pro');
});
