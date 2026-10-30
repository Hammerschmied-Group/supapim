// One person, several brands: the demo agency agency_northstar (scripts/sql/agency.sql) is a member of agency_nordwind
// and agency_suedwind. A throwaway person gets that one role and works in both brands with the rights of each brand's
// agency. Writes only in suedwind and puts the name back (scripts/test-chain.mjs watches nordwind).
import { test, expect } from '@playwright/test';
import { signIn, tokenFor, rest, createUser, deleteUserByEmail, throwawayEmail } from './env.js';

const SW_1 = '20000000-0000-4000-8000-000000000001';

test('an agency for two brands sees and edits both, with the rights of each brand agency', async ({ page }) => {
  const email = throwawayEmail('multibrand');
  const adminToken = await tokenFor('admin@example.com');
  try {
    const id = await createUser(email);
    const assigned = await rest(adminToken, 'POST', 'cms_api', 'rpc/assign_role', { user_id: id, role_name: 'agency_northstar' });
    expect(assigned.status).toBe(200);

    await signIn(page, email);
    await expect(page.getByTestId('role')).toContainText('agency_northstar');
    await expect(page.locator('nav[data-schema]')).toHaveCount(2);
    await expect(page.locator('nav[data-schema="nordwind"]')).toBeVisible();
    await expect(page.locator('nav[data-schema="suedwind"]')).toBeVisible();
    await expect(page.locator('nav[data-schema="public"]')).toHaveCount(0);
    await expect(page.getByTestId('menu-admin')).toHaveCount(0);

    // Südwind: the name is editable, the price is not, as for agency_suedwind
    const token = await tokenFor(email);
    const before = (await rest(token, 'GET', 'suedwind', `products?id=eq.${SW_1}&select=name`)).json[0].name;
    try {
      await page.goto(`./#/suedwind.products/${SW_1}`);
      await expect(page.getByRole('spinbutton', { name: 'Price' })).not.toBeEditable();
      const name = page.getByRole('textbox', { name: 'Name' });
      await expect(name).toBeEditable();
      await name.fill(`${before} (Northstar Agency)`);
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText('Element updated')).toBeVisible();
      expect((await rest(token, 'GET', 'suedwind', `products?id=eq.${SW_1}&select=name`)).json[0].name).toBe(`${before} (Northstar Agency)`);
    } finally {
      await rest(token, 'PATCH', 'suedwind', `products?id=eq.${SW_1}`, { name: before });
    }

    // Nordwind: readable in the same session, the settings read-only
    await page.locator('nav[data-schema="nordwind"]').getByRole('menuitem', { name: 'Products' }).click();
    await expect(page.getByRole('cell', { name: 'NW-1003' })).toBeVisible();
    await page.locator('nav[data-schema="nordwind"]').getByRole('menuitem', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/nordwind\.settings\/1\/show$/);

    // the database, not the UI, draws the line: no HR documents, no price change in Nordwind
    expect((await rest(token, 'GET', 'public', 'documents?select=id')).status).toBe(403);
    expect((await rest(token, 'PATCH', 'nordwind', 'products?sku=eq.NW-1003', { price: 1 })).status).toBe(403);
  } finally {
    await deleteUserByEmail(email);
  }
});
