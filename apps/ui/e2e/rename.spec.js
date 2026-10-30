// Renaming an image (its path in the bucket): the object is moved in Storage and every row that points at it
// is updated along — or nothing happens at all.
//   admin  → renames a file two products use (gallery), cannot rename onto a taken name, renames in the image
//            field of a record and in Admin → "Files without a record"
//   agency → no rename (its role may not change the path column)
// Writes only in suedwind and removes what it adds (scripts/test-chain.mjs watches nordwind).
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { GW, readEnv, signIn, tokenFor, rest } from './env.js';

const SW_2001 = '20000000-0000-4000-8000-000000000001';   // has suedwind/sonnencreme.png
const SW_2002 = '20000000-0000-4000-8000-000000000002';
const SW_2003 = '20000000-0000-4000-8000-000000000003';
const PNG = readFileSync(new URL('../../../demo/files/images/suedwind/after-sun.png', import.meta.url));
const env = readEnv();
const storage = (token, method, path, init = {}) => fetch(`${GW}/storage/v1/${path}`, {
  method, ...init, headers: { apikey: env.ANON_KEY, Authorization: `Bearer ${token}`, ...init.headers },
});
const put = (token, object) => storage(token, 'POST', `object/images/${object}`, { headers: { 'Content-Type': 'image/png' }, body: PNG });
const status = async (token, object) => (await storage(token, 'GET', `object/authenticated/images/${object}`)).status;
const removeObjects = (token, objects) => storage(token, 'DELETE', 'object/images', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: objects }) });

test('admin renames a file two products use; both rows follow, the old name is gone', async ({ page }) => {
  const token = await tokenFor('admin@example.com');
  const stamp = Date.now();
  const from = `suedwind/ren-${stamp}.png`;
  const to = `suedwind/Lippenpflege-Detail-${stamp}.png`;
  const rows = [];
  try {
    expect((await put(token, from)).status).toBe(200);
    for (const product of [SW_2002, SW_2003]) {
      rows.push((await rest(token, 'POST', 'suedwind', 'product_images', { product_id: product, storage_path: from, position: 90 })).json[0].id);
    }
    await signIn(page, 'admin@example.com');
    await page.goto(`./#/suedwind.products/${SW_2003}`);
    const card = page.getByTestId('gallery-suedwind.product_images').locator(`[data-testid="gallery-card"][data-path="${from}"]`);
    await card.getByTestId('rename-open').click();
    const dialog = page.getByTestId('rename-file');
    await expect(dialog.getByTestId('rename-usage')).toContainText('2 records');
    await dialog.getByTestId('rename-input').fill(`Lippenpflege Detail-${stamp}.png`);   // the space becomes "-"
    await expect(dialog).toContainText(`images/${to}`);
    await dialog.getByTestId('rename-confirm').click();
    await expect(dialog).toHaveCount(0);

    await expect(page.getByTestId('gallery-suedwind.product_images').locator(`[data-testid="gallery-card"][data-path="${to}"]`)).toBeVisible();
    const paths = (await rest(token, 'GET', 'suedwind', `product_images?id=in.(${rows.join(',')})&select=storage_path`)).json.map((r) => r.storage_path);
    expect(paths).toEqual([to, to]);
    expect(await status(token, to)).toBe(200);
    expect(await status(token, from)).not.toBe(200);
  } finally {
    if (rows.length) await rest(token, 'DELETE', 'suedwind', `product_images?id=in.(${rows.join(',')})`);
    await removeObjects(token, [from, to]);
  }
});

test('renaming onto a name that is taken changes nothing', async ({ page }) => {
  const token = await tokenFor('admin@example.com');
  const from = `suedwind/ren-taken-${Date.now()}.png`;
  let row;
  try {
    expect((await put(token, from)).status).toBe(200);
    row = (await rest(token, 'POST', 'suedwind', 'product_images', { product_id: SW_2003, storage_path: from, position: 91 })).json[0].id;
    await signIn(page, 'admin@example.com');
    await page.goto(`./#/suedwind.products/${SW_2003}`);
    await page.locator(`[data-testid="gallery-card"][data-path="${from}"]`).getByTestId('rename-open').click();
    const dialog = page.getByTestId('rename-file');
    await dialog.getByTestId('rename-input').fill('sonnencreme.png');          // exists: suedwind/sonnencreme.png
    await dialog.getByTestId('rename-confirm').click();
    await expect(dialog.getByTestId('rename-error')).toContainText('already exists');
    expect((await rest(token, 'GET', 'suedwind', `product_images?id=eq.${row}&select=storage_path`)).json[0].storage_path).toBe(from);
    expect(await status(token, from)).toBe(200);
    expect(await status(token, 'suedwind/sonnencreme.png')).toBe(200);      // the other file is untouched
  } finally {
    if (row) await rest(token, 'DELETE', 'suedwind', `product_images?id=eq.${row}`);
    await removeObjects(token, [from]);
  }
});

test('admin renames in the image field of a record', async ({ page }) => {
  const token = await tokenFor('admin@example.com');
  const stamp = Date.now();
  const from = `suedwind/ren-field-${stamp}.png`;
  const to = `suedwind/renamed-field-${stamp}.png`;
  let row;
  try {
    expect((await put(token, from)).status).toBe(200);
    row = (await rest(token, 'POST', 'suedwind', 'product_images', { product_id: SW_2003, storage_path: from, position: 92 })).json[0].id;
    await signIn(page, 'admin@example.com');
    await page.goto(`./#/suedwind.product_images/${row}`);
    await page.getByTestId('storage-storage_path').getByTestId('rename-open').click();
    await page.getByTestId('rename-input').fill(`renamed-field-${stamp}.png`);
    await page.getByTestId('rename-confirm').click();
    await expect(page.getByTestId('storage-path')).toHaveText(`images/${to}`);
    await expect(page.getByText(`Renamed to ${to}`)).toBeVisible();
    expect((await rest(token, 'GET', 'suedwind', `product_images?id=eq.${row}&select=storage_path`)).json[0].storage_path).toBe(to);
    expect(await status(token, to)).toBe(200);
  } finally {
    if (row) await rest(token, 'DELETE', 'suedwind', `product_images?id=eq.${row}`);
    await removeObjects(token, [from, to]);
  }
});

test('admin renames an unused file in Admin → "Files without a record"', async ({ page }) => {
  const token = await tokenFor('admin@example.com');
  const stamp = Date.now();
  const from = `suedwind/ren-orphan-${stamp}.png`;
  const to = `suedwind/ren-orphan-new-${stamp}.png`;
  try {
    expect((await put(token, from)).status).toBe(200);
    await signIn(page, 'admin@example.com');
    await page.goto('./#/admin');
    await page.getByTestId('unreferenced-files').locator(`[data-testid="unreferenced-file"][data-path="${from}"]`).getByTestId('rename-open').click();
    await expect(page.getByTestId('rename-usage')).toContainText('0 records');
    await page.getByTestId('rename-input').fill(`ren-orphan-new-${stamp}.png`);
    await page.getByTestId('rename-confirm').click();
    await expect(page.getByTestId('unreferenced-files').locator(`[data-testid="unreferenced-file"][data-path="${to}"]`)).toBeVisible();
    expect(await status(token, from)).not.toBe(200);
  } finally {
    await removeObjects(token, [from, to]);
  }
});

test('agency cannot rename: its role may not change the path', async ({ page }) => {
  await signIn(page, 'agentur.suedwind@example.com');
  await page.goto(`./#/suedwind.products/${SW_2001}`);
  await expect(page.getByTestId('gallery-card')).toHaveCount(1);
  await expect(page.getByTestId('rename-open')).toHaveCount(0);
});
