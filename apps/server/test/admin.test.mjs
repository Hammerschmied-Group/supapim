// Admin API against a fake Supabase (JWKS, PostgREST whoami, Auth admin API), no stack needed:
// node --test apps/server/test. Proves the gate order (token → database says admin → only then the key),
// the status codes, and that the service key never shows up in a response or in the log.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { registerAdmin } from '../src/admin/index.mjs';
import { adminLogLine } from '../src/admin/log.mjs';

const KEY = 'sb_secret_TESTONLY_0123456789abcdef';
const ISS = 'http://fake.test/auth/v1';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const { publicKey, privateKey } = await generateKeyPair('ES256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
const stranger = await generateKeyPair('ES256');

const sign = (claims = {}, { key = privateKey, kid = 'k1', iss = ISS, aud = 'authenticated', exp = '5m' } = {}) =>
  new SignJWT({ role: 'cms_admin', email: 'admin@example.com', ...claims }).setProtectedHeader({ alg: 'ES256', kid })
    .setSubject(claims.sub ?? ADMIN).setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(exp).sign(key);

// fake Supabase
const fake = { whoami: { status: 200, body: {} }, authCalls: [], users: {} };
const supa = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c); req.on('end', () => {
    const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/auth/v1/.well-known/jwks.json') return send(200, { keys: [jwk] });
    if (req.url === '/rest/v1/rpc/whoami') return send(fake.whoami.status, fake.whoami.body);
    fake.authCalls.push({ method: req.method, url: req.url, apikey: req.headers.apikey, body });
    if (req.url.split('?')[0] === '/auth/v1/invite') return send(200, { id: OTHER, email: JSON.parse(body).email, invited_at: 'now' });
    if (req.url === '/auth/v1/admin/generate_link') return send(200, { id: OTHER, email: JSON.parse(body).email, invited_at: 'now', action_link: 'http://fake.test/verify?token=abc&type=invite' });
    const m = /^\/auth\/v1\/admin\/users\/([^/]+)$/.exec(req.url);
    if (m && req.method === 'GET') return fake.users[m[1]] ? send(200, fake.users[m[1]]) : send(404, { error_code: 'user_not_found', msg: 'User not found' });
    if (m && req.method === 'PUT') return send(200, { ...fake.users[m[1]], banned_until: JSON.parse(body).ban_duration === 'none' ? null : '2126-01-01T00:00:00Z' });
    send(404, {});
  });
});
await new Promise((r) => supa.listen(0, '127.0.0.1', r));
const SUPA = `http://127.0.0.1:${supa.address().port}`;

const opened = [];
async function start(env = {}) {
  const app = express();
  const info = registerAdmin(app, { supabaseUrl: SUPA, anonKey: 'anon-public', issuer: ISS, jwksUrl: `${SUPA}/auth/v1/.well-known/jwks.json` },
    { SUPABASE_SECRET_KEY: KEY, ...env });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/cms/api/admin`;
  opened.push(srv);
  return { info, base, close: () => {} };
}

// run fn while capturing everything written to stdout
async function withLog(fn) {
  const lines = []; const orig = process.stdout.write;
  process.stdout.write = (c, ...a) => { lines.push(String(c)); return true; };
  try { return { result: await fn(), lines }; } finally { process.stdout.write = orig; }
}

const call = async (base, path, { token, body, method = 'POST', headers = {} } = {}) => {
  const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};

const isAdmin = () => { fake.whoami = { status: 200, body: { is_admin: true, user_id: ADMIN, email: 'admin@example.com', role: 'cms_admin' } }; };
const notAdmin = () => { fake.whoami = { status: 200, body: { is_admin: false, user_id: ADMIN, email: 'admin@example.com', role: 'cms_admin' } }; };

test('no token, junk, expired, forged, wrong issuer/audience → 401 and the key is never used', async () => {
  isAdmin(); fake.authCalls.length = 0;
  const s = await start({ CMS_ADMIN_INVITE_DELIVERY: 'link' });
  const bad = {
    'no token': undefined, 'junk': 'not.a.jwt', 'expired': await sign({}, { exp: Math.floor(Date.now() / 1000) - 60 }),
    'forged signature (other key, same kid)': await sign({}, { key: stranger.privateKey }),
    'unknown kid': await sign({}, { kid: 'zzz' }), 'wrong issuer': await sign({}, { iss: 'http://evil.test/auth/v1' }),
    'wrong audience': await sign({}, { aud: 'someone-else' }), 'service_role token': await sign({ role: 'service_role' }),
  };
  const { lines } = await withLog(async () => {
    for (const [name, token] of Object.entries(bad)) {
      for (const path of ['/invite', `/users/${OTHER}/block`]) {
        const r = await call(s.base, path, { token, body: { email: 'x@example.com' } });
        assert.equal(r.status, 401, `${name} ${path}`);
        assert.ok(!r.text.includes(KEY));
      }
    }
  });
  assert.equal(fake.authCalls.length, 0, 'the Auth admin API was called without an approved admin');
  assert.ok(lines.every((l) => !l.includes(KEY)));
  s.close();
});

test('an admin\'s OAuth client token (MCP) → 403 before the database is asked; the key is never used', async () => {
  isAdmin(); fake.authCalls.length = 0;
  const s = await start({ CMS_ADMIN_INVITE_DELIVERY: 'link' });
  const token = await sign({ client_id: '33333333-3333-4333-8333-333333333333' });
  for (const path of ['/invite', `/users/${OTHER}/block`]) {
    const r = await call(s.base, path, { token, body: { email: 'x@example.com' } });
    assert.equal(r.status, 403, path);
    assert.equal(r.json.error, 'oauth_client_token');
  }
  assert.equal(fake.authCalls.length, 0);
  s.close();
});

test('valid token but the DATABASE says not admin → 403 (the role claim alone is not enough)', async () => {
  notAdmin(); fake.authCalls.length = 0;
  const s = await start();
  const token = await sign({ role: 'cms_admin' });          // claim says cms_admin …
  const { result: r, lines } = await withLog(() => call(s.base, '/invite', { token, body: { email: 'x@example.com' } }));
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'not_admin');
  assert.equal(fake.authCalls.length, 0);
  const log = JSON.parse(lines.find((l) => l.includes('admin_access')));
  assert.equal(log.email, 'admin@example.com'); assert.equal(log.status, 403);
  // whoami answering for another subject than the token's → also refused
  fake.whoami = { status: 200, body: { is_admin: true, user_id: OTHER, email: 'x@example.com', role: 'cms_admin' } };
  assert.equal((await call(s.base, '/invite', { token, body: { email: 'x@example.com' } })).status, 403);
  // PostgREST rejecting the token → 401, database down → 502
  fake.whoami = { status: 401, body: { message: 'JWT expired' } };
  assert.equal((await call(s.base, '/invite', { token, body: { email: 'x@example.com' } })).status, 401);
  fake.whoami = { status: 500, body: {} };
  assert.equal((await call(s.base, '/invite', { token, body: { email: 'x@example.com' } })).status, 502);
  assert.equal(fake.authCalls.length, 0);
  s.close();
});

test('admin: invite (link), resend, block, unblock; logged with the admin e-mail; key only towards Auth', async () => {
  isAdmin(); fake.authCalls.length = 0;
  fake.users[OTHER] = { id: OTHER, email: 'new@example.com', invited_at: '2026-10-28T00:00:00Z' };
  const s = await start({ CMS_ADMIN_INVITE_DELIVERY: 'link' });
  const token = await sign();
  const { result, lines } = await withLog(async () => ({
    invite: await call(s.base, '/invite', { token, body: { email: ' New@Example.com ' } }),
    resend: await call(s.base, `/users/${OTHER}/resend`, { token }),
    block: await call(s.base, `/users/${OTHER}/block`, { token }),
    unblock: await call(s.base, `/users/${OTHER}/unblock`, { token }),
    self: await call(s.base, `/users/${ADMIN}/block`, { token }),
    badEmail: await call(s.base, '/invite', { token, body: { email: 'nope' } }),
    badId: await call(s.base, '/users/xyz/resend', { token }),
    unknown: await call(s.base, '/nowhere', { token }),
  }));
  assert.equal(result.invite.status, 200);
  assert.equal(result.invite.json.user.email, 'new@example.com');          // trimmed + lower-cased
  assert.match(result.invite.json.action_link, /token=abc/);
  assert.equal(result.resend.status, 200);
  assert.equal(result.block.json.user.banned_until, '2126-01-01T00:00:00Z');
  assert.equal(result.unblock.json.user.banned_until, null);
  assert.equal(result.self.status, 409);
  assert.equal(result.badEmail.status, 400); assert.equal(result.badId.status, 400); assert.equal(result.unknown.status, 404);
  // the key reached only the Auth admin API, as apikey
  assert.ok(fake.authCalls.length >= 5 && fake.authCalls.every((c) => c.apikey === KEY));
  for (const r of Object.values(result)) if (r) assert.ok(!r.text.includes(KEY), 'key in a response');
  const log = lines.filter((l) => l.includes('admin_access'));
  assert.ok(log.length === 7 && log.every((l) => !l.includes(KEY) && !l.includes(token) && !l.includes('token=abc')), 'key, token or link in the log');
  const inv = JSON.parse(log[0]);
  assert.deepEqual([inv.email, inv.action, inv.target, inv.status, inv.delivery], ['admin@example.com', 'invite', 'new@example.com', 200, 'link']);
  s.close();
});

test('resend refuses someone who has already signed in; mail mode never returns a link', async () => {
  isAdmin();
  fake.users[OTHER] = { id: OTHER, email: 'new@example.com', invited_at: 'x', last_sign_in_at: '2026-10-28T10:00:00Z', confirmed_at: 'x' };
  const s = await start();                                    // delivery: mail (default)
  assert.equal(s.info.delivery, 'mail');
  const token = await sign();
  assert.equal((await call(s.base, `/users/${OTHER}/resend`, { token })).status, 409);
  const r = await call(s.base, '/invite', { token, body: { email: 'new@example.com' } });
  assert.equal(r.status, 200); assert.equal(r.json.delivery, 'mail'); assert.equal(r.json.action_link, undefined);
  s.close();
});

test('without a service key every approved request is a 503; unapproved ones stay 401/403', async () => {
  isAdmin();
  const s = await start({ SUPABASE_SECRET_KEY: '' });
  assert.equal(s.info.configured, false);
  assert.equal((await call(s.base, '/invite', { token: await sign(), body: { email: 'a@b.co' } })).status, 503);
  assert.equal((await call(s.base, '/invite', { body: { email: 'a@b.co' } })).status, 401);
  s.close();
});

test('CMS_PUBLIC_UI_URL fixes where the invite lands; the Origin header no longer decides', async () => {
  isAdmin(); fake.authCalls.length = 0;
  const s = await start({ CMS_ADMIN_INVITE_DELIVERY: 'link', CMS_PUBLIC_UI_URL: 'https://cms.example.com/cms' });
  const r = await call(s.base, '/invite', { token: await sign(), body: { email: 'c@example.com' }, headers: { Origin: 'http://localhost:9' } });
  assert.equal(r.status, 200);
  const sent = fake.authCalls.find((c) => c.url.includes('generate_link'));
  assert.equal(JSON.parse(sent.body).redirect_to, 'https://cms.example.com/cms/');
  s.close();
});

test('log line: fixed field list, nothing else', () => {
  const l = JSON.parse(adminLogLine({ email: 'a@b.co', action: 'invite', status: 200, token: 'SECRET', body: 'SECRET', key: 'SECRET' }, new Date(0)));
  assert.deepEqual(Object.keys(l), ['type', 'ts', 'email', 'action', 'status']);
});

test.after(() => { for (const s of [...opened, supa]) { s.closeAllConnections(); s.close(); } });

test('the invite link lands on the UI (<origin>/cms/), not on SITE_URL\'s root; a bogus origin is not passed on', async () => {
  isAdmin();
  const token = await sign();
  for (const delivery of ['link', 'mail']) {
    fake.authCalls.length = 0;
    const s = await start({ CMS_ADMIN_INVITE_DELIVERY: delivery });
    assert.equal((await call(s.base, '/invite', { token, body: { email: 'a@example.com' }, headers: { Origin: 'http://localhost:55380' } })).status, 200);
    assert.equal((await call(s.base, '/invite', { token, body: { email: 'b@example.com' }, headers: { Origin: 'null' } })).status, 200);
    const [good, bogus] = fake.authCalls.filter((c) => c.url.includes('invite') || c.url.includes('generate_link'));
    if (delivery === 'link') {
      assert.equal(JSON.parse(good.body).redirect_to, 'http://localhost:55380/cms/');
      assert.equal(JSON.parse(bogus.body).redirect_to, undefined);
    } else {
      assert.equal(new URL(good.url, SUPA).searchParams.get('redirect_to'), 'http://localhost:55380/cms/');
      assert.equal(new URL(bogus.url, SUPA).searchParams.get('redirect_to'), null);
    }
    s.close();
  }
});
