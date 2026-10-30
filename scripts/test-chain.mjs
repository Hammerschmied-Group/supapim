#!/usr/bin/env node
// End-to-end proof of the chain, exactly as a remote MCP client (Claude) runs it:
//   MCP 401 → protected-resource metadata → Supabase Auth metadata → dynamic client registration
//   → /oauth/authorize (PKCE) → consent page API (login as the agency test user, approve)
//   → code exchange → access token carries the hook's role claim?
//   → MCP tools/call with that token → PostgREST enforces GRANTs → audit log shows the e-mail
//   → plugin RPC cms_api.describe() / effective_rights() over PostgREST with the same tokens.
// Step 7 runs every MCP tool for the agency, HR, admin and the user without a role (allowed and denied).
// No dependencies (Node ≥ 22). Reads .env for URLs and the test password; prints no secrets.
// Usage: node scripts/test-chain.mjs [--keep-token <file>] [--mcp-url <url>] [--log <file>]
//   --keep-token  write the agency's MCP access token to <file> (mode 600)
//   --mcp-url     MCP endpoint (default: $MCP_URL or <SUPABASE_PUBLIC_URL>/cms/mcp, the gateway route).
//                 Against a dev server: --mcp-url http://localhost:55381/cms/mcp  (scripts/dev-mcp.sh)
//   --log         the server's stdout (JSON lines); checks the access log: every tool present, no tokens, no data values

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const env = Object.fromEntries(readFileSync(`${root}.env`, 'utf8').split('\n')
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));
const argOf = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };
const MCP = argOf('--mcp-url') ?? process.env.MCP_URL ?? `${env.SUPABASE_PUBLIC_URL}/cms/mcp`;
const LOG_FILE = argOf('--log');
const ANON = env.ANON_KEY;
const USER = 'agentur.nordwind@example.com';
const PRODUCT_SKU = 'NW-1001';
const keepIdx = process.argv.indexOf('--keep-token');
const RUN = Date.now().toString(36);
const START_S = Math.floor(Date.now() / 1000) - 2;

let failed = 0;
const check = (ok, label, detail = '') => { if (!ok) failed++; console.log(`   ${ok ? 'PASS' : '** FAIL **'}  ${label}${detail ? `  — ${detail}` : ''}`); return ok; };
const step = (s) => console.log(`\n== ${s}`);
const b64url = (buf) => buf.toString('base64url');
const claimsOf = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
const sql = (q) => execFileSync('docker', ['exec', '-i', 'supabase-db', 'psql', '-X', '-At', '-U', 'supabase_admin', '-d', 'postgres', '-c', q], { encoding: 'utf8' }).trim();

let rpcId = 0;
async function mcp(token, method, params) {
  const r = await fetch(MCP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, headers: r.headers, body };
}
const toolText = (res) => res.body?.result?.content?.[0]?.text ?? JSON.stringify(res.body);
const callTool = (token, name, args) => mcp(token, 'tools/call', { name, arguments: args });

// ── 1. discovery ────────────────────────────────────────────────────────────────────────────
step('1. MCP without token → 401 + resource metadata');
const r0 = await mcp(null, 'initialize', {});
const wwwAuth = r0.headers.get('www-authenticate') ?? '';
check(r0.status === 401, 'MCP answers 401', `HTTP ${r0.status}`);
const rmUrl = /resource_metadata="([^"]+)"/.exec(wwwAuth)?.[1];
check(!!rmUrl, 'WWW-Authenticate names resource_metadata', rmUrl);
const rm = await (await fetch(rmUrl)).json();
const issuer = rm.authorization_servers?.[0];
check(!!issuer, 'protected resource → authorization server', issuer);

step('2. Supabase Auth metadata (RFC 8414 path, no apikey)');
const iss = new URL(issuer);
const asMetaUrl = `${iss.origin}/.well-known/oauth-authorization-server${iss.pathname}`;
const asMetaRes = await fetch(asMetaUrl);
const as = await asMetaRes.json().catch(() => ({}));
check(asMetaRes.ok && as.issuer === issuer, 'metadata issuer matches', `HTTP ${asMetaRes.status} ${as.issuer}`);
check(!!as.registration_endpoint, 'dynamic registration advertised', as.registration_endpoint);
check((as.code_challenge_methods_supported ?? []).includes('S256'), 'PKCE S256 supported');

// ── 3. dynamic client registration, like Claude Code does it ────────────────────────────────
step('3. Dynamic client registration (no apikey)');
const redirectUri = 'http://localhost:53999/callback';
const regRes = await fetch(as.registration_endpoint, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_name: 'Claude Code (spike test)', redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
});
const client = await regRes.json().catch(() => ({}));
check(regRes.status === 201 || regRes.status === 200, 'client registered', `HTTP ${regRes.status} client_id=${client.client_id ?? JSON.stringify(client)}`);

// ── 4. authorize → consent page ─────────────────────────────────────────────────────────────
step('4. /oauth/authorize with PKCE → redirect to our consent page');
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash('sha256').update(verifier).digest());
const state = b64url(randomBytes(8));
const authUrl = new URL(as.authorization_endpoint);
Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge,
  code_challenge_method: 'S256', state, scope: rm.scopes_supported.join(' '), resource: rm.resource }).forEach(([k, v]) => authUrl.searchParams.set(k, v));
const authRes = await fetch(authUrl, { redirect: 'manual' });
const consentUrl = new URL(authRes.headers.get('location') ?? 'http://invalid/');
const authorizationId = consentUrl.searchParams.get('authorization_id');
check(authRes.status === 302 && consentUrl.pathname === '/oauth/consent' && !!authorizationId,
  'redirects to consent page', `HTTP ${authRes.status} → ${consentUrl.origin}${consentUrl.pathname}`);
const pageRes = await fetch(consentUrl);
check(pageRes.ok && (await pageRes.text()).includes('möchte Zugriff'), 'consent page served', `HTTP ${pageRes.status}`);

// ── 5. what the consent page does in the browser ────────────────────────────────────────────
step(`5. Consent: log in as ${USER}, load the request, approve`);
const sb = env.SUPABASE_PUBLIC_URL;
const loginRes = await fetch(`${sb}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: USER, password: env.TEST_USER_PASSWORD }),
});
const session = await loginRes.json();
check(loginRes.ok, 'password login', `HTTP ${loginRes.status}`);
check(claimsOf(session.access_token).role === 'agency_nordwind', 'session token: hook set role claim', claimsOf(session.access_token).role);
const userHdr = { apikey: ANON, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' };
const detRes = await fetch(`${sb}/auth/v1/oauth/authorizations/${authorizationId}`, { headers: userHdr });
const det = await detRes.json().catch(() => ({}));
check(detRes.ok && det.client?.name === 'Claude Code (spike test)', 'authorization details', `HTTP ${detRes.status} client=${det.client?.name} scope=${det.scope}`);
const conRes = await fetch(`${sb}/auth/v1/oauth/authorizations/${authorizationId}/consent`, { method: 'POST', headers: userHdr, body: JSON.stringify({ action: 'approve' }) });
const con = await conRes.json().catch(() => ({}));
const cb = new URL(con.redirect_url ?? 'http://invalid/');
check(conRes.ok && cb.searchParams.get('state') === state && !!cb.searchParams.get('code'), 'approved → redirect with code + state', `HTTP ${conRes.status} → ${cb.origin}${cb.pathname}`);

// ── 6. token exchange — the key question ────────────────────────────────────────────────────
step('6. Code exchange at the token endpoint (public client, no apikey)');
const tokRes = await fetch(as.token_endpoint, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code: cb.searchParams.get('code'), redirect_uri: redirectUri,
    client_id: client.client_id, code_verifier: verifier, resource: rm.resource }),
});
const tok = await tokRes.json().catch(() => ({}));
check(tokRes.ok && !!tok.access_token, 'access token issued', `HTTP ${tokRes.status} ${tok.error ?? ''} ${tok.error_description ?? ''}`);
const c = tok.access_token ? claimsOf(tok.access_token) : {};
console.log(`   OAuth access token claims: role=${c.role} email=${c.email} client_id=${c.client_id} aud=${c.aud} iss=${c.iss} scope=${c.scope}`);
check(c.role === 'agency_nordwind', 'KEY QUESTION: OAuth access token carries the hook role claim', `role=${c.role}`);
check(c.client_id === client.client_id, 'token names the OAuth client', c.client_id);
if (c.scope?.includes('openid')) check(!!tok.id_token, 'OIDC id_token issued (ES256 signing keys)', tok.id_token ? `alg=${JSON.parse(Buffer.from(tok.id_token.split('.')[0], 'base64url')).alg}` : 'missing');

if (tok.refresh_token) {
  const refRes = await fetch(as.token_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: client.client_id }),
  });
  const ref = await refRes.json().catch(() => ({}));
  check(refRes.ok && claimsOf(ref.access_token).role === 'agency_nordwind', 'refreshed OAuth token keeps the role claim', `HTTP ${refRes.status}`);
}
if (keepIdx > 0 && tok.access_token) { writeFileSync(process.argv[keepIdx + 1], tok.access_token, { mode: 0o600 }); }

// ── 7. MCP: every tool, allowed and denied ──────────────────────────────────────────────────
// Agency = the OAuth token from step 6 (the full chain). The other people sign in with a password
// session: the same kind of token (aud authenticated, role claim from the hook) and the same JWKS.
const login = async (email) => (await (await fetch(`${sb}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: env.TEST_USER_PASSWORD }) })).json()).access_token;
const T = tok.access_token;
const [HR, AD, NR, SW] = await Promise.all(['hr@example.com', 'admin@example.com', 'ohne.rolle@example.com', 'agentur.suedwind@example.com'].map(login));

const short = (t, n = 150) => String(t).replace(/\s+/g, ' ').slice(0, n);
async function tool(token, name, args = {}) {
  const res = await callTool(token, name, args);
  const text = toolText(res);
  let json; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { res, isError: res.body?.result?.isError === true, text, json, content: res.body?.result?.content ?? [] };
}
const allowed = (label, r, ok = () => true) => check(!r.isError && ok(r), `${label} → allowed`, short(r.text, 110));
const denied = (label, r, re = /./) => check(r.isError && re.test(r.text), `${label} → denied`, short(r.text));

step('7a. MCP discovery, token checks, initialize, tools/list');
const noTok = await mcp('not-a-token', 'initialize', {});
check(noTok.status === 401, 'garbage token → 401', `HTTP ${noTok.status}`);
const anonTok = await mcp(ANON, 'initialize', {});
check(anonTok.status === 401, 'anon key as token → 401', `HTTP ${anonTok.status}`);
const svcTok = await mcp(env.SERVICE_ROLE_KEY, 'initialize', {});
check(svcTok.status === 401, 'service_role key as token → 401 (never accepted on the MCP path)', `HTTP ${svcTok.status}`);
const init = await mcp(T, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-chain', version: '1' } });
check(init.status === 200 && !!init.body?.result?.serverInfo, 'initialize', `HTTP ${init.status}`);
const toolList = (await mcp(T, 'tools/list', {})).body?.result?.tools ?? [];
const names = toolList.map((t) => t.name);
const EXPECTED = ['whoami', 'list_tables', 'select_rows', 'insert_rows', 'update_rows', 'delete_rows', 'call_function',
  'list_files', 'upload_file', 'download_file', 'create_signed_url'];
check(EXPECTED.every((n) => names.includes(n)) && names.length === EXPECTED.length, 'tools/list has exactly the 11 tools', names.join(', '));

step('7b. whoami / list_tables (the overview follows the role)');
for (const [tk, email, role] of [[T, USER, 'agency_nordwind'], [HR, 'hr@example.com', 'hr_editor'], [AD, 'admin@example.com', 'cms_admin'],
  [NR, 'ohne.rolle@example.com', 'authenticated']]) {
  const w = await tool(tk, 'whoami');
  allowed(`whoami ${role}`, w, (x) => x.json?.email === email && x.json?.db_role === role);
}
const whoAg = (await tool(T, 'whoami')).json;
check(!!whoAg.oauth_client_id && whoAg.oauth_client_id === client.client_id, 'whoami names the OAuth client', whoAg.oauth_client_id);
const tab = (r, schema, table) => r.json?.schemas?.find((s) => s.name === schema)?.tables?.find((t) => t.name === table);
const ltAg = await tool(T, 'list_tables');
allowed('list_tables agency', ltAg, (r) => JSON.stringify(r.json.schemas.map((s) => s.name)) === '["nordwind"]'
  && tab(r, 'nordwind', 'products').columns.find((c) => c.name === 'name').can.includes('update')
  && !tab(r, 'nordwind', 'products').columns.find((c) => c.name === 'price').can.includes('update')
  && !tab(r, 'nordwind', 'products').can.includes('delete') && r.json.storage.buckets[0].id === 'images');
const ltOther = await tool(T, 'list_tables', { schema: 'suedwind' });
check(!ltOther.isError && ltOther.json.schemas.length === 0 && /no access/.test(ltOther.json.note ?? ''), 'list_tables agency, other brand → empty + note', short(ltOther.text));
allowed('list_tables hr', await tool(HR, 'list_tables'), (r) => !!tab(r, 'public', 'documents') && !tab(r, 'nordwind', 'products')
  && r.json.storage.buckets.map((b) => b.id).join() === 'hr-files');
const ltAd = await tool(AD, 'list_tables');
allowed('list_tables admin (both brands, match_documents)', ltAd, (r) => !!tab(r, 'nordwind', 'faq') && !!tab(r, 'suedwind', 'faq')
  && r.json.schemas.find((s) => s.name === 'public').functions.some((f) => f.name === 'match_documents'));
const ltNr = await tool(NR, 'list_tables');
check(!ltNr.isError && ltNr.json.schemas.length === 0 && /no access/.test(ltNr.json.note ?? ''), 'list_tables without role → nothing + note', short(ltNr.text));

step('7c. select_rows');
allowed('agency reads own brand (structured filter)', await tool(T, 'select_rows', { schema: 'nordwind', table: 'products',
  select: 'sku,name,price', filters: [{ column: 'sku', op: 'eq', value: PRODUCT_SKU }] }), (r) => r.json.row_count === 1 && r.json.rows[0].sku === PRODUCT_SKU);
const sel2 = await tool(T, 'select_rows', { schema: 'nordwind', table: 'products', select: 'sku,price',
  filters: [{ column: 'sku', op: 'in', value: ['NW-1001', 'NW-1002', 'NW-1003'] }, { column: 'price', op: 'gte', value: 0 }],
  order: [{ column: 'sku', direction: 'desc' }], limit: 2, count: true });
allowed('agency: in + gte, order desc, limit, count', sel2, (r) => r.json.row_count === 2 && r.json.total_count >= 2
  && r.json.rows[0].sku > r.json.rows[1].sku);
allowed('agency: ilike + is_null + raw filter string', await tool(T, 'select_rows', { schema: 'nordwind', table: 'products',
  select: 'sku', filters: [{ column: 'name', op: 'ilike', value: '%regenjacke%' }, { column: 'description', op: 'not_null' }], filter: 'active=is.true' }));
const badOp = await tool(T, 'select_rows', { schema: 'nordwind', table: 'products', filters: [{ column: 'sku', op: 'in', value: 'NW-1001' }] });
check(badOp.isError && /needs an array/.test(badOp.text), 'invalid structured filter → clear error', short(badOp.text));
denied('agency reads other brand', await tool(T, 'select_rows', { schema: 'suedwind', table: 'products', select: 'sku' }),
  /agency_nordwind.*no access to schema `suedwind`/);
allowed('admin reads faq', await tool(AD, 'select_rows', { schema: 'nordwind', table: 'faq', limit: 5 }));
allowed('hr reads HR documents (RLS: only brand=hr)', await tool(HR, 'select_rows', { schema: 'public', table: 'documents',
  select: 'id,brand', filters: [{ column: 'brand', op: 'eq', value: 'hr' }] }), (r) => r.json.row_count > 0 && r.json.rows.every((x) => x.brand === 'hr'));
const hrAll = await tool(HR, 'select_rows', { schema: 'public', table: 'documents', select: 'id,brand', limit: 500 });
check(!hrAll.isError && hrAll.json.rows.every((x) => x.brand === 'hr'), 'hr without filter still sees only brand=hr (RLS)', `${hrAll.json?.row_count} rows`);
denied('hr reads nordwind', await tool(HR, 'select_rows', { schema: 'nordwind', table: 'products', select: 'sku' }), /hr_editor.*no access/);
denied('no role reads nordwind', await tool(NR, 'select_rows', { schema: 'nordwind', table: 'products', select: 'sku' }), /no access/);
denied('no role reads public.documents', await tool(NR, 'select_rows', { schema: 'public', table: 'documents', select: 'id' }), /no access/);

step('7d. insert_rows / update_rows / delete_rows');
const faqQ = `mcp-test ${RUN}`;
allowed('admin inserts 3 FAQ rows', await tool(AD, 'insert_rows', { schema: 'nordwind', table: 'faq',
  rows: [1, 2, 3].map((i) => ({ question: `${faqQ} #${i}`, answer: 'a' })) }), (r) => r.json.row_count === 3 && !!r.json.rows[0].id);
denied('agency inserts FAQ', await tool(T, 'insert_rows', { schema: 'nordwind', table: 'faq', rows: [{ question: 'q', answer: 'a' }] }),
  /agency_nordwind.*may not insert rows in `nordwind.faq`/);
denied('hr inserts FAQ', await tool(HR, 'insert_rows', { schema: 'nordwind', table: 'faq', rows: [{ question: 'q', answer: 'a' }] }), /hr_editor.*no access/);
denied('no role inserts FAQ', await tool(NR, 'insert_rows', { schema: 'nordwind', table: 'faq', rows: [{ question: 'q', answer: 'a' }] }), /no access/);

const newName = `Nordwind Regenjacke Classic (MCP ${new Date().toISOString().slice(11, 19)})`;
const upd = await tool(T, 'update_rows', { schema: 'nordwind', table: 'products', filters: [{ column: 'sku', op: 'eq', value: PRODUCT_SKU }], values: { name: newName } });
allowed('agency changes product NAME', upd, (r) => r.json.rows[0].name === newName);
const price = await tool(T, 'update_rows', { schema: 'nordwind', table: 'products', filters: [{ column: 'sku', op: 'eq', value: PRODUCT_SKU }], values: { price: 1 } });
denied('agency changes product PRICE (explained)', price, /agency_nordwind.*may not change column `price` in `nordwind.products`.*Allowed to update: `name`/);
check(/42501/.test(price.text) && /permission denied/.test(price.text), '… and the raw Postgres error (42501) is included', short(price.json?.postgres?.message));
const priceMulti = await tool(T, 'update_rows', { schema: 'nordwind', table: 'products', filters: [{ column: 'sku', op: 'eq', value: PRODUCT_SKU }], values: { name: 'x', price: 1, sku: 'y' } });
denied('agency: name + price + sku → names both blocked columns', priceMulti, /`price`, `sku`/);
allowed('agency changes image alt_text', await tool(T, 'update_rows', { schema: 'nordwind', table: 'product_images',
  filters: [{ column: 'storage_path', op: 'eq', value: 'nordwind/regenjacke.png' }], values: { alt_text: 'Regenjacke Marineblau, Kapuze' } }), (r) => r.json.row_count === 1);
denied('agency updates other brand', await tool(T, 'update_rows', { schema: 'suedwind', table: 'products', filters: [{ column: 'sku', op: 'eq', value: 'SW-1001' }], values: { name: 'x' } }), /no access to schema/);
denied('agency updates faq', await tool(T, 'update_rows', { schema: 'nordwind', table: 'faq', filters: [{ column: 'question', op: 'like', value: `${faqQ}%` }], values: { answer: 'x' } }),
  /agency_nordwind.*may not update rows in `nordwind.faq`/);
denied('hr updates documents', await tool(HR, 'update_rows', { schema: 'public', table: 'documents', filters: [{ column: 'brand', op: 'eq', value: 'hr' }], values: { content: 'x' } }), /hr_editor.*may not update/);
denied('no role updates', await tool(NR, 'update_rows', { schema: 'nordwind', table: 'faq', filters: [{ column: 'id', op: 'is_null' }], values: { answer: 'x' } }), /no access/);
const noFilterUpd = await tool(AD, 'update_rows', { schema: 'nordwind', table: 'faq', values: { answer: 'x' } });
check(noFilterUpd.isError && /at least one filter/.test(noFilterUpd.text), 'update without filter → refused', short(noFilterUpd.text));
const onlyShaping = await tool(AD, 'update_rows', { schema: 'nordwind', table: 'faq', values: { answer: 'x' }, filter: 'select=id&limit=1' });
check(onlyShaping.isError && /at least one filter/.test(onlyShaping.text), 'update with only limit/select in the raw string → refused', short(onlyShaping.text));
allowed('admin updates its 3 rows (max_rows 3)', await tool(AD, 'update_rows', { schema: 'nordwind', table: 'faq',
  filters: [{ column: 'question', op: 'like', value: `${faqQ}%` }], values: { answer: 'updated' }, max_rows: 3 }), (r) => r.json.row_count === 3);
const tooMany = await tool(AD, 'update_rows', { schema: 'nordwind', table: 'faq', filters: [{ column: 'question', op: 'like', value: `${faqQ}%` }], values: { answer: 'too many' }, max_rows: 2 });
check(tooMany.isError && /more rows than max_rows/.test(tooMany.text), 'update matching more than max_rows → refused, explained', short(tooMany.text));
check(sql(`select count(*) from nordwind.faq where question like '${faqQ}%' and answer = 'updated'`) === '3', '… and nothing was changed (all 3 rows still "updated")');

denied('agency deletes products', await tool(T, 'delete_rows', { schema: 'nordwind', table: 'products', filters: [{ column: 'sku', op: 'eq', value: PRODUCT_SKU }] }),
  /agency_nordwind.*may not delete rows in `nordwind.products`/);
denied('hr deletes documents', await tool(HR, 'delete_rows', { schema: 'public', table: 'documents', filters: [{ column: 'brand', op: 'eq', value: 'hr' }] }), /hr_editor.*may not delete/);
denied('no role deletes', await tool(NR, 'delete_rows', { schema: 'nordwind', table: 'faq', filters: [{ column: 'id', op: 'is_null' }] }), /no access/);
const noFilterDel = await tool(AD, 'delete_rows', { schema: 'nordwind', table: 'faq' });
check(noFilterDel.isError && /at least one filter/.test(noFilterDel.text), 'delete without filter → refused', short(noFilterDel.text));
const delTooMany = await tool(AD, 'delete_rows', { schema: 'nordwind', table: 'faq', filters: [{ column: 'question', op: 'like', value: `${faqQ}%` }], max_rows: 2 });
check(delTooMany.isError && /more rows than max_rows/.test(delTooMany.text) && sql(`select count(*) from nordwind.faq where question like '${faqQ}%'`) === '3',
  'delete matching more than max_rows → refused, nothing deleted');
allowed('admin deletes its 3 rows', await tool(AD, 'delete_rows', { schema: 'nordwind', table: 'faq', filters: [{ column: 'question', op: 'like', value: `${faqQ}%` }], max_rows: 3 }),
  (r) => r.json.row_count === 3);
check(sql(`select count(*) from nordwind.faq where question like '${faqQ}%'`) === '0', '… and they are gone');

step('7e. call_function (vector search through match_documents)');
const emb = JSON.parse(sql(`select embedding::text from public.documents where brand = 'nordwind' order by id limit 1`));
const fnArgs = { query_embedding: emb, match_count: 3 };
allowed('admin: match_documents(vector, 3)', await tool(AD, 'call_function', { schema: 'public', name: 'match_documents', args: fnArgs }),
  (r) => r.json.row_count === 3 && r.json.rows[0].similarity > 0.99);
allowed('admin: match_documents with metadata filter', await tool(AD, 'call_function', { schema: 'public', name: 'match_documents',
  args: { ...fnArgs, filter: { sku: 'NW-1002' } } }), (r) => r.json.row_count === 1 && r.json.rows[0].metadata.sku === 'NW-1002');
denied('hr calls match_documents (no EXECUTE)', await tool(HR, 'call_function', { schema: 'public', name: 'match_documents', args: fnArgs }), /hr_editor.*may not call public.match_documents/);
denied('agency calls match_documents', await tool(T, 'call_function', { schema: 'public', name: 'match_documents', args: fnArgs }), /agency_nordwind.*may not call/);
denied('no role calls match_documents', await tool(NR, 'call_function', { schema: 'public', name: 'match_documents', args: fnArgs }), /may not call/);
denied('admin calls a function that does not exist', await tool(AD, 'call_function', { schema: 'public', name: 'drop_everything' }), /may not call public.drop_everything.*match_documents/);
denied('admin calls a function in the plugin schema (cms.*)', await tool(AD, 'call_function', { schema: 'cms', name: 'custom_access_token_hook', args: {} }), /may not call/);

step('7f. storage: list_files / upload_file / download_file / create_signed_url');
const files = (r) => (r.json?.files ?? []).map((f) => f.name).join();
allowed('agency lists own folder', await tool(T, 'list_files', { bucket: 'images', prefix: 'nordwind' }), (r) => r.json.files.length === 2);
const lsOther = await tool(T, 'list_files', { bucket: 'images', prefix: 'suedwind' });
check(!lsOther.isError && lsOther.json.files.length === 0 && /policies/.test(lsOther.json.note), 'agency lists other brand folder → empty, hint to the policies', short(lsOther.text));
allowed('hr lists hr-files', await tool(HR, 'list_files', { bucket: 'hr-files', prefix: 'handbuch' }), (r) => r.json.files.length === 2);
denied('agency lists hr-files bucket', await tool(T, 'list_files', { bucket: 'hr-files', prefix: 'handbuch' }), /agency_nordwind.*cannot see storage bucket `hr-files`.*`images`/);
denied('no role lists images', await tool(NR, 'list_files', { bucket: 'images', prefix: 'nordwind' }), /cannot see storage bucket/);

const upTxt = `mcp-test-${RUN}.txt`;
allowed('admin uploads a text file to images/nordwind', await tool(AD, 'upload_file', { bucket: 'images', path: `nordwind/${upTxt}`,
  content_text: `hello ${RUN}`, content_type: 'text/plain' }), (r) => r.json.uploaded.size === `hello ${RUN}`.length);
allowed('hr uploads a base64 file to hr-files', await tool(HR, 'upload_file', { bucket: 'hr-files', path: `mcp-test-${RUN}.bin`,
  content_base64: Buffer.from('binary\u0000data').toString('base64'), content_type: 'application/octet-stream' }));
const exists = await tool(AD, 'upload_file', { bucket: 'images', path: `nordwind/${upTxt}`, content_text: 'again' });
check(exists.isError && /already exists/.test(exists.text), 'upload to an existing path without upsert → explained', short(exists.text));
allowed('… with upsert=true', await tool(AD, 'upload_file', { bucket: 'images', path: `nordwind/${upTxt}`, content_text: 'again', upsert: true }));
denied('agency uploads', await tool(T, 'upload_file', { bucket: 'images', path: `nordwind/mcp-test-${RUN}-agency.txt`, content_text: 'x' }), /agency_nordwind.*may not upload files in bucket `images`/);
denied('hr uploads to images', await tool(HR, 'upload_file', { bucket: 'images', path: `mcp-test-${RUN}-hr.txt`, content_text: 'x' }), /hr_editor.*cannot see storage bucket `images`/);
denied('no role uploads', await tool(NR, 'upload_file', { bucket: 'images', path: `mcp-test-${RUN}-nr.txt`, content_text: 'x' }), /cannot see storage bucket/);
const big = await tool(AD, 'upload_file', { bucket: 'images', path: `nordwind/mcp-test-${RUN}-big.bin`, content_base64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') });
check(big.isError && /limit is/.test(big.text), 'upload over the size limit → refused before any request', short(big.text));
const badPath = await tool(AD, 'upload_file', { bucket: 'images', path: '../hr-files/x.txt', content_text: 'x' });
check(badPath.isError && /Invalid path/.test(badPath.text), 'upload with ".." in the path → refused', short(badPath.text));
const both = await tool(AD, 'upload_file', { bucket: 'images', path: 'nordwind/x.txt', content_text: 'x', content_base64: 'eA==' });
check(both.isError && /exactly one/.test(both.text), 'upload with both text and base64 → refused');

const dlImg = await tool(T, 'download_file', { bucket: 'images', path: 'nordwind/regenjacke.png' });
allowed('agency downloads an image (returned as image)', dlImg, (r) => r.content.some((c) => c.type === 'image' && c.mimeType === 'image/png' && c.data.length > 10));
const dlTxt = await tool(HR, 'download_file', { bucket: 'hr-files', path: 'handbuch/onboarding.md' });
allowed('hr downloads a text file (returned as text)', dlTxt, (r) => r.content.length === 2 && r.content[1].type === 'text' && r.content[1].text.length > 20);
const dlMine = await tool(AD, 'download_file', { bucket: 'images', path: `nordwind/${upTxt}` });
allowed('admin downloads what it uploaded', dlMine, (r) => r.content[1]?.text === 'again');
const dlBin = await tool(HR, 'download_file', { bucket: 'hr-files', path: `mcp-test-${RUN}.bin` });
allowed('hr downloads a binary file (returned as signed URL)', dlBin, (r) => /\/storage\/v1\/object\/sign\/hr-files\//.test(r.json?.signed_url ?? ''));
if (dlBin.json?.signed_url) { const f = await fetch(dlBin.json.signed_url); check(f.ok && (await f.arrayBuffer()).byteLength === 'binary\u0000data'.length, 'the signed URL works without any token', `HTTP ${f.status}`); }
denied('agency downloads an HR file', await tool(T, 'download_file', { bucket: 'hr-files', path: 'handbuch/onboarding.md' }), /cannot see storage bucket `hr-files`/);
denied('admin downloads an HR file (hr-files is not its bucket)', await tool(AD, 'download_file', { bucket: 'hr-files', path: 'handbuch/onboarding.md' }), /cannot see storage bucket `hr-files`/);
denied('no role downloads an HR file', await tool(NR, 'download_file', { bucket: 'hr-files', path: 'handbuch/onboarding.md' }), /cannot see storage bucket/);
// Finding: `images` is a PUBLIC bucket. The Storage API serves a known path to anyone, policies or not
// (only list, sign, upload, delete follow the policies). The tool reports what Storage does.
allowed('agency downloads another brand\'s image: bucket "images" is public, readable by design', await tool(T, 'download_file', { bucket: 'images', path: 'suedwind/sonnencreme.png' }),
  (r) => r.content.some((c) => c.type === 'image'));

const sgAg = await tool(T, 'create_signed_url', { bucket: 'images', path: 'nordwind/regenjacke.png', expires_in: 120 });
allowed('agency signs an own-folder file', sgAg, (r) => /\/object\/sign\/images\/nordwind\/regenjacke\.png\?token=/.test(r.json.signed_url) && r.json.expires_in_seconds === 120);
if (sgAg.json?.signed_url) { const f = await fetch(sgAg.json.signed_url); check(f.ok && f.headers.get('content-type') === 'image/png', 'signed URL opens without token', `HTTP ${f.status}`); }
if (sgAg.json?.public_url) { const f = await fetch(sgAg.json.public_url); check(f.ok, 'public bucket: permanent public URL included and works', `HTTP ${f.status}`); }
else check(false, 'public bucket: permanent public URL included');
const sgHr = await tool(HR, 'create_signed_url', { bucket: 'hr-files', path: 'handbuch/onboarding.md' });
allowed('hr signs an hr-files file (private bucket)', sgHr, (r) => !r.json.public_url);
if (sgHr.json?.signed_url) { const f = await fetch(sgHr.json.signed_url); check(f.ok, 'signed URL for the private file works', `HTTP ${f.status}`); }
denied('agency signs other brand\'s file (signing follows the policies)', await tool(T, 'create_signed_url', { bucket: 'images', path: 'suedwind/sonnencreme.png' }), /Storage policies of bucket `images`.*agency_nordwind select/);
denied('agency signs an HR file', await tool(T, 'create_signed_url', { bucket: 'hr-files', path: 'handbuch/onboarding.md' }), /cannot see storage bucket `hr-files`/);
denied('no role signs', await tool(NR, 'create_signed_url', { bucket: 'images', path: 'nordwind/regenjacke.png' }), /cannot see storage bucket/);

// clean up the test objects with the owners' own tokens (the MCP has no delete tool)
for (const [tk, bucket, path] of [[AD, 'images', `nordwind/${upTxt}`], [HR, 'hr-files', `mcp-test-${RUN}.bin`]]) {
  const r = await fetch(`${sb}/storage/v1/object/${bucket}/${path}`, { method: 'DELETE', headers: { apikey: ANON, Authorization: `Bearer ${tk}` } });
  check(r.ok, `cleanup: remove ${bucket}/${path}`, `HTTP ${r.status}`);
}

step('7g. rate limit per person');
let limited = null; let n = 0;
for (; n < 400 && !limited; n++) {
  const r = await tool(SW, 'whoami');
  if (r.isError && /Rate limit/.test(r.text)) limited = r;
}
check(!!limited && limited.json.retry_after_seconds >= 1, `agentur.suedwind is rate limited after ${n} quick calls`, limited ? short(limited.text, 100) : 'never limited (is MCP_RATE_BURST raised?)');
check(!(await tool(AD, 'whoami')).isError, 'the limit is per person: admin is not affected');

// ── 8. audit ────────────────────────────────────────────────────────────────────────────────
step('8. Audit log');
const row = sql(`select db_role||' | '||coalesce(jwt_email,'-')||' | client='||coalesce(jwt_client_id,'-')||' | '||op||' '||table_name||' | '||changes::text
                   from audit.change_log where table_name='nordwind.products' order by id desc limit 1`);
console.log(`   last audit row: ${row}`);
check(row.includes('agency_nordwind') && row.includes(USER) && row.includes(client.client_id), 'audit shows role, e-mail and OAuth client');
check(sql(`select count(*) from audit.change_log where changes ? 'price' and jwt_email = '${USER}'`) === '0', 'no price change logged for the agency');
check(sql(`select count(*) from audit.change_log where table_name = 'nordwind.faq' and jwt_email = 'admin@example.com' and at >= to_timestamp(${START_S})`) === '9',
  'audit: the admin\'s 3 inserts, 3 updates and 3 deletes via MCP name the admin', 'see audit.change_log');

// ── 9. storage API with the same role switch ────────────────────────────────────────────────
step('9. Storage API honours the role claim');
const list = async (token, bucket, prefix) => {
  const r = await fetch(`${sb}/storage/v1/object/list/${bucket}`, { method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix }) });
  return r.ok ? (await r.json()).map((o) => o.name) : [];
};
const hrTok = HR;
check((await list(hrTok, 'hr-files', 'handbuch')).length === 2, 'hr_editor lists hr-files', (await list(hrTok, 'hr-files', 'handbuch')).join(', '));
check((await list(T, 'hr-files', 'handbuch')).length === 0, 'agency sees no hr-files');
check((await list(T, 'images', 'nordwind')).length === 2 && (await list(T, 'images', 'suedwind')).length === 0,
  'agency lists only its own image folder', `nordwind=${(await list(T, 'images', 'nordwind')).length} suedwind=${(await list(T, 'images', 'suedwind')).length}`);
const dl = await fetch(`${sb}/storage/v1/object/hr-files/handbuch/onboarding.md`, { headers: { apikey: ANON, Authorization: `Bearer ${T}` } });
check(dl.status >= 400, 'agency download of an HR file → denied', `HTTP ${dl.status}`);

// ── 10. plugin introspection over PostgREST (cms_api, through the gateway like a Cloud client) ─
step('10. cms_api.describe() / effective_rights over PostgREST');
const rpc = async (token, fn, args = {}) => {
  const r = await fetch(`${sb}/rest/v1/rpc/${fn}`, { method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Profile': 'cms_api' },
    body: JSON.stringify(args) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const col = (d, schema, table, column) => d?.schemas?.find((s) => s.name === schema)?.tables?.find((t) => t.name === table)
  ?.columns?.find((x) => x.name === column);
const dAg = await rpc(T, 'describe');
const nameCol = col(dAg.body, 'nordwind', 'products', 'name');
const priceCol = col(dAg.body, 'nordwind', 'products', 'price');
check(dAg.status === 200 && dAg.body?.role === 'agency_nordwind', 'agency (OAuth token) calls describe()', `HTTP ${dAg.status} role=${dAg.body?.role}`);
check(nameCol?.privileges?.update === true, 'products.name shown as updatable', JSON.stringify(nameCol?.privileges));
check(priceCol?.privileges?.select === true && priceCol?.privileges?.update === false, 'products.price shown as read-only', JSON.stringify(priceCol?.privileges));
check(JSON.stringify(dAg.body?.schemas?.map((s) => s.name)) === '["nordwind"]'
  && JSON.stringify(dAg.body?.storage?.buckets?.map((b) => b.id)) === '["images"]', 'agency sees only nordwind + bucket images',
  `schemas=${dAg.body?.schemas?.map((s) => s.name)} buckets=${dAg.body?.storage?.buckets?.map((b) => b.id)}`);
const whoRpc = await rpc(T, 'whoami');
check(whoRpc.body?.email === USER && whoRpc.body?.client_id === client.client_id, 'whoami() names person + OAuth client', `${whoRpc.body?.email} client=${whoRpc.body?.client_id}`);
const effAg = await rpc(T, 'effective_rights', { role_name: 'cms_admin' });
check(effAg.status === 403 && effAg.body?.code === '42501', 'agency effective_rights(cms_admin) → denied', `HTTP ${effAg.status} ${effAg.body?.message ?? ''}`);
const adminTok = AD;
const effAd = await rpc(adminTok, 'effective_rights', { role_name: 'agency_nordwind' });
check(effAd.status === 200 && JSON.stringify(effAd.body?.schemas) === JSON.stringify(dAg.body?.schemas),
  'admin effective_rights(agency_nordwind) = the agency\'s own describe()', `HTTP ${effAd.status}`);
const dHr = await rpc(hrTok, 'describe');
check(JSON.stringify(dHr.body?.storage?.buckets?.map((b) => b.id)) === '["hr-files"]', 'hr_editor sees bucket hr-files', `buckets=${dHr.body?.storage?.buckets?.map((b) => b.id)}`);
const dAnon = await rpc(ANON, 'describe');
check(dAnon.status === 403 || dAnon.status === 401, 'anon describe() → denied', `HTTP ${dAnon.status}`);
const cmsDirect = await fetch(`${sb}/rest/v1/settings`, { headers: { apikey: ANON, Authorization: `Bearer ${adminTok}`, 'Accept-Profile': 'cms' } });
check(cmsDirect.status === 406, 'schema cms is not exposed', `HTTP ${cmsDirect.status}`);

// ── 11. access log of the MCP server (only when its stdout is given) ────────────────────────
if (LOG_FILE) {
  step('11. MCP access log (JSON lines, no data, no tokens)');
  const raw = readFileSync(LOG_FILE, 'utf8');
  const lines = raw.split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const access = lines.filter((l) => l?.type === 'access');
  check(access.length > 0 && lines.every((l) => l), 'every log line is valid JSON', `${access.length} access lines`);
  check(EXPECTED.every((t) => access.some((l) => l.tool === t)), 'every tool appears in the log');
  check(access.every((l) => l.ts && l.sub && l.tool && l.status && l.ms !== undefined), 'each line has time, sub, tool, status, duration');
  check(['ok', 'denied', 'error', 'rate_limited'].every((st) => access.some((l) => l.status === st) || st === 'error'), 'statuses ok, denied and rate_limited are logged',
    [...new Set(access.map((l) => l.status))].join(', '));
  check(access.some((l) => l.email === USER && l.client_id === client.client_id && l.tool === 'update_rows' && l.target === 'nordwind.products'),
    'the agency\'s update is logged with e-mail, OAuth client and table');
  check(!/eyJ[A-Za-z0-9_-]{10,}\./.test(raw), 'no JWT anywhere in the log');
  check(![newName, 'Regenjacke Marineblau', `hello ${RUN}`, faqQ, env.TEST_USER_PASSWORD].some((v) => raw.includes(v)), 'no data values (names, texts, file content) and no password in the log');
}

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
