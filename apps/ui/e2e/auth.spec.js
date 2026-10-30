// Sign-in, TOTP-MFA, invite / recovery / magic-link callbacks, the MCP consent page — against the running stack.
//
// People: MFA and link tests use throwaway users created through the GoTrue admin API and deleted afterwards. The demo
// users are only used for the plain password login and the consent page; no factor is ever added to them.
//
// What needs the override applied (docker-compose.override.yml: Mailpit + GoTrue SMTP) is marked test.skip with the reason;
// see "Mail-based flows" at the end. The callback side of magic link, invite and recovery does not need mail: GoTrue's
// generate_link makes the same token, and its verify URL gives the redirect the mail link would lead to.
import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  admin, claimsOf, createUser, deleteUserByEmail, linkFragment, readEnv, signIn, throwawayEmail, tokenFor, totp,
} from './env.js';

const env = readEnv();
const GW = env.SUPABASE_PUBLIC_URL;
const sessionToken = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('supabase-cms-auth') ?? 'null')?.access_token ?? null);
const logout = async (page) => {
  await page.getByRole('button', { name: 'Profile' }).click();
  await page.getByRole('menuitem', { name: 'Logout' }).click();
  await expect(page.getByLabel('Password')).toBeVisible();
};

test('a wrong password is refused with a message, a demo user gets in', async ({ page }) => {
  await page.goto('./');
  await page.getByLabel('E-mail').fill('admin@example.com');
  await page.getByLabel('Password').fill('definitely-not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('E-mail or password is wrong');
  await expect(page.getByTestId('role')).toHaveCount(0);
  await page.getByLabel('Password').fill(env.TEST_USER_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('role')).toContainText('admin');
});

test('pages behind the login are closed to people who are not signed in', async ({ page }) => {
  await page.goto('./#/security');
  await expect(page.getByLabel('Password')).toBeVisible();
  await page.goto('./#/nordwind.products');
  await expect(page.getByLabel('Password')).toBeVisible();
});

test('logging out ends only this browser\'s session', async ({ page }) => {
  await signIn(page, 'hr@example.com');
  const other = await tokenFor('hr@example.com');               // a second session of the same person (like an MCP client's)
  await logout(page);
  const { refresh_token } = await (await fetch(`${GW}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: env.ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'hr@example.com', password: env.TEST_USER_PASSWORD }) })).json();
  const refreshed = await fetch(`${GW}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST', headers: { apikey: env.ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token }) });
  expect(other).toBeTruthy();
  expect(refreshed.status, 'a session created before the UI logout still refreshes').toBe(200);
});

// ── TOTP ───────────────────────────────────────────────────────────────────────────────────────
test.describe('TOTP-MFA (throwaway person)', () => {
  test.describe.configure({ mode: 'serial' });
  const email = throwawayEmail('mfa');
  test.beforeAll(async () => { await createUser(email); });
  test.afterAll(async () => { await deleteUserByEmail(email); });

  let secret;

  test('set up in the Security page, the session becomes AAL2', async ({ page }) => {
    await signIn(page, email);
    await page.getByRole('menuitem', { name: 'Security' }).click();
    await page.getByRole('button', { name: 'Set up authenticator app' }).click();
    await expect(page.getByAltText('QR code for the authenticator app')).toBeVisible();
    secret = (await page.getByTestId('totp-secret').textContent()).trim();
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
    await page.getByLabel('Authentication code').fill('000000');
    await page.getByRole('button', { name: 'Verify and turn on' }).click();
    await expect(page.getByRole('alert')).toContainText('wrong or has expired');         // a wrong code does not enable it
    await page.getByLabel('Authentication code').fill(totp(secret));
    await page.getByRole('button', { name: 'Verify and turn on' }).click();
    await expect(page.getByTestId('security-done')).toContainText('Two-factor authentication is on');
    await expect(page.getByTestId('mfa-enabled')).toBeVisible();
    expect(claimsOf(await sessionToken(page)).aal).toBe('aal2');
  });

  test('signing in asks for the code; a wrong code is refused; an AAL1 session does not open the app', async ({ page }) => {
    await page.goto('./');
    await page.getByLabel('E-mail').fill(email);
    await page.getByLabel('Password').fill(env.TEST_USER_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByLabel('Authentication code')).toBeVisible();
    await expect(page.getByTestId('role')).toHaveCount(0);
    expect(claimsOf(await sessionToken(page)).aal, 'password alone gives AAL1').toBe('aal1');

    // reload with the AAL1 session: back to the login page, not into the app
    await page.reload();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByTestId('role')).toHaveCount(0);

    await page.getByLabel('E-mail').fill(email);
    await page.getByLabel('Password').fill(env.TEST_USER_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByLabel('Authentication code').fill('000000');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByRole('alert')).toContainText('wrong or has expired');
    await expect(page.getByTestId('role')).toHaveCount(0);
    await page.getByLabel('Authentication code').fill(totp(secret, 1));
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByTestId('role')).toBeVisible();
    const claims = claimsOf(await sessionToken(page));
    expect(claims.aal).toBe('aal2');
    expect(claims.amr.map((a) => a.method)).toEqual(expect.arrayContaining(['password', 'totp']));
    expect(claims.email).toBe(email);
  });

  test('turning it off needs AAL2 and returns to password-only sign-in', async ({ page }) => {
    await page.goto('./');
    await page.getByLabel('E-mail').fill(email);
    await page.getByLabel('Password').fill(env.TEST_USER_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByLabel('Authentication code').fill(totp(secret, -1));
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByTestId('role')).toBeVisible();
    await page.getByRole('menuitem', { name: 'Security' }).click();
    await page.getByRole('button', { name: 'Turn off' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Turn off' }).click();
    await expect(page.getByTestId('security-done')).toContainText('is off');
    await logout(page);
    await signIn(page, email);                                    // password only, no code prompt
  });
});

// ── links: callbacks of magic link, recovery and invitation ─────────────────────────────────────
test.describe('links (throwaway people, no mail needed)', () => {
  const emails = [];
  const fresh = async (tag, create = true) => { const e = throwawayEmail(tag); emails.push(e); if (create) await createUser(e); return e; };
  test.afterAll(async () => { for (const e of emails) await deleteUserByEmail(e); });

  test('magic link: the session is taken from the URL, the tokens leave the address bar', async ({ page }) => {
    const email = await fresh('magic');
    const fragment = await linkFragment('magiclink', email);
    await page.goto(`./#${fragment}`);
    await expect(page.getByTestId('role')).toBeVisible();
    expect(page.url()).not.toContain('access_token');
    expect(page.url()).not.toContain('refresh_token');
    expect(claimsOf(await sessionToken(page)).email).toBe(email);
  });

  test('a link that failed or expired shows its message on the login page', async ({ page }) => {
    await page.goto('./#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    await expect(page.getByRole('alert')).toContainText('Email link is invalid or has expired');
    expect(page.url()).not.toContain('error_description');
  });

  test('recovery: choose a new password, then it is the one that works', async ({ page }) => {
    const email = await fresh('recovery');
    const fragment = await linkFragment('recovery', email);
    await page.goto(`./#${fragment}`);
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    await page.getByLabel(/^New password/).fill('Another-Pass-1234');
    await page.getByLabel('Confirm password').fill('Different-Pass-1234');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert')).toContainText('do not match');
    await page.getByLabel('Confirm password').fill('Another-Pass-1234');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('role')).toBeVisible();
    expect(await tokenFor(email, 'Another-Pass-1234')).toBeTruthy();
    await expect(tokenFor(email)).rejects.toThrow();               // the old password is gone
  });

  test('invitation: nobody is signed in until the password is chosen', async ({ page }) => {
    const email = await fresh('invite', false);
    const fragment = await linkFragment('invite', email);          // creates the invited person
    await page.goto(`./#${fragment}`);
    await expect(page.getByRole('heading', { name: 'Welcome — choose a password' })).toBeVisible();
    expect(await sessionToken(page), 'the invite token alone must not sign the person in').toBeNull();
    await page.getByLabel(/^New password/).fill('Invited-Pass-1234');
    await page.getByLabel('Confirm password').fill('Invited-Pass-1234');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('role')).toBeVisible();
    expect(await tokenFor(email, 'Invited-Pass-1234')).toBeTruthy();
  });

  test('an incomplete set-password link says so', async ({ page }) => {
    await page.goto('./#/set-password');
    await expect(page.getByRole('alert')).toContainText('incomplete or has expired');
  });
});

// ── MCP consent page ────────────────────────────────────────────────────────────────────────────
test.describe('MCP consent page (same session as the UI)', () => {
  test.describe.configure({ mode: 'serial' });   // the second test relies on the consent given in the first
  const REDIRECT = 'http://localhost:53999/callback';
  let clientId;
  test.beforeAll(async () => {
    const as = await (await fetch(`${GW}/.well-known/oauth-authorization-server/auth/v1`)).json();
    const reg = await (await fetch(as.registration_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'E2E Consent Client', redirect_uris: [REDIRECT], grant_types: ['authorization_code'],
        response_types: ['code'], token_endpoint_auth_method: 'none' }) })).json();
    clientId = reg.client_id;
    test.info().annotations.push({ type: 'client', description: 'registered, deleted afterwards' });
    globalThis.__as = as;
  });
  test.afterAll(async () => { if (clientId) await admin('DELETE', `oauth/clients/${clientId}`); });

  /** A fresh authorization request, as Claude / ChatGPT would start it. Returns the id from the consent redirect. */
  async function authorization(state) {
    const u = new URL(globalThis.__as.authorization_endpoint);
    Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: 'c'.repeat(43),
      code_challenge_method: 'S256', state, scope: 'openid email' }).forEach(([k, v]) => u.searchParams.set(k, v));
    const r = await fetch(u, { redirect: 'manual' });
    const id = new URL(r.headers.get('location')).searchParams.get('authorization_id');
    expect(id).toBeTruthy();
    return id;
  }
  const stubCallback = (page) => page.route(`${REDIRECT}**`, (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: 'callback' }));

  test('signed out: sign in on the page, see who asks, allow → redirect with code and state', async ({ page }) => {
    await stubCallback(page);
    const id = await authorization('state-allow');
    await page.goto(`./#/consent?authorization_id=${id}`);
    await page.getByLabel('E-mail').fill('agentur.nordwind@example.com');
    await page.getByLabel('Password').fill(env.TEST_USER_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'E2E Consent Client wants access' })).toBeVisible();
    await expect(page.getByTestId('consent-user')).toHaveText('agentur.nordwind@example.com');
    await expect(page.getByTestId('consent-role')).toHaveText('agency_nordwind');
    await expect(page.getByTestId('consent-redirect')).toHaveText(REDIRECT);
    await expect(page.getByTestId('consent-remote'), 'localhost: no warning').toHaveCount(0);
    await page.getByRole('button', { name: 'Allow' }).click();
    await page.waitForURL(/localhost:53999\/callback/);
    const cb = new URL(page.url());
    expect(cb.searchParams.get('state')).toBe('state-allow');
    expect(cb.searchParams.get('code')).toBeTruthy();
  });

  test('already consented to this client: straight back to it, no question', async ({ page }) => {
    await stubCallback(page);
    await signIn(page, 'agentur.nordwind@example.com');
    const id = await authorization('state-again');
    await page.goto(`./#/consent?authorization_id=${id}`);
    await page.waitForURL(/localhost:53999\/callback/);
    const cb = new URL(page.url());
    expect(cb.searchParams.get('state')).toBe('state-again');
    expect(cb.searchParams.get('code')).toBeTruthy();
  });

  test('signed in to the UI already: only the question; deny → access_denied', async ({ page }) => {
    await stubCallback(page);
    await signIn(page, 'hr@example.com');
    const id = await authorization('state-deny');
    await page.goto(`./#/consent?authorization_id=${id}`);
    await expect(page.getByLabel('Password')).toHaveCount(0);       // same session: no second login
    await expect(page.getByRole('heading', { name: 'E2E Consent Client wants access' })).toBeVisible();
    await expect(page.getByTestId('consent-role')).toHaveText('hr_editor');
    await page.getByRole('button', { name: 'Deny' }).click();
    await page.waitForURL(/localhost:53999\/callback/);
    const cb = new URL(page.url());
    expect(cb.searchParams.get('error')).toBe('access_denied');
    expect(cb.searchParams.get('state')).toBe('state-deny');
  });

  test('a program that sends the access to another machine is named with a warning (any program can register itself)', async ({ page }) => {
    const remote = 'https://consent-check.example/callback';
    const reg = await (await fetch(globalThis.__as.registration_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'E2E Remote Client', redirect_uris: [remote], grant_types: ['authorization_code'],
        response_types: ['code'], token_endpoint_auth_method: 'none' }) })).json();
    try {
      const u = new URL(globalThis.__as.authorization_endpoint);
      Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: remote, code_challenge: 'c'.repeat(43),
        code_challenge_method: 'S256', state: 's', scope: 'openid' }).forEach(([k, v]) => u.searchParams.set(k, v));
      const id = new URL((await fetch(u, { redirect: 'manual' })).headers.get('location')).searchParams.get('authorization_id');
      await signIn(page, 'hr@example.com');
      await page.goto(`./#/consent?authorization_id=${id}`);
      await expect(page.getByTestId('consent-remote')).toContainText('consent-check.example');
    } finally {
      await admin('DELETE', `oauth/clients/${reg.client_id}`);
    }
  });

  test('a link without authorization_id, and one that does not exist, show an error', async ({ page }) => {
    await page.goto('./#/consent');
    await page.getByLabel('E-mail').waitFor({ state: 'detached' }).catch(() => {});
    await expect(page.getByRole('alert')).toContainText('authorization_id is missing');
    await signIn(page, 'hr@example.com');
    await page.goto('./#/consent?authorization_id=does-not-exist');
    await expect(page.getByRole('alert')).toContainText('could not be loaded');
  });
});

// ── MCP consent with a second factor (install.sql step 4, docs/security/findings.md F-01) ───────────────────────────
// OAuth tokens are aal1. The page confirms the client with the aal2 session, so the client's tokens carry the role;
// a password alone gets a token without it.
test.describe('MCP consent page, person with a second factor', () => {
  test.describe.configure({ mode: 'serial' });
  const REDIRECT = 'http://localhost:53996/callback';
  const email = throwawayEmail('mfa-consent');
  let clientId; let secret;
  const sql = (q) => execFileSync('docker', ['exec', '-i', 'supabase-db', 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres', '-c', q], { encoding: 'utf8' }).trim();
  const H = (t) => ({ apikey: env.ANON_KEY, Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

  test.beforeAll(async () => {
    const id = await createUser(email);
    sql(`insert into cms.user_roles (user_id, db_role, granted_by) values ('${id}', 'agency_suedwind', 'e2e')`);
    const t = await tokenFor(email);
    const f = await (await fetch(`${GW}/auth/v1/factors`, { method: 'POST', headers: H(t), body: JSON.stringify({ factor_type: 'totp', friendly_name: 'e2e' }) })).json();
    const ch = await (await fetch(`${GW}/auth/v1/factors/${f.id}/challenge`, { method: 'POST', headers: H(t), body: '{}' })).json();
    const v = await fetch(`${GW}/auth/v1/factors/${f.id}/verify`, { method: 'POST', headers: H(t), body: JSON.stringify({ challenge_id: ch.id, code: totp(f.totp.secret) }) });
    expect(v.status).toBe(200);
    secret = f.totp.secret;
    const reg = await (await fetch(`${GW}/auth/v1/oauth/clients/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'E2E MFA Client', redirect_uris: [REDIRECT], grant_types: ['authorization_code'],
        response_types: ['code'], token_endpoint_auth_method: 'none' }) })).json();
    clientId = reg.client_id;
  });
  test.afterAll(async () => {
    if (clientId) await admin('DELETE', `oauth/clients/${clientId}`);
    await deleteUserByEmail(email);          // role row and MFA confirmation go with the person
  });

  test('sign in with the code, allow → the client\'s token carries the role', async ({ page }) => {
    await page.route(`${REDIRECT}**`, (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: 'callback' }));
    const verifier = randomBytes(32).toString('base64url');
    const u = new URL(`${GW}/auth/v1/oauth/authorize`);
    Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 'mfa', scope: 'openid email',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).forEach(([k, v]) => u.searchParams.set(k, v));
    const id = new URL((await fetch(u, { redirect: 'manual' })).headers.get('location')).searchParams.get('authorization_id');

    await page.goto(`./#/consent?authorization_id=${id}`);
    await page.getByLabel('E-mail').fill(email);
    await page.getByLabel('Password').fill(env.TEST_USER_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByLabel('Authentication code').fill(totp(secret, 1));
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByTestId('consent-role')).toHaveText('agency_suedwind');
    await page.getByRole('button', { name: 'Allow' }).click();
    await page.waitForURL(/localhost:53996\/callback/);

    const code = new URL(page.url()).searchParams.get('code');
    const tok = await (await fetch(`${GW}/auth/v1/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }) })).json();
    const claims = claimsOf(tok.access_token);
    expect(claims.aal, 'OAuth tokens are aal1').toBe('aal1');
    expect(claims.role, 'confirmed with the second factor on the page').toBe('agency_suedwind');
    expect(claimsOf(await tokenFor(email)).role, 'password alone: no role').toBe('authenticated');
  });
});

// ── Mail-based flows ─────────────────────────────────────────────────────────────────────────────
// Need the override applied: Mailpit as its own service (SMTP 55325, web 55326), GoTrue SMTP pointed at it, "/cms/" in the
// redirect allow list. Until then GoTrue has no mail server (SMTP_HOST=supabase-mail does not exist) and no allow-listed redirect.
const MAILPIT = `http://127.0.0.1:${process.env.CMS_MAILPIT_WEB_PORT ?? 55326}`;
const mailpitUp = async () => { try { return (await fetch(`${MAILPIT}/api/v1/info`)).ok; } catch { return false; } };

async function mailTo(email) {
  for (let i = 0; i < 30; i++) {
    const list = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
    if (list.messages?.length) {
      const msg = await (await fetch(`${MAILPIT}/api/v1/message/${list.messages[0].ID}`)).json();
      const link = /href="([^"]*\/auth\/v1\/verify[^"]*)"/.exec(msg.HTML)?.[1]?.replaceAll('&amp;', '&');
      if (link) return link;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no mail to ${email}`);
}

test.describe('Mail-based flows (Mailpit)', () => {
  test.beforeEach(async () => {
    test.skip(!(await mailpitUp()), `needs the docker-compose.override.yml change applied (Mailpit on ${MAILPIT}); written for the integration, not yet run`);
  });

  test('magic link: request on the login page, open the mailed link, signed in', async ({ page }) => {
    const email = throwawayEmail('maillink');
    await createUser(email);
    try {
      await page.goto('./');
      await page.getByLabel('E-mail').fill(email);
      await page.getByRole('button', { name: 'Email me a login link' }).click();
      await expect(page.getByTestId('link-sent')).toBeVisible();
      await page.goto(await mailTo(email));                            // verify URL → redirect to /cms/ with the session in the fragment
      await expect(page.getByTestId('role')).toBeVisible();
    } finally { await deleteUserByEmail(email); }
  });

  test('forgot password: mail → set-password page → new password works', async ({ page }) => {
    const email = throwawayEmail('mailreset');
    await createUser(email);
    try {
      await page.goto('./#/forgot-password');
      await page.getByLabel('E-mail').fill(email);
      await page.getByRole('button', { name: 'Send link' }).click();
      await expect(page.getByTestId('reset-sent')).toBeVisible();
      await page.goto(await mailTo(email));
      await page.getByLabel(/^New password/).fill('Mailed-Pass-1234');
      await page.getByLabel('Confirm password').fill('Mailed-Pass-1234');
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByTestId('role')).toBeVisible();
    } finally { await deleteUserByEmail(email); }
  });
});
