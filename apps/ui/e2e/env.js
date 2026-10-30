// Test helpers: repo .env (URLs, anon key, test password — never printed), login, REST with a user token.
import { readFileSync } from 'node:fs';

export function readEnv() {
  const text = readFileSync(new URL('../../../.env', import.meta.url), 'utf8');
  return Object.fromEntries(text.split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));
}

const env = readEnv();
export const GW = env.SUPABASE_PUBLIC_URL;

/** Signs in through the UI's login form. */
export async function signIn(page, email) {
  await page.goto('./');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Password').fill(env.TEST_USER_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByTestId('role').waitFor();
}

/** Access token for a test user, straight from Supabase Auth (for API-level checks). */
export async function tokenFor(email, password = env.TEST_USER_PASSWORD) {
  const r = await fetch(`${GW}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`login ${email}: HTTP ${r.status}`);
  return (await r.json()).access_token;
}

/** PostgREST call with the person's token, like the UI makes it. */
export async function rest(token, method, schema, path, body) {
  const r = await fetch(`${GW}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: env.ANON_KEY, Authorization: `Bearer ${token}`, 'Accept-Profile': schema, 'Content-Profile': schema,
      'Content-Type': 'application/json', Prefer: 'return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, json };
}

// ── helpers for the admin tests ────────────────────────────────────────────────────────────────
// They use the stack's service key and signing key straight from .env, like a developer would with psql.
// Test code only: nothing here is served, bundled or printed.
import { createPrivateKey, generateKeyPairSync, randomBytes, sign as cryptoSign, createHmac } from 'node:crypto';

const b64u = (b) => Buffer.from(b).toString('base64url');

/** A signed JWT. kind: 'stack' (the stack's ES256 key = valid signature), 'foreign' (another EC key, same kid), 'hs256' (random secret), 'none'. */
export function mintToken({ kind = 'stack', sub, role, email, expiresInSeconds = 300, iss = `${GW}/auth/v1`, aud = 'authenticated' }) {
  const keys = JSON.parse(env.JWT_KEYS);
  const ec = keys.find((k) => k.kty === 'EC' && k.d);
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub, role, email, aud, iss, iat: now, exp: now + expiresInSeconds };
  const header = { alg: kind === 'hs256' ? 'HS256' : kind === 'none' ? 'none' : 'ES256', typ: 'JWT', kid: ec.kid };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  if (kind === 'none') return `${input}.`;
  if (kind === 'hs256') return `${input}.${createHmac('sha256', randomBytes(32)).update(input).digest('base64url')}`;
  const key = kind === 'foreign' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey : createPrivateKey({ key: ec, format: 'jwk' });
  return `${input}.${cryptoSign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

/** GoTrue admin API with the service key (test setup and clean-up of throwaway people only). */
export async function authAdmin(method, path, body) {
  const r = await fetch(`${GW}/auth/v1/admin${path}`, {
    method, headers: { apikey: env.SUPABASE_SECRET_KEY, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}

export async function findUserId(email) {
  const r = await authAdmin('GET', '/users?per_page=200');
  return r.json.users.find((u) => u.email === email)?.id ?? null;
}

/** Deletes a throwaway person (and with them their role mapping). */
export async function deleteUser(email) {
  const id = await findUserId(email);
  if (id) await authAdmin('DELETE', `/users/${id}`);
}

export const SERVICE_SECRETS = () => [env.SUPABASE_SECRET_KEY, env.SERVICE_ROLE_KEY, env.SERVICE_ROLE_KEY_ASYMMETRIC, env.JWT_SECRET, env.SECRET_KEY_BASE]
  .filter((v) => v && v.length > 12);

// ── throwaway people (MFA, invite, recovery tests): created and removed through the GoTrue admin API ──
// Local stack only. The service key is read from the repo .env and used here, never in the UI or in a log.
const adminHdr = () => ({ apikey: env.SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' });
export async function admin(method, path, body) {
  const r = await fetch(`${GW}/auth/v1/admin/${path}`, { method, headers: adminHdr(), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, json };
}

export const throwawayEmail = (tag) => `e2e-${tag}-${Date.now().toString(36)}@example.com`;

export async function createUser(email, password = env.TEST_USER_PASSWORD) {
  const { status, json } = await admin('POST', 'users', { email, password, email_confirm: true });
  if (status >= 300) throw new Error(`create ${email}: HTTP ${status} ${JSON.stringify(json)}`);
  return json.id;
}

/** Deletes the person by e-mail (their MFA factors and sessions go with them). Safe to call twice. */
export async function deleteUserByEmail(email) {
  for (let page = 1; page < 20; page++) {
    const { json } = await admin('GET', `users?page=${page}&per_page=200`);
    const users = json?.users ?? [];
    const hit = users.find((u) => u.email === email);
    if (hit) { await admin('DELETE', `users/${hit.id}`); return true; }
    if (users.length < 200) return false;
  }
  return false;
}

/**
 * What the mail would contain, without any mail: GoTrue's generate_link makes the same token. Following its verify URL
 * gives the redirect Supabase Auth sends the browser to; the session is in the fragment ("#access_token=…&type=…").
 * Returns that fragment (without "#").
 */
export async function linkFragment(type, email, extra = {}) {
  const { status, json } = await admin('POST', 'generate_link', { type, email, ...extra });
  if (status >= 300) throw new Error(`generate_link ${type}: HTTP ${status} ${JSON.stringify(json)}`);
  const r = await fetch(json.action_link, { redirect: 'manual' });
  const loc = r.headers.get('location') ?? '';
  const i = loc.indexOf('#');
  if (i < 0) throw new Error(`verify gave no fragment: HTTP ${r.status} ${loc.replace(/access_token=[^&]+/, 'access_token=…')}`);
  return loc.slice(i + 1);
}

// ── TOTP (RFC 6238, SHA-1, 30 s, 6 digits) ───────────────────────────────────────────────────
function base32(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, '0');
  return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
}
/** The code for `secret` at the current time step plus `steps` (GoTrue accepts ±1 step). */
export function totp(secret, steps = 0, now = Date.now()) {
  const counter = Math.floor(now / 30000) + steps;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}

export const claimsOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
