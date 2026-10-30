// 5b acceptance: image columns (Storage + imgproxy) with the rights of the signed-in role.
//   agency  → sees the preview and edits alt text / title, but has neither an upload button nor a writable path
//   admin   → chooses an image (uploaded only when the row is saved), saves, deletes; discards a choice;
//             a failed save leaves no file behind; links a file that is already in the bucket; deletes an
//             unused upload in Admin → "Files without a record"
// Writes only in suedwind and always undone (scripts/test-chain.mjs watches nordwind).
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { GW, readEnv, signIn, tokenFor, rest } from './env.js';

const SW_IMG_2 = '21000000-0000-4000-8000-000000000002';   // suedwind/after-sun.png, "Flasche After-Sun"
const PNG = readFileSync(new URL('../../../demo/files/images/suedwind/after-sun.png', import.meta.url));
const env = readEnv();

const storage = (token, method, path, init = {}) => fetch(`${GW}/storage/v1/${path}`, {
  method, ...init, headers: { apikey: env.ANON_KEY, Authorization: `Bearer ${token}`, ...init.headers },
});
const objectStatus = async (token, bucketPath) => (await storage(token, 'GET', `object/authenticated/${bucketPath}`)).status;

/** The preview in the image field of the form is a real image from imgproxy: it loaded and has pixels. */
async function expectPreview(page) {
  const img = page.getByTestId('storage-storage_path').getByTestId('image-preview');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth)).toBeGreaterThan(0);
  expect(await img.getAttribute('src')).toContain('/storage/v1/render/image/');
  return img;
}

test.describe('agency', () => {
  test('Nordwind sees the preview and the alt text of its brand; no upload, path locked', async ({ page }) => {
    await signIn(page, 'agentur.nordwind@example.com');
    await page.goto('./#/nordwind.product_images');
    await expect(page.getByRole('cell', { name: /nordwind\/fleece\.png/ })).toBeVisible();
    await page.getByRole('cell', { name: /nordwind\/fleece\.png/ }).click();
    await expect(page).toHaveURL(/nordwind\.product_images\/11000000-0000-4000-8000-000000000002$/);

    const img = await expectPreview(page);
    await expect(img).toHaveAttribute('alt', 'Fleece-Jacke in Grau');
    await expect(img).toHaveAttribute('title', 'Nordwind Fleece Midlayer');
    await expect(page.getByRole('textbox', { name: 'Alt text' })).toHaveValue('Fleece-Jacke in Grau');
    await expect(page.getByRole('textbox', { name: 'Alt text' })).toBeEditable();
    await expect(page.getByRole('textbox', { name: 'Title attr' })).toBeEditable();
    // the path is shown, never an input (upload / replace / rename set it)
    await expect(page.getByTestId('storage-path')).toHaveText('images/nordwind/fleece.png');
    await expect(page.getByRole('textbox', { name: 'Storage path' })).toHaveCount(0);
    // alt text and title are part of the image field, not fields of their own a second time
    await expect(page.getByRole('textbox', { name: 'Alt text' })).toHaveCount(1);
    await expect(page.getByTestId('upload-input')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Upload|Replace/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Create' })).toHaveCount(0);

    // the list shows thumbnails, too
    await page.goto('./#/nordwind.product_images');
    await expect(page.locator('tbody img[data-testid="image-preview"]').first()).toBeVisible();
  });

  test('Südwind saves alt text and title; Postgres and Storage refuse everything else', async ({ page }) => {
    const token = await tokenFor('agentur.suedwind@example.com');
    const row = () => rest(token, 'GET', 'suedwind', `product_images?id=eq.${SW_IMG_2}&select=storage_path,alt_text,title_attr`).then((r) => r.json[0]);
    const before = await row();
    const alt = `Flasche After-Sun (UI ${Date.now()})`;
    try {
      await signIn(page, 'agentur.suedwind@example.com');
      await page.goto(`./#/suedwind.product_images/${SW_IMG_2}`);
      await expectPreview(page);
      await page.getByRole('textbox', { name: 'Alt text' }).fill(alt);
      await page.getByRole('textbox', { name: 'Title attr' }).fill('Südwind After-Sun Gel (UI)');
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText('Element updated')).toBeVisible();
      const after = await row();
      expect(after.alt_text).toBe(alt);
      expect(after.title_attr).toBe('Südwind After-Sun Gel (UI)');
      expect(after.storage_path).toBe(before.storage_path);

      // straight at the API with the same token: path column and bucket are not theirs to write
      const patch = await rest(token, 'PATCH', 'suedwind', `product_images?id=eq.${SW_IMG_2}`, { storage_path: 'suedwind/elsewhere.png' });
      expect(patch.status).toBe(403);
      expect(patch.json.code).toBe('42501');
      const up = await storage(token, 'POST', 'object/images/suedwind/e2e-agency.png', { headers: { 'Content-Type': 'image/png' }, body: PNG });
      // Storage reports the refusal as statusCode 403 in the body (HTTP 400 on the wire)
      expect(String((await up.json()).statusCode)).toBe('403');
      expect(await objectStatus(token, 'images/suedwind/e2e-agency.png')).not.toBe(200);
    } finally {
      await rest(token, 'PATCH', 'suedwind', `product_images?id=eq.${SW_IMG_2}`, { alt_text: before.alt_text, title_attr: before.title_attr });
    }
    expect(await row()).toEqual(before);
  });
});

test('forms leave system-filled fields alone: no path input, position and updated_at read-only', async ({ page }) => {
  await signIn(page, 'admin@example.com');
  await page.goto('./#/suedwind.product_images/21000000-0000-4000-8000-000000000001');
  await expect(page.getByTestId('storage-path')).toHaveText('images/suedwind/sonnencreme.png');
  await expect(page.getByRole('textbox', { name: 'Storage path' })).toHaveCount(0);
  await expect(page.getByLabel('Position')).not.toBeEditable();
  await expect(page.getByLabel('Updated at')).not.toBeEditable();
  await expect(page.getByRole('textbox', { name: 'Alt text' })).toBeEditable();
  // create: neither appears, the database fills them
  await page.goto('./#/suedwind.product_images/create');
  await expect(page.getByLabel('Position')).toHaveCount(0);
  await expect(page.getByLabel('Updated at')).toHaveCount(0);
  // FAQ: the list's drag-and-drop sets the order (sortable.spec.js), so the form does not
  await page.goto('./#/suedwind.faq/22000000-0000-4000-8000-000000000001');
  await expect(page.getByLabel('Position')).not.toBeEditable();
  await expect(page.getByLabel('Updated at')).not.toBeEditable();
});

test.describe('admin', () => {
  const upload = (page, name) => page.getByTestId('upload-input').setInputFiles({ name, mimeType: 'image/png', buffer: PNG });
  const pickProduct = async (page) => {
    await page.getByRole('combobox', { name: /Product id/ }).fill('After-Sun');
    await page.getByRole('option', { name: /After-Sun/ }).click();
  };
  const putObject = (token, object) => storage(token, 'POST', `object/images/${object}`, { headers: { 'Content-Type': 'image/png' }, body: PNG });

  test('a chosen image is uploaded only when the row is saved; then the row is deleted again', async ({ page }) => {
    const token = await tokenFor('admin@example.com');
    const file = `e2e-upload-${Date.now()}.png`;
    const object = `suedwind/${file}`;
    let rowId;
    try {
      await signIn(page, 'admin@example.com');
      await page.goto('./#/suedwind.product_images');
      await page.getByRole('link', { name: 'Create' }).click();
      await expect(page.getByTestId('image-placeholder')).toBeVisible();
      await pickProduct(page);
      await upload(page, file);
      await expect(page.getByTestId('storage-path')).toHaveText(`images/${object}`);
      await expect(page.getByTestId('image-preview-local')).toBeVisible();
      await expect(page.getByTestId('upload-pending')).toBeVisible();
      expect(await objectStatus(token, `images/${object}`)).not.toBe(200);       // not uploaded yet
      await page.getByRole('textbox', { name: 'Alt text' }).fill('E2E upload');
      await page.getByRole('textbox', { name: 'Title attr' }).fill('E2E title');
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText('Element created')).toBeVisible({ timeout: 20_000 });   // the upload to Storage happens on save
      expect(await objectStatus(token, `images/${object}`)).toBe(200);           // uploaded with the save
      rowId = (await rest(token, 'GET', 'suedwind', `product_images?storage_path=eq.${encodeURIComponent(object)}&select=id,alt_text,title_attr`)).json[0];
      expect(rowId).toMatchObject({ alt_text: 'E2E upload', title_attr: 'E2E title' });

      // edit view: replace button is there, and so is the preview (now from Storage)
      await expect(page.getByRole('button', { name: 'Replace' })).toBeVisible();
      await expectPreview(page);
      await page.getByRole('button', { name: 'Delete' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
      await expect(page.getByText('Element deleted')).toBeVisible();
      expect((await rest(token, 'GET', 'suedwind', `product_images?id=eq.${rowId.id}&select=id`)).json).toEqual([]);

      // the row is gone, the object is not garbage-collected (another row could point at it): remove it explicitly
      expect(await objectStatus(token, `images/${object}`)).toBe(200);
      const del = await storage(token, 'DELETE', `object/images/${object}`);
      expect(del.status).toBe(200);
      expect(await objectStatus(token, `images/${object}`)).not.toBe(200);
    } finally {
      if (rowId) await rest(token, 'DELETE', 'suedwind', `product_images?id=eq.${rowId.id}`);
      await storage(token, 'DELETE', `object/images/${object}`);
    }
  });

  test('"Discard selection" drops a chosen file; nothing was uploaded', async ({ page }) => {
    const token = await tokenFor('admin@example.com');
    const file = `e2e-undo-${Date.now()}.png`;
    const object = `suedwind/${file}`;
    try {
      await signIn(page, 'admin@example.com');
      await page.goto('./#/suedwind.product_images/create');
      await upload(page, file);
      await expect(page.getByTestId('image-preview-local')).toBeVisible();
      await page.getByTestId('undo-upload').click();
      await expect(page.getByTestId('image-placeholder')).toBeVisible();
      await expect(page.getByTestId('storage-path')).toHaveText('No file chosen yet.');
      await expect(page.getByTestId('undo-upload')).toHaveCount(0);
      expect(await objectStatus(token, `images/${object}`)).not.toBe(200);
    } finally {
      await storage(token, 'DELETE', `object/images/${object}`);
    }
  });

  test('a save that fails validation (no product) leaves no file in the bucket', async ({ page }) => {
    const token = await tokenFor('admin@example.com');
    const file = `e2e-invalid-${Date.now()}.png`;
    const object = `suedwind/${file}`;
    try {
      await signIn(page, 'admin@example.com');
      await page.goto('./#/suedwind.product_images/create');
      await upload(page, file);
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText(/Required/).first()).toBeVisible();            // product is missing
      await expect(page).toHaveURL(/product_images\/create$/);
      expect(await objectStatus(token, `images/${object}`)).not.toBe(200);
    } finally {
      await storage(token, 'DELETE', `object/images/${object}`);
    }
  });

  test('a save the database refuses after the upload takes the upload back', async ({ page }) => {
    const token = await tokenFor('admin@example.com');
    const sku = `E2E-${Date.now()}`;
    const file = `e2e-refused-${Date.now()}.png`;
    const object = `suedwind/${file}`;
    let productId;
    try {
      productId = (await rest(token, 'POST', 'suedwind', 'products', { sku, name: `E2E Produkt ${sku}`, price: 1 })).json[0].id;
      await signIn(page, 'admin@example.com');
      await page.goto('./#/suedwind.product_images/create');
      await page.getByRole('combobox', { name: /Product id/ }).fill(sku);
      await page.getByRole('option', { name: new RegExp(sku) }).click();
      await upload(page, file);
      // the product disappears before the save: the insert fails on the foreign key, after the upload
      await rest(token, 'DELETE', 'suedwind', `products?id=eq.${productId}`);
      productId = null;
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText(/foreign key|violates/i).first()).toBeVisible();
      await expect(page).toHaveURL(/product_images\/create$/);
      await expect.poll(() => objectStatus(token, `images/${object}`)).not.toBe(200);
    } finally {
      if (productId) await rest(token, 'DELETE', 'suedwind', `products?id=eq.${productId}`);
      await storage(token, 'DELETE', `object/images/${object}`);
    }
  });

  test('links a file that is already in the bucket ("Existing file")', async ({ page }) => {
    const token = await tokenFor('admin@example.com');
    const object = `suedwind/e2e-existing-${Date.now()}.png`;
    let rowId;
    try {
      expect((await putObject(token, object)).status).toBe(200);
      await signIn(page, 'admin@example.com');
      await page.goto('./#/suedwind.product_images/create');
      await pickProduct(page);
      await page.getByTestId('pick-existing').click();
      const dialog = page.getByTestId('existing-files');
      await dialog.locator(`[data-testid="existing-file"][data-path="${object}"]`).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('storage-path')).toHaveText(`images/${object}`);
      await expectPreview(page);
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText('Element created')).toBeVisible({ timeout: 20_000 });   // the upload to Storage happens on save
      rowId = (await rest(token, 'GET', 'suedwind', `product_images?storage_path=eq.${encodeURIComponent(object)}&select=id`)).json[0];
      expect(rowId).toBeTruthy();
      // now in use: no longer offered as unreferenced
      const r = await rest(token, 'POST', 'cms_api', 'rpc/unreferenced_files', { bucket: 'images' });
      expect(r.json.map((f) => f.name)).not.toContain(object);
    } finally {
      if (rowId) await rest(token, 'DELETE', 'suedwind', `product_images?id=eq.${rowId.id}`);
      await storage(token, 'DELETE', `object/images/${object}`);
    }
  });

  test('Admin → "Files without a record" lists an unused upload and deletes it', async ({ page }) => {
    const token = await tokenFor('admin@example.com');
    const object = `suedwind/e2e-orphan-${Date.now()}.png`;
    try {
      expect((await putObject(token, object)).status).toBe(200);
      await signIn(page, 'admin@example.com');
      await page.goto('./#/admin');
      const row = page.getByTestId('unreferenced-files').locator(`[data-testid="unreferenced-file"][data-path="${object}"]`);
      await expect(row).toBeVisible();
      page.once('dialog', (d) => d.accept());
      await row.getByRole('button', { name: 'Delete' }).click();
      await expect(page.getByText(`Deleted images/${object}.`)).toBeVisible();
      await expect(row).toHaveCount(0);
      expect(await objectStatus(token, `images/${object}`)).not.toBe(200);
    } finally {
      await storage(token, 'DELETE', `object/images/${object}`);
    }
  });
});
