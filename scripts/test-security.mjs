#!/usr/bin/env node
// Security suite (Task 7, docs/security/): runs against the running stack, as an attacker and as each role would.
//   1. tokens     none, junk, tampered payload, anon key, service key, a signed-out session — at MCP, admin API, PostgREST
//   2. matrix     role × action over both channels: "UI" (what the UI sends: PostgREST + Storage with the session
//                 token, admin API) and "MCP" (tools/call with an OAuth token from dynamic client registration)
//   3. MFA        a person with a verified TOTP factor: password alone, OAuth via an aal1 consent, aal2, confirmed client
//   4. key        the service key never reaches the browser or the MCP data path: a local server with a canary key
//                 behind a recording proxy (MCP calls, config.json, admin calls), plus a grep of the UI bundle
//   5. web        CSP, frame-ancestors, nosniff, referrer, cache headers, CORS on admin API and MCP
// Known, accepted limitations are printed as INFO and do not fail the run (docs/security/findings.md).
//
// Test data: users sec-<run>-*@example.com (GoTrue admin API, like scripts/seed.sh), their role rows, one OAuth client
// sec-<run>, one object images/suedwind/sec-<run>.txt — all removed at the end. Row updates write the value already
// there, so no data changes. Prints no secrets.
// Usage: node scripts/test-security.mjs [--cms-url http://localhost:55380] [--admin-url <base>] [--canary-port 55385]
//   --admin-url  where /cms/api/admin/* answers; default: the gateway if it routes there (split deployment), else --cms-url

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';

const root = new URL('..', import.meta.url).pathname;
const env = Object.fromEntries(readFileSync(`${root}.env`, 'utf8').split('\n')
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));
const argOf = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };
const GW = env.SUPABASE_PUBLIC_URL;
const CMS = argOf('--cms-url') ?? `http://localhost:${env.CMS_MCP_PORT}`;
const CANARY_PORT = Number(argOf('--canary-port') ?? 55385);
// The admin API: its own service behind the gateway (split deployment, F-15), else the plugin container itself.
const answersAdmin = (base) => fetch(`${base}/cms/api/admin/invite`, { method: 'POST' })
  .then(async (r) => r.status === 401 && (await r.json().catch(() => null))?.error === 'missing_token').catch(() => false);
const ADMIN = argOf('--admin-url') ?? (!argOf('--cms-url') && await answersAdmin(GW) ? GW : CMS);
const ANON = env.ANON_KEY;
const SERVICE = env.SERVICE_ROLE_KEY;
const RUN = `sec-${Date.now().toString(36)}`;
const mail = (who) => `${RUN}-${who}@example.com`;

let failed = 0; let passed = 0;
const check = (ok, label, detail = '') => { ok ? passed++ : failed++; console.log(`   ${ok ? 'PASS' : '** FAIL **'}  ${label}${detail ? `  — ${detail}` : ''}`); return ok; };
const info = (label, detail = '') => console.log(`   INFO  ${label}${detail ? `  — ${detail}` : ''}`);
const step = (s) => console.log(`\n== ${s}`);
const claimsOf = (jwt) => { try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url')); } catch { return {}; } };
const sql = (q) => execFileSync('docker', ['exec', '-i', 'supabase-db', 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres', '-c', q], { encoding: 'utf8' }).trim();
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const json = async (r) => { const t = await r.text(); try { return t ? JSON.parse(t) : null; } catch { return t; } };

// ── HTTP helpers ────────────────────────────────────────────────────────────────────────────
const H = (token, extra = {}) => ({ apikey: ANON, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra });
async function rest(token, method, path, { profile, body, prefer } = {}) {
  const r = await fetch(`${GW}/rest/v1${path}`, { method, headers: H(token, {
    ...(profile ? { 'Accept-Profile': profile, 'Content-Profile': profile } : {}),
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(prefer ? { Prefer: prefer } : {}) }),
  body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await json(r) };
}
const rpc = (token, fn, args = {}) => rest(token, 'POST', `/rpc/${fn}`, { profile: 'cms_api', body: args });
async function storage(token, method, path, { body, headers = {} } = {}) {
  const r = await fetch(`${GW}/storage/v1${path}`, { method, headers: H(token, headers), body });
  return { status: r.status, body: await json(r) };
}
let rpcId = 0;
async function mcp(token, method, params, base = CMS) {
  const r = await fetch(`${base}/cms/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  return { status: r.status, body: await json(r) };
}
const tool = async (token, name, args, base) => {
  const r = await mcp(token, 'tools/call', { name, arguments: args }, base);
  const res = r.body?.result;
  const text = res?.content?.map((c) => c.text ?? '').join('\n') ?? '';
  let data = null; try { data = JSON.parse(res?.content?.[0]?.text ?? 'null'); } catch { /* not JSON */ }
  return { status: r.status, isError: !res || !!res.isError, data, text };
};
async function adminApi(token, path, body, base = ADMIN) {
  const r = await fetch(`${base}/cms/api/admin${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await json(r), headers: r.headers };
}
async function login(email, password) {
  const r = await fetch(`${GW}/auth/v1/token?grant_type=password`, { method: 'POST', headers: H(null, { 'Content-Type': 'application/json' }), body: JSON.stringify({ email, password }) });
  const j = await json(r);
  if (!r.ok) throw new Error(`sign-in ${email} failed: HTTP ${r.status} ${j?.error_code ?? ''}`);
  return j;
}
const authUser = async (token, method, path, body) => {
  const r = await fetch(`${GW}/auth/v1${path}`, { method, headers: H(token, { 'Content-Type': 'application/json' }), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await json(r) };
};

// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) for the MFA test person
function totp(secret, t = Date.now()) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) bits += A.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = createHmac('sha1', key).update(c).digest(); const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

// OAuth 2.1 like an MCP client: dynamic registration once, then authorize → consent (as the person) → code → token
let client;
async function oauthToken(sessionToken, { confirm = false } = {}) {
  const redirect = client.redirect_uris[0];
  const verifier = randomBytes(32).toString('base64url');
  const u = new URL(`${GW}/auth/v1/oauth/authorize`);
  Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, state: 's', scope: 'openid email profile',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).forEach(([k, v]) => u.searchParams.set(k, v));
  const a = await fetch(u, { redirect: 'manual' });
  const aid = new URL(a.headers.get('location'), GW).searchParams.get('authorization_id');
  const det = await authUser(sessionToken, 'GET', `/oauth/authorizations/${aid}`);
  if (confirm) {
    const c = await rpc(sessionToken, 'confirm_mfa_client', { authorization_id: aid });
    if (c.status !== 200) return { error: `confirm_mfa_client HTTP ${c.status} ${c.body?.message ?? ''}` };
  }
  let redirectUrl = det.body?.redirect_url;
  if (!det.body?.authorization_id && !redirectUrl) return { error: `authorization details HTTP ${det.status}` };
  if (det.body?.authorization_id) {
    const c = await authUser(sessionToken, 'POST', `/oauth/authorizations/${aid}/consent`, { action: 'approve' });
    redirectUrl = c.body?.redirect_url;
    if (!redirectUrl) return { error: `consent HTTP ${c.status}` };
  }
  const code = new URL(redirectUrl).searchParams.get('code');
  const t = await fetch(`${GW}/auth/v1/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier }) });
  const tj = await json(t);
  return t.ok ? { token: tj.access_token } : { error: `token HTTP ${t.status}` };
}

// ── test data ───────────────────────────────────────────────────────────────────────────────
const PEOPLE = { agency: 'agency_suedwind', hr: 'hr_editor', admin: 'cms_admin', norole: null, mfa: 'agency_suedwind' };
const users = {};
const password = `${randomBytes(12).toString('base64url')}-Aa1!`;
const OBJECT = `suedwind/${RUN}.txt`;

async function setup() {
  step(`setup: test people ${RUN}-*@example.com, OAuth client ${RUN}`);
  for (const [who, role] of Object.entries(PEOPLE)) {
    const r = await fetch(`${GW}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: mail(who), password, email_confirm: true }) });
    const u = await json(r);
    if (!r.ok) throw new Error(`creating ${who}: HTTP ${r.status}`);
    users[who] = { id: u.id, role };
    if (role) sql(`insert into cms.user_roles (user_id, db_role, granted_by) values (${lit(u.id)}, ${lit(role)}, 'test-security.mjs')`);
  }
  const reg = await fetch(`${GW}/auth/v1/oauth/clients/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: RUN, redirect_uris: ['http://localhost:53997/callback'], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none' }) });
  client = await json(reg);
  if (!client?.client_id) throw new Error(`client registration: HTTP ${reg.status}`);
  for (const who of ['agency', 'hr', 'admin', 'norole']) {
    users[who].session = (await login(mail(who), password)).access_token;
    const o = await oauthToken(users[who].session);
    if (o.error) throw new Error(`OAuth for ${who}: ${o.error}`);
    users[who].mcp = o.token;
  }
  console.log(`   ${Object.keys(PEOPLE).length} people, each with a UI session; agency/hr/admin/norole also with an MCP token`);
}

async function teardown() {
  step('teardown');
  try { await storage(SERVICE, 'DELETE', '/object/images', { body: JSON.stringify({ prefixes: [OBJECT] }), headers: { 'Content-Type': 'application/json', apikey: SERVICE } }); } catch { /* best effort */ }
  const ids = Object.values(users).map((u) => lit(u.id)).join(',');
  if (ids) {
    // the role assignments of the test people were logged (cms.user_roles history); they are test data, too
    sql(`delete from audit.change_log where table_name = 'cms.user_roles' and row_key ->> 'user_id' in (${ids})`);
    sql(`delete from auth.users where id in (${ids})`);           // cascades: sessions, factors, role rows, MFA confirmations
  }
  sql(`delete from auth.oauth_clients where client_name like ${lit(`${RUN}%`)}`);
  const left = sql(`select count(*) from auth.users where email like ${lit(`${RUN}-%`)}`);
  console.log(`   test people left: ${left}, OAuth clients left: ${sql(`select count(*) from auth.oauth_clients where client_name like ${lit(`${RUN}%`)}`)}`);
}

// ── 1. tokens ───────────────────────────────────────────────────────────────────────────────
async function tokens() {
  step('1. tokens that are not a valid person token → refused at MCP, admin API and PostgREST');
  const real = users.agency.mcp;
  const [h, p, s] = real.split('.');
  const tamperedPayload = Buffer.from(JSON.stringify({ ...claimsOf(real), role: 'cms_admin' })).toString('base64url');
  const flipped = s.slice(0, -2) + (s.at(-2) === 'A' ? 'B' : 'A') + s.at(-1);
  const cases = {
    'no token': null,
    'junk': 'not-a-jwt',
    'payload changed (role → cms_admin), signature kept': `${h}.${tamperedPayload}.${s}`,
    'signature changed': `${h}.${p}.${flipped}`,
    'anon key as bearer': ANON,
    'service key as bearer': SERVICE,
  };
  for (const [label, tok] of Object.entries(cases)) {
    const m = await mcp(tok, 'tools/list', {});
    const a = await adminApi(tok, '/invite', { email: mail('never') });
    check(m.status === 401 && a.status === 401, `${label}: MCP 401, admin API 401`, `MCP ${m.status}, admin ${a.status}`);
  }
  for (const label of ['payload changed (role → cms_admin), signature kept', 'signature changed']) {
    const r = await rpc(cases[label], 'whoami');
    check(r.status === 401, `${label}: PostgREST 401`, `HTTP ${r.status}`);
  }
  // after sign-out the access token lives until it expires (JWT_EXPIRY); only new tokens are refused
  const s2 = await login(mail('norole'), password);
  const out = await authUser(s2.access_token, 'POST', '/logout?scope=local');
  const after = await rpc(s2.access_token, 'whoami');
  const refresh = await fetch(`${GW}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: H(null, { 'Content-Type': 'application/json' }), body: JSON.stringify({ refresh_token: s2.refresh_token }) });
  check(out.status === 204 && refresh.status >= 400, 'signed out: the refresh token is refused', `logout ${out.status}, refresh ${refresh.status}`);
  info('signed out: the access token still works until it expires (finding F-05)', `PostgREST whoami HTTP ${after.status}`);
}

// ── 2. role × action, both channels ─────────────────────────────────────────────────────────
const ROLES = ['agency', 'hr', 'admin', 'norole'];
const yes = (...who) => Object.fromEntries(ROLES.map((r) => [r, who.includes(r)]));
const ACTIONS = [
  { name: 'read suedwind.products', expect: yes('agency', 'admin'),
    ui: (t) => rest(t, 'GET', '/products?select=sku,name&limit=1', { profile: 'suedwind' }).then((r) => r.status === 200 && r.body.length > 0),
    mcp: (t) => tool(t, 'select_rows', { schema: 'suedwind', table: 'products', select: 'sku,name', limit: 1 }).then((r) => !r.isError && r.data?.rows?.length > 0) },
  { name: 'update suedwind.products.name (same value)', expect: yes('agency', 'admin'),
    ui: (t) => rest(t, 'PATCH', '/products?sku=eq.SW-2001', { profile: 'suedwind', body: { name: SW_NAME }, prefer: 'return=representation' }).then((r) => r.status === 200 && r.body.length === 1),
    mcp: (t) => tool(t, 'update_rows', { schema: 'suedwind', table: 'products', values: { name: SW_NAME }, filters: [{ column: 'sku', op: 'eq', value: 'SW-2001' }], max_rows: 1 }).then((r) => !r.isError && r.data?.rows?.length === 1) },
  { name: 'update suedwind.products.price (same value)', expect: yes('admin'),
    ui: (t) => rest(t, 'PATCH', '/products?sku=eq.SW-2001', { profile: 'suedwind', body: { price: SW_PRICE }, prefer: 'return=representation' }).then((r) => r.status === 200 && r.body.length === 1),
    mcp: (t) => tool(t, 'update_rows', { schema: 'suedwind', table: 'products', values: { price: SW_PRICE }, filters: [{ column: 'sku', op: 'eq', value: 'SW-2001' }], max_rows: 1 }).then((r) => !r.isError && r.data?.rows?.length === 1) },
  { name: 'read nordwind.products (other brand)', expect: yes('admin'),
    ui: (t) => rest(t, 'GET', '/products?select=sku&limit=1', { profile: 'nordwind' }).then((r) => r.status === 200 && r.body.length > 0),
    mcp: (t) => tool(t, 'select_rows', { schema: 'nordwind', table: 'products', select: 'sku', limit: 1 }).then((r) => !r.isError && r.data?.rows?.length > 0) },
  { name: 'read public.documents', expect: yes('hr', 'admin'),
    ui: (t) => rest(t, 'GET', '/documents?select=id&limit=1', { profile: 'public' }).then((r) => r.status === 200 && r.body.length > 0),
    mcp: (t) => tool(t, 'select_rows', { schema: 'public', table: 'documents', select: 'id', limit: 1 }).then((r) => !r.isError && r.data?.rows?.length > 0) },
  { name: 'list files in bucket hr-files', expect: yes('hr'),
    ui: (t) => storage(t, 'POST', '/object/list/hr-files', { body: JSON.stringify({ prefix: '', limit: 5 }), headers: { 'Content-Type': 'application/json' } }).then((r) => r.status === 200 && Array.isArray(r.body) && r.body.length > 0),
    mcp: (t) => tool(t, 'list_files', { bucket: 'hr-files' }).then((r) => !r.isError && r.data?.files?.length > 0) },
  { name: `upload images/${OBJECT}`, expect: yes('admin'),
    ui: (t) => storage(t, 'POST', `/object/images/${OBJECT}`, { body: 'ui', headers: { 'Content-Type': 'text/plain', 'x-upsert': 'true' } }).then((r) => r.status === 200),
    mcp: (t) => tool(t, 'upload_file', { bucket: 'images', path: OBJECT, content_text: 'mcp', content_type: 'text/plain', upsert: true }).then((r) => !r.isError) },
  { name: 'cms_api.list_users (admin area)', expect: yes('admin'),
    ui: (t) => rpc(t, 'list_users').then((r) => r.status === 200),
    // MCP never reaches the plugin's admin functions, not even for an admin (cms_api is not offered)
    mcp: (t) => tool(t, 'call_function', { schema: 'cms_api', name: 'list_users', args: {} }).then((r) => !r.isError), mcpExpect: yes() },
  { name: 'cms_api.assign_role → revoke_role (test person without role)', expect: yes('admin'),
    ui: async (t) => {
      const a = await rpc(t, 'assign_role', { user_id: users.norole.id, role_name: 'hr_editor' });
      if (a.status !== 200) return false;
      return (await rpc(t, 'revoke_role', { user_id: users.norole.id })).status === 200;
    },
    mcp: (t) => tool(t, 'call_function', { schema: 'cms_api', name: 'assign_role', args: { user_id: users.norole.id, role_name: 'hr_editor' } }).then((r) => !r.isError), mcpExpect: yes() },
  { name: 'admin API: block → unblock the test person without role', expect: yes('admin'), mcpExpect: yes(),
    ui: async (t) => {
      const b = await adminApi(t, `/users/${users.norole.id}/block`);
      if (b.status === 503) return null;          // admin API without service key (not configured)
      if (b.status !== 200) return false;
      return (await adminApi(t, `/users/${users.norole.id}/unblock`)).status === 200;
    },
    // an MCP (OAuth) token is a full token of the person, but the admin API refuses tokens of connected programs (F-03)
    mcp: async (t) => (await adminApi(t, `/users/${users.norole.id}/unblock`)).status === 200 },
];
let SW_NAME; let SW_PRICE;

async function matrix() {
  step('2. role × action: UI channel (PostgREST/Storage/admin API with the session) and MCP channel (OAuth token)');
  const row = JSON.parse(sql(`select json_build_object('name', name, 'price', price) from suedwind.products where sku = 'SW-2001'`));
  SW_NAME = row.name; SW_PRICE = row.price;
  for (const a of ACTIONS) {
    for (const who of ROLES) {
      const ui = await a.ui(users[who].session).catch(() => false);
      if (ui === null) { info(`UI  ${who.padEnd(6)} ${a.name}`, 'skipped: the admin API has no service key (503)'); continue; }
      check(ui === a.expect[who], `UI  ${who.padEnd(6)} ${a.name}`, `${ui ? 'allowed' : 'refused'}, expected ${a.expect[who] ? 'allowed' : 'refused'}`);
      const want = (a.mcpExpect ?? a.expect)[who];
      const got = await a.mcp(users[who].mcp).catch(() => false);
      check(got === want, `MCP ${who.padEnd(6)} ${a.name}`, `${got ? 'allowed' : 'refused'}, expected ${want ? 'allowed' : 'refused'}`);
    }
  }
  const week = await tool(users.admin.mcp, 'create_signed_url', { bucket: 'images', path: 'suedwind/x.png', expires_in: 7 * 24 * 3600 });
  check(week.isError, 'MCP create_signed_url: at most 24 h (a link should not outlive the conversation by a week)');
  const after = JSON.parse(sql(`select json_build_object('name', name, 'price', price) from suedwind.products where sku = 'SW-2001'`));
  check(after.name === SW_NAME && after.price === SW_PRICE, 'data unchanged after the matrix (updates wrote the value already there)');
  check(sql(`select count(*) from cms.user_roles where user_id = ${lit(users.norole.id)}`) === '0', 'the test person without role still has none');
}

// ── 3. MFA ──────────────────────────────────────────────────────────────────────────────────
async function mfa() {
  step('3. second factor: the role needs aal2, or an OAuth client confirmed with aal2 (install.sql step 4)');
  const s1 = await login(mail('mfa'), password);
  const en = await authUser(s1.access_token, 'POST', '/factors', { factor_type: 'totp', friendly_name: 'test-security' });
  const ch = await authUser(s1.access_token, 'POST', `/factors/${en.body.id}/challenge`, {});
  const v = await authUser(s1.access_token, 'POST', `/factors/${en.body.id}/verify`, { challenge_id: ch.body.id, code: totp(en.body.totp.secret) });
  check(v.status === 200 && claimsOf(v.body.access_token).aal === 'aal2', 'TOTP factor enrolled, session is aal2', `HTTP ${v.status}`);
  const aal2 = v.body.access_token;
  check(claimsOf(aal2).role === 'agency_suedwind', 'aal2 session token carries the role', claimsOf(aal2).role);

  const pw = (await login(mail('mfa'), password)).access_token;
  check(claimsOf(pw).aal === 'aal1' && claimsOf(pw).role === 'authenticated', 'password alone: token without the role', `aal ${claimsOf(pw).aal}, role ${claimsOf(pw).role}`);
  const r = await rest(pw, 'GET', '/products?select=sku&limit=1', { profile: 'suedwind' });
  check(r.status !== 200 || r.body.length === 0, 'password alone: PostgREST does not open suedwind.products', `HTTP ${r.status}`);
  const m = await tool(pw, 'select_rows', { schema: 'suedwind', table: 'products', select: 'sku', limit: 1 });
  check(m.isError || !m.data?.rows?.length, 'password alone: MCP select_rows refused');
  const c1 = await rpc(pw, 'confirm_mfa_client', { authorization_id: 'x' });
  check(c1.status === 403, 'password alone: cannot confirm a client', `HTTP ${c1.status}`);

  const o1 = await oauthToken(pw);
  check(!o1.error && claimsOf(o1.token).role === 'authenticated', 'OAuth approved by an aal1 session: no role', o1.error ?? claimsOf(o1.token).role);
  const o2 = await oauthToken(aal2, { confirm: true });
  check(!o2.error && claimsOf(o2.token).role === 'agency_suedwind', 'OAuth confirmed with the aal2 session: role', o2.error ?? `${claimsOf(o2.token).role}, aal ${claimsOf(o2.token).aal}`);
  const w = await tool(o2.token, 'select_rows', { schema: 'suedwind', table: 'products', select: 'sku', limit: 1 });
  check(!w.isError && w.data?.rows?.length === 1, 'confirmed client: MCP select_rows works');
}

// ── 4. service key: never in the browser, never on the MCP data path ───────────────────────
async function serviceKey() {
  step('4. service key: local server with a canary key behind a recording proxy; UI bundle');
  const canary = `sb_secret_CANARY_${randomBytes(12).toString('hex')}`;
  const seen = [];
  const proxy = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', async () => {
      const body = Buffer.concat(chunks);
      seen.push({ path: req.url, raw: `${JSON.stringify(req.headers)} ${body.toString('latin1')}` });
      const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
      const r = await fetch(`${GW}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }).catch(() => null);
      if (!r) { res.writeHead(502); return res.end(); }
      const out = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/octet-stream' }); res.end(out);
    });
  });
  await new Promise((ok) => proxy.listen(0, '127.0.0.1', ok));
  const srv = spawn(process.execPath, ['server.mjs'], { cwd: `${root}apps/server`, stdio: ['ignore', 'pipe', 'pipe'], env: {
    PATH: process.env.PATH, PORT: String(CANARY_PORT), SUPABASE_PUBLIC_URL: GW, SUPABASE_URL: `http://127.0.0.1:${proxy.address().port}`,
    SUPABASE_ANON_KEY: ANON, SUPABASE_SECRET_KEY: canary, CMS_ADMIN_INVITE_DELIVERY: 'link' } });
  let logs = ''; srv.stdout.on('data', (d) => { logs += d; }); srv.stderr.on('data', (d) => { logs += d; });
  const base = `http://127.0.0.1:${CANARY_PORT}`;
  try {
    for (let i = 0; i < 50 && !(await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)); i++) await new Promise((ok) => setTimeout(ok, 200));
    const responses = [];
    const t = users.admin.mcp;
    for (const [name, args] of [['whoami', {}], ['list_tables', {}], ['select_rows', { schema: 'suedwind', table: 'products', select: 'sku', limit: 1 }],
      ['list_files', { bucket: 'images', prefix: 'suedwind' }], ['call_function', { schema: 'cms_api', name: 'list_users', args: {} }]]) {
      responses.push(JSON.stringify(await tool(t, name, args, base)));
    }
    const mcpRequests = seen.length;
    for (const p of ['/cms/config.json', '/cms/', '/oauth/consent?authorization_id=x']) {
      const r = await fetch(`${base}${p}`); responses.push(`${JSON.stringify([...r.headers])} ${await r.text()}`);
    }
    responses.push(JSON.stringify(await adminApi(users.agency.session, '/invite', { email: mail('never') }, base)));
    responses.push(JSON.stringify(await adminApi(users.admin.session, '/invite', { email: 'not an address' }, base)));
    responses.push(JSON.stringify(await adminApi(users.admin.session, `/users/${users.norole.id}/unblock`, {}, base)));   // the one call that uses the key
    check(mcpRequests > 0 && seen.slice(0, mcpRequests).every((x) => !x.raw.includes(canary)), 'MCP data path: no request to Supabase carries the key', `${mcpRequests} requests`);
    const withKey = seen.filter((x) => x.raw.includes(canary)).map((x) => x.path.split('?')[0]);
    check(withKey.length > 0 && withKey.every((p) => /^\/auth\/v1\/(admin\/|invite$)/.test(p)), 'the key goes only to the Auth admin API, after the gate', withKey.join(' ') || 'never used');
    check(responses.every((x) => !x.includes(canary)) && !logs.includes(canary), 'no response and no log line contains the key');
  } finally {
    srv.kill(); proxy.close();
  }
  const dist = `${root}apps/ui/dist`;
  if (existsSync(dist)) {
    const files = readdirSync(dist, { recursive: true }).filter((f) => /\.(js|html|json|css|map)$/.test(f));
    const secrets = [SERVICE, env.SUPABASE_SECRET_KEY, env.JWT_SECRET, env.POSTGRES_PASSWORD].filter((x) => x && x.length > 8);
    const leaked = files.filter((f) => { const s = readFileSync(`${dist}/${f}`, 'utf8'); return secrets.some((x) => s.includes(x)); });
    check(leaked.length === 0, 'UI bundle (apps/ui/dist) holds no service key, JWT secret or database password', `${files.length} files`);
  } else info('apps/ui/dist missing: bundle grep skipped (npm run build in apps/ui)');
}

// ── 5. web: headers, framing, CORS ──────────────────────────────────────────────────────────
async function web() {
  step(`5. web headers (${CMS}; admin API ${ADMIN})`);
  const ui = await fetch(`${CMS}/cms/`);
  const csp = ui.headers.get('content-security-policy') ?? '';
  check(ui.ok && /frame-ancestors 'none'/.test(csp) && /script-src 'self'(;|$)/.test(csp) && !/unsafe-eval/.test(csp) && /base-uri 'self'/.test(csp) && /form-action 'self'/.test(csp),
    '/cms/: CSP without inline/eval script, no framing, base-uri + form-action self', csp.slice(0, 80));
  check(ui.headers.get('x-content-type-options') === 'nosniff' && ui.headers.get('referrer-policy') === 'no-referrer', '/cms/: nosniff, no-referrer');
  check(!ui.headers.get('x-powered-by'), 'no X-Powered-By');
  const consent = await fetch(`${CMS}/oauth/consent?authorization_id=abc`);
  const ccsp = consent.headers.get('content-security-policy') ?? '';
  check(/default-src 'none'/.test(ccsp) && /frame-ancestors 'none'/.test(ccsp) && consent.headers.get('cache-control') === 'no-store', '/oauth/consent: default-src none, no framing, no-store');
  const cfg = await fetch(`${CMS}/cms/config.json`);
  const cj = await json(cfg);
  check(cfg.ok && JSON.stringify(Object.keys(cj ?? {}).sort()) === '["anonKey","supabaseUrl"]' && cj.anonKey === ANON && cfg.headers.get('cache-control') === 'no-store',
    '/cms/config.json: only the URL and the anon key, no-store');
  const a = await adminApi(null, '/invite', {});
  check(a.status === 401 && a.headers.get('cache-control') === 'no-store' && a.headers.get('x-content-type-options') === 'nosniff', 'admin API: 401 without token, no-store, nosniff');
  for (const [base, path] of [[ADMIN, '/cms/api/admin/invite'], [CMS, '/cms/mcp']]) {
    const pre = await fetch(`${base}${path}`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    check(!pre.headers.get('access-control-allow-origin'), `${path}: no CORS for a foreign origin (a page elsewhere cannot call it with a token)`, `HTTP ${pre.status}`);
  }
  const big = await fetch(`${CMS}/cms/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: `{"x":"${'a'.repeat(8 * 1024 * 1024)}"}` });   // above the JSON limit: 413 if parsed first
  check(big.status === 401, '/cms/mcp: a large body without token is answered 401 (token checked first)', `HTTP ${big.status}`);
  const pub = await fetch(`${GW}/storage/v1/object/public/images/suedwind/`);
  const listPublic = sql(`select name from storage.objects where bucket_id = 'images' and name like 'nordwind/%' limit 1`);
  if (listPublic) {
    const anonRead = await fetch(`${GW}/storage/v1/object/public/images/${listPublic.split('/').map(encodeURIComponent).join('/')}`);
    info('public bucket images: any file readable without key or token (finding F-07)', `HTTP ${anonRead.status}`);
  }
  void pub;
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────
try {
  await setup();
  await tokens();
  await matrix();
  await mfa();
  await serviceKey();
  await web();
} catch (e) {
  failed++; console.log(`   ** FAIL **  aborted: ${e.message}`);
} finally {
  await teardown().catch((e) => { failed++; console.log(`   ** FAIL **  teardown: ${e.message}`); });
}
console.log(`\n${failed === 0 ? 'ALL SECURITY CHECKS PASSED' : `${failed} SECURITY CHECK(S) FAILED`} (${passed} passed)`);
process.exit(failed === 0 ? 0 : 1);
