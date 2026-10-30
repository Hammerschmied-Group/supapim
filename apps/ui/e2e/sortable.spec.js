// Drag-and-drop ordering in lists (sortable.jsx): FAQ of a brand.
//   admin  → drags the second entry to the top, reorders with the keyboard, a new entry goes to the end
//   agency → no handles (no update on position)
// Writes only in suedwind and puts the order back (scripts/test-chain.mjs watches nordwind).
import { test, expect } from '@playwright/test';
import { signIn, tokenFor, rest } from './env.js';

const FAQ_1 = '22000000-0000-4000-8000-000000000001';
const FAQ_2 = '22000000-0000-4000-8000-000000000002';
const order = async (token) => (await rest(token, 'GET', 'suedwind', 'faq?select=id,position&order=position,id')).json;
const restore = async (token, before) => {
  for (const r of before) await rest(token, 'PATCH', 'suedwind', `faq?id=eq.${r.id}`, { position: r.position });
};

test('admin drags an FAQ entry to the top; the new order is saved', async ({ page }) => {
  const token = await tokenFor('admin@example.com');
  const before = await order(token);
  try {
    await signIn(page, 'admin@example.com');
    await page.goto('./#/suedwind.faq');
    const list = page.getByTestId('sortable-list');
    await expect(list.getByTestId('sortable-row')).toHaveCount(before.length);
    await expect(list.getByTestId('sortable-row').first()).toHaveAttribute('data-id', FAQ_1);
    if (process.env.SORTABLE_SCREENSHOT) {
      await list.locator(`[data-testid="sortable-row"][data-id="${FAQ_2}"]`).getByTestId('sortable-handle').hover();
      await page.screenshot({ path: process.env.SORTABLE_SCREENSHOT });
    }
    const second = list.locator(`[data-testid="sortable-row"][data-id="${FAQ_2}"]`);
    await second.getByTestId('sortable-handle').dragTo(list.getByTestId('sortable-row').first());
    await expect(page.getByText('Order saved')).toBeVisible();
    await expect(list.getByTestId('sortable-row').first()).toHaveAttribute('data-id', FAQ_2);
    const after = await order(token);
    expect(after.map((r) => r.id).slice(0, 2)).toEqual([FAQ_2, FAQ_1]);
    expect(after.map((r) => r.position)).toEqual(after.map((_, i) => i));     // consecutive
  } finally {
    await restore(token, before);
  }
});

test('admin reorders with the keyboard (focus the handle, arrow down)', async ({ page }) => {
  const token = await tokenFor('admin@example.com');
  const before = await order(token);
  try {
    await signIn(page, 'admin@example.com');
    await page.goto('./#/suedwind.faq');
    const list = page.getByTestId('sortable-list');
    await list.locator(`[data-testid="sortable-row"][data-id="${FAQ_1}"]`).getByTestId('sortable-handle').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByText('Order saved')).toBeVisible();
    await expect.poll(async () => (await order(token)).map((r) => r.id).slice(0, 2)).toEqual([FAQ_2, FAQ_1]);
  } finally {
    await restore(token, before);
  }
});

test('a new FAQ entry goes to the end of the list', async ({ page }) => {
  const token = await tokenFor('admin@example.com');
  const question = `E2E sortable ${Date.now()}`;
  const before = await order(token);
  try {
    await signIn(page, 'admin@example.com');
    await page.goto('./#/suedwind.faq/create');
    await expect(page.getByLabel('Position')).toHaveCount(0);        // set by the list, not typed
    await page.getByRole('textbox', { name: 'Question' }).fill(question);
    await page.getByRole('textbox', { name: 'Answer' }).fill('E2E');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Element created')).toBeVisible();
    const row = (await rest(token, 'GET', 'suedwind', `faq?question=eq.${encodeURIComponent(question)}&select=position`)).json[0];
    expect(row.position).toBe(Math.max(...before.map((r) => r.position)) + 1);
  } finally {
    await rest(token, 'DELETE', 'suedwind', `faq?question=eq.${encodeURIComponent(question)}`);
  }
});

test('agency sees the FAQ list without drag handles', async ({ page }) => {
  await signIn(page, 'agentur.suedwind@example.com');
  await page.goto('./#/suedwind.faq');
  await expect(page.getByRole('cell', { name: /wasserfest/ })).toBeVisible();
  await expect(page.getByTestId('sortable-handle')).toHaveCount(0);
  await expect(page.getByTestId('sortable-list')).toHaveCount(0);
});
