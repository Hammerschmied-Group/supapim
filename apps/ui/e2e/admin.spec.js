// 5c acceptance: admin area (invite, role, rights, history) and the admin API's guards.
// The people in these tests are throwaway (wegwerf-…@example.test), created through the UI's own invite and
// deleted afterwards. The demo users and their roles are never changed, and writes go to suedwind only.
import { test, expect } from '@playwright/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn, tokenFor, rest, readEnv, mintToken, deleteUser, SERVICE_SECRETS } from './env.js';

const env = readEnv();
const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const NW_ID = '00000000-0000-4000-8000-000000000002';
const SW_2002 = '20000000-0000-4000-8000-000000000002';
const api = (path) => `/cms/api/admin${path}`;
// SCREENSHOTS=1 npm run e2e refreshes the README screenshots (docs/screenshots)
const shot = async (page, name) => {
  if (!process.env.SCREENSHOTS) return;
  await page.waitForTimeout(600);                       // let dialogs finish fading in
  await page.screenshot({ path: `docs/screenshots/${name}.png` });
};

test.describe('administration (UI)', () => {
  const email = `wegwerf-${Date.now()}@example.test`;
  test.afterAll(() => deleteUser(email));

  test('admin invites a throwaway person, assigns a role; the change shows up with the admin e-mail', async ({ page }) => {
    await signIn(page, 'admin@example.com');
    await page.getByTestId('menu-admin').click();
    await expect(page.getByTestId('admin-page')).toBeVisible();
    await expect(page.getByTestId('user-row').first()).toBeVisible();

    // invite (no SMTP here → the one-time link is shown instead of a mail)
    await page.getByRole('textbox', { name: 'E-mail' }).fill(email);
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    await expect(page.getByTestId('invite-result')).toContainText(email);
    await expect(page.getByTestId('invite-link')).toContainText('/auth/v1/verify?token=');
    const row = page.locator(`[data-testid="user-row"][data-email="${email}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('invited');

    // assign a role
    await row.getByRole('combobox', { name: `Role of ${email}` }).click();
    await page.getByRole('option', { name: 'hr_editor' }).click();
    await expect(page.getByTestId('admin-notice')).toContainText(`${email} → hr_editor`);
    await expect(row.getByRole('combobox', { name: `Role of ${email}` })).toContainText('hr_editor');

    // change it, then check the log
    await row.getByRole('combobox', { name: `Role of ${email}` }).click();
    await page.getByRole('option', { name: 'agency_suedwind' }).click();
    await expect(page.getByTestId('admin-notice')).toContainText(`${email} → agency_suedwind`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, 'admin-users');
    await row.getByRole('button', { name: 'History' }).click();
    const rows = page.getByTestId('role-history').getByTestId('history-row');
    await expect(rows).toHaveCount(2);
    await shot(page, 'admin-role-history');
    await expect(rows.nth(0).getByTestId('history-who')).toContainText('admin@example.com');
    await expect(rows.nth(0)).toContainText(`changed the role of ${email}: hr_editor → agency_suedwind`);
    await expect(rows.nth(1)).toContainText(`assigned role hr_editor to ${email}`);
    await page.keyboard.press('Escape');

    // effective rights of the new role, straight from Postgres
    await row.getByRole('button', { name: 'Rights' }).click();
    const rights = page.getByTestId('rights');
    await expect(rights.locator('[data-table="suedwind.products"]')).toContainText('name');
    await expect(rights.locator('[data-table="nordwind.products"]')).toHaveCount(0);
    await shot(page, 'admin-effective-rights');
    await page.keyboard.press('Escape');

    // block and unblock through the admin API
    await row.getByRole('button', { name: 'Block' }).click();
    await expect(row).toContainText('blocked');
    await row.getByRole('button', { name: 'Unblock' }).click();
    await expect(row).toContainText('invited');

    // revoke
    await row.getByRole('combobox', { name: `Role of ${email}` }).click();
    await page.getByRole('option', { name: 'no role' }).click();
    await expect(page.getByTestId('admin-notice')).toContainText(`Role removed from ${email}`);
    await row.getByRole('button', { name: 'History' }).click();
    await expect(page.getByTestId('role-history').getByTestId('history-row').first()).toContainText(`removed role agency_suedwind from ${email}`);
  });

  test('the admin cannot change their own role or block themselves', async ({ page }) => {
    await signIn(page, 'admin@example.com');
    await page.getByTestId('menu-admin').click();
    const self = page.locator('[data-testid="user-row"][data-email="admin@example.com"]');
    await expect(self).toContainText('you');
    await expect(self.getByRole('combobox', { name: 'Role of admin@example.com' })).toHaveAttribute('aria-disabled', 'true');
    await expect(self.getByRole('button', { name: 'Block' })).toHaveCount(0);
  });

  test('effective rights of every assignable role are readable', async ({ page }) => {
    await signIn(page, 'admin@example.com');
    await page.getByTestId('menu-admin').click();
    await page.getByTestId('rights-agency_nordwind').click();
    const r = page.getByTestId('rights').locator('[data-table="nordwind.products"]');
    await expect(r).toContainText('name');
    await expect(page.getByTestId('rights').locator('[data-table="nordwind.products"]')).not.toContainText('price');
  });

  test('non-admins get no admin area', async ({ page }) => {
    await signIn(page, 'agentur.nordwind@example.com');
    await expect(page.getByTestId('menu-admin')).toHaveCount(0);
    await page.goto('./#/admin');
    await expect(page.getByText('Not Found')).toBeVisible();
  });
});

test.describe('change history per record', () => {
  test('admin sees who changed a record (Edit and Show); the agency does not see the panel', async ({ page }) => {
    // one audited change in suedwind, made as the Südwind agency and restored afterwards
    const tokenSw = await tokenFor('agentur.suedwind@example.com');
    const original = (await rest(tokenSw, 'GET', 'suedwind', `products?select=name&id=eq.${SW_2002}`)).json[0].name;
    const name = `${original} (hist ${Date.now()})`;
    try {
      expect((await rest(tokenSw, 'PATCH', 'suedwind', `products?id=eq.${SW_2002}`, { name })).status).toBe(200);

      await signIn(page, 'agentur.suedwind@example.com');
      await page.goto(`./#/suedwind.products/${SW_2002}`);
      await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue(name);
      await expect(page.getByTestId('record-history')).toHaveCount(0);        // the agency may not read the log

      await page.evaluate(() => localStorage.clear());                       // sign out
      await signIn(page, 'admin@example.com');
      await page.goto(`./#/suedwind.products/${SW_2002}`);
      await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue(name);
      const first = page.getByTestId('record-history').getByTestId('history-row').first();
      await expect(first.getByTestId('history-who')).toContainText('agentur.suedwind@example.com');
      await expect(first).toContainText(`name: ${original} → ${name}`);
      await page.getByTestId('record-history').scrollIntoViewIfNeeded();
      await shot(page, 'record-history');

      await page.goto(`./#/suedwind.products/${SW_2002}/show`);               // the read-only view has it, too
      await expect(page.getByTestId('record-history').getByTestId('history-row').first()).toContainText(name);
    } finally {
      await rest(tokenSw, 'PATCH', 'suedwind', `products?id=eq.${SW_2002}`, { name: original });
    }
  });
});

test.describe('admin API guards (/cms/api/admin/*)', () => {
  const endpoints = [['/invite', { email: 'nobody@example.test' }], [`/users/${NW_ID}/block`, {}], [`/users/${NW_ID}/unblock`, {}], [`/users/${NW_ID}/resend`, {}]];
  const post = (request, path, token, data) => request.post(api(path), { data, headers: token ? { Authorization: `Bearer ${token}` } : {} });

  test('non-admins get 403 on every endpoint, with real tokens', async ({ request }) => {
    for (const who of ['agentur.nordwind@example.com', 'hr@example.com', 'ohne.rolle@example.com']) {
      const token = await tokenFor(who);
      for (const [path, data] of endpoints) {
        const r = await post(request, path, token, data);
        expect(r.status(), `${who} ${path}`).toBe(403);
        expect((await r.json()).error).toBe('not_admin');
      }
    }
  });

  test('no token, forged, expired and junk tokens get 401', async ({ request }) => {
    const base = { sub: ADMIN_ID, role: 'cms_admin', email: 'admin@example.com' };
    const tokens = {
      none: undefined,
      junk: 'abc.def.ghi',
      expired: mintToken({ ...base, expiresInSeconds: -120 }),                 // valid signature, expired
      foreignKey: mintToken({ ...base, kind: 'foreign' }),                     // admin claims, signed by someone else
      hs256: mintToken({ ...base, kind: 'hs256' }),
      algNone: mintToken({ ...base, kind: 'none' }),
      wrongIssuer: mintToken({ ...base, iss: 'http://evil.example/auth/v1' }),
      wrongAudience: mintToken({ ...base, aud: 'service' }),
    };
    for (const [name, token] of Object.entries(tokens)) {
      for (const [path, data] of endpoints) {
        const r = await post(request, path, token, data);
        expect(r.status(), `${name} ${path}`).toBe(401);
      }
    }
  });

  test('a validly signed, fresh token of an admin passes the gate (control for the 401 cases)', async ({ request }) => {
    const token = mintToken({ sub: ADMIN_ID, role: 'cms_admin', email: 'admin@example.com' });
    const r = await post(request, `/users/${ADMIN_ID}/block`, token, {});
    expect(r.status()).toBe(409);            // refused only because nobody may block themselves
    expect((await r.json()).error).toBe('self');
  });

  test('responses never contain the service key', async ({ request }) => {
    const secrets = SERVICE_SECRETS();
    const token = await tokenFor('admin@example.com');
    const bodies = [];
    for (const [path, data] of [['/invite', { email: 'nope' }], [`/users/${ADMIN_ID}/block`, {}], ['/nowhere', {}]]) {
      const r = await post(request, path, token, data);
      bodies.push(await r.text(), JSON.stringify(r.headers()));
    }
    bodies.push(await (await request.get('config.json')).text());
    for (const b of bodies) for (const s of secrets) expect(b.includes(s)).toBe(false);
  });
});

test.describe('service key and the browser bundle', () => {
  test('no secret value is in apps/ui/dist', () => {
    const dist = fileURLToPath(new URL('../dist', import.meta.url));
    const files = [];
    const walk = (d) => readdirSync(d).forEach((f) => { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); });
    walk(dist);
    expect(files.length).toBeGreaterThan(0);
    const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    const d = JSON.parse(env.JWT_KEYS).find((k) => k.d).d;
    const secrets = [...SERVICE_SECRETS(), d, env.TEST_USER_PASSWORD, env.POSTGRES_PASSWORD].filter((v) => v && v.length > 8);
    expect(secrets.length).toBeGreaterThan(3);
    for (const s of secrets) expect(text.includes(s)).toBe(false);          // value comparison, nothing printed
    expect(/sb_secret_[A-Za-z0-9_-]{10,}/.test(text)).toBe(false);
  });
});
