// Gallery: product images are added and edited right in the product (child table with an image column).
//   admin  → adds two images at once, edits an alt text, reorders, removes one (row and unused file go)
//   agency → edits alt text in the gallery, but cannot add or remove images
// Writes only in suedwind and removes what it adds (scripts/test-chain.mjs watches nordwind).
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { GW, readEnv, signIn, tokenFor, rest } from './env.js';

const SW_2001 = '20000000-0000-4000-8000-000000000001';   // Sonnencreme, one seeded image
const SW_2003 = '20000000-0000-4000-8000-000000000003';   // Lippenpflege, no images
const PNG = readFileSync(new URL('../../../demo/files/images/suedwind/after-sun.png', import.meta.url));
const env = readEnv();
const storage = (token, method, path, init = {}) => fetch(`${GW}/storage/v1/${path}`, {
  method, ...init, headers: { apikey: env.ANON_KEY, Authorization: `Bearer ${token}`, ...init.headers },
});
const objectStatus = async (token, object) => (await storage(token, 'GET', `object/authenticated/images/${object}`)).status;
const imagesOf = async (token, productId) =>
  (await rest(token, 'GET', 'suedwind', `product_images?product_id=eq.${productId}&select=id,storage_path,alt_text,position&order=position,id`)).json;

test('admin adds several images in the product, edits, reorders and removes them', async ({ page }) => {
  const token = await tokenFor('admin@example.com');
  const stamp = Date.now();
  const names = [`gal-a-${stamp}.png`, `gal-b-${stamp}.png`];
  try {
    await signIn(page, 'admin@example.com');
    await page.goto(`./#/suedwind.products/${SW_2003}`);
    const gallery = page.getByTestId('gallery-suedwind.product_images');
    await expect(gallery.getByTestId('gallery-empty')).toBeVisible();

    // two files at once
    await gallery.getByTestId('gallery-input').setInputFiles(names.map((name) => ({ name, mimeType: 'image/png', buffer: PNG })));
    await expect(gallery.getByTestId('gallery-card')).toHaveCount(2);
    let rows = await imagesOf(token, SW_2003);
    expect(rows.map((r) => r.storage_path)).toEqual(names.map((n) => `suedwind/${n}`));
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
    for (const r of rows) expect(await objectStatus(token, r.storage_path)).toBe(200);
    await expect(gallery.getByTestId('image-preview').first()).toBeVisible();

    // alt text right on the card, saved when leaving the field
    const first = gallery.getByTestId('gallery-card').first();
    await first.getByTestId('gallery-alt').fill('Lippenpflege, Stift geöffnet');
    await first.getByTestId('gallery-alt').press('Enter');
    await expect(page.getByText('Saved')).toBeVisible();
    await expect.poll(async () => (await imagesOf(token, SW_2003))[0].alt_text).toBe('Lippenpflege, Stift geöffnet');
    await expect(page).toHaveURL(new RegExp(`suedwind\\.products/${SW_2003}$`));     // Enter did not submit the product form

    if (process.env.GALLERY_SCREENSHOT) await page.screenshot({ path: process.env.GALLERY_SCREENSHOT, fullPage: true });

    // move the second image to the front
    await gallery.getByTestId('gallery-card').nth(1).getByTestId('gallery-move-left').click();
    await expect.poll(async () => (await imagesOf(token, SW_2003)).map((r) => r.storage_path)).toEqual([`suedwind/${names[1]}`, `suedwind/${names[0]}`]);
    await expect(gallery.getByTestId('gallery-card').first()).toHaveAttribute('data-path', `suedwind/${names[1]}`);

    // remove one: the row goes, and so does the file (no other row uses it)
    page.once('dialog', (d) => d.accept());
    await gallery.locator(`[data-testid="gallery-card"][data-path="suedwind/${names[1]}"]`).getByTestId('gallery-remove').click();
    await expect(gallery.getByTestId('gallery-card')).toHaveCount(1);
    rows = await imagesOf(token, SW_2003);
    expect(rows.map((r) => r.storage_path)).toEqual([`suedwind/${names[0]}`]);
    await expect.poll(() => objectStatus(token, `suedwind/${names[1]}`)).not.toBe(200);
  } finally {
    await rest(token, 'DELETE', 'suedwind', `product_images?product_id=eq.${SW_2003}`);
    for (const n of names) await storage(token, 'DELETE', `object/images/suedwind/${n}`);
  }
});

test('agency edits alt text in the gallery but cannot add or remove images', async ({ page }) => {
  const token = await tokenFor('agentur.suedwind@example.com');
  const before = (await imagesOf(token, SW_2001))[0];
  try {
    await signIn(page, 'agentur.suedwind@example.com');
    await page.goto(`./#/suedwind.products/${SW_2001}`);
    const gallery = page.getByTestId('gallery-suedwind.product_images');
    await expect(gallery.getByTestId('gallery-card')).toHaveCount(1);
    await expect(gallery.getByTestId('gallery-input')).toHaveCount(0);
    await expect(gallery.getByTestId('gallery-remove')).toHaveCount(0);
    await expect(gallery.getByTestId('gallery-move-left')).toHaveCount(0);
    const alt = gallery.getByTestId('gallery-alt');
    await expect(alt).toBeEditable();
    await alt.fill(`Tube Sonnencreme (Galerie ${Date.now()})`);
    await alt.blur();
    await expect(page.getByText('Saved')).toBeVisible();
    await expect.poll(async () => (await imagesOf(token, SW_2001))[0].alt_text).toMatch(/Galerie/);
  } finally {
    await rest(token, 'PATCH', 'suedwind', `product_images?id=eq.${before.id}`, { alt_text: before.alt_text });
  }
});

test('the create form says images come after the first save', async ({ page }) => {
  await signIn(page, 'admin@example.com');
  await page.goto('./#/suedwind.products/create');
  await expect(page.getByTestId('gallery-after-save')).toBeVisible();
  await expect(page.getByTestId('gallery-suedwind.product_images')).toHaveCount(0);
});
