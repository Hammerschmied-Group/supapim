// Token checks of the MCP endpoint against a fake Supabase (JWKS + a counter for everything else),
// no stack needed: node --test apps/server/test. Every bad token must get 401 with a WWW-Authenticate
// challenge that names the resource metadata, and must never cause a request to PostgREST or Storage.
// A valid token is the positive control: it passes the gate and its calls DO reach the fake PostgREST
// with the person's own token, so "0 calls" for the bad ones is not vacuous.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { loadConfig } from '../src/config.mjs';
import { registerMcp } from '../src/mcp/index.mjs';
import { createAuthenticator } from '../src/mcp/auth.mjs';

const ISS = 'http://fake.test/auth/v1';
const USER = '11111111-1111-4111-8111-111111111111';

const { publicKey, privateKey } = await generateKeyPair('ES256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
const stranger = await generateKeyPair('ES256');

const nowS = () => Math.floor(Date.now() / 1000);
function sign(claims = {}, { key = privateKey, kid = 'k1', alg = 'ES256', iss = ISS, aud = 'authenticated', exp = nowS() + 300, nbf } = {}) {
  const jwt = new SignJWT({ role: 'cms_admin', email: 'admin@example.com', ...claims }).setProtectedHeader({ alg, kid })
    .setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(exp);
  if (claims.sub !== null) jwt.setSubject(claims.sub ?? USER);
  if (nbf) jwt.setNotBefore(nbf);
  return jwt.sign(key);
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unsigned = (header, payload) => `${b64(header)}.${b64(payload)}.`;
const payload = (extra = {}) => ({ sub: USER, role: 'cms_admin', iss: ISS, aud: 'authenticated', exp: nowS() + 300, ...extra });

// fake Supabase: serves the JWKS, records every other request
const seen = [];
const supa = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c); req.on('end', () => {
    const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/auth/v1/.well-known/jwks.json') return send(200, { keys: [jwk] });
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, apikey: req.headers.apikey });
    if (req.url === '/rest/v1/rpc/describe') return send(200, { role: 'cms_admin', is_admin: true, schemas: [], storage: { buckets: [] } });
    send(404, {});
  });
});
await new Promise((r) => supa.listen(0, '127.0.0.1', r));
const SUPA = `http://127.0.0.1:${supa.address().port}`;

const cfg = loadConfig({ SUPABASE_URL: SUPA, SUPABASE_PUBLIC_URL: 'http://fake.test', AUTH_ISSUER: ISS, SUPABASE_ANON_KEY: 'anon-public', PORT: '1' }).mcp;
const app = express();
registerMcp(app, cfg);
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const MCP = `http://127.0.0.1:${srv.address().port}/cms/mcp`;
after(() => { srv.close(); supa.close(); });

const rpc = (token, method = 'POST', body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tables', arguments: {} } }) =>
  fetch(MCP, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'POST' ? JSON.stringify(body) : undefined });

const seed = await sign({ role: 'agency_nordwind' });   // a valid token, tampered with below
const bad = {
  'no token': undefined,
  'junk': 'not.a.jwt',
  'empty bearer': ' ',
  'expired': await sign({}, { exp: nowS() - 60 }),
  'not yet valid (nbf in the future)': await sign({}, { nbf: nowS() + 3600 }),
  'signed with a foreign key (same kid)': await sign({}, { key: stranger.privateKey }),
  'unknown kid': await sign({}, { kid: 'zzz' }),
  'wrong issuer': await sign({}, { iss: 'http://evil.test/auth/v1' }),
  'wrong audience': await sign({}, { aud: 'someone-else' }),
  'no audience': await new SignJWT({ role: 'cms_admin' }).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setSubject(USER).setIssuer(ISS).setExpirationTime('5m').sign(privateKey),
  'alg=none': unsigned({ alg: 'none', typ: 'JWT' }, payload()),
  'alg=none, kid of the real key': unsigned({ alg: 'none', kid: 'k1' }, payload()),
  'HS256 with the public key as secret (algorithm confusion)': await sign({}, { key: new TextEncoder().encode(JSON.stringify(jwk)), alg: 'HS256' }),
  'valid signature, no sub': await sign({ sub: null }),
  'valid signature, no role': await sign({ role: undefined }),
  'role anon': await sign({ role: 'anon' }),
  'role service_role': await sign({ role: 'service_role' }),
  'role supabase_admin': await sign({ role: 'supabase_admin' }),
  'role postgres': await sign({ role: 'postgres' }),
  'role authenticator': await sign({ role: 'authenticator' }),
  'truncated signature': (await sign()).slice(0, -6),
  'payload swapped after signing': (() => { const [h, , sig] = seed.split('.'); return `${h}.${b64(payload({ role: 'cms_admin' }))}.${sig}`; })(),
};

test('every bad token → 401 + WWW-Authenticate with resource_metadata, and no call reaches PostgREST or Storage', async () => {
  for (const [name, token] of Object.entries(bad)) {
    for (const method of ['POST', 'GET', 'DELETE']) {
      seen.length = 0;
      const r = await rpc(token, method);
      const body = await r.json().catch(() => null);
      assert.equal(r.status, 401, `${name} (${method}) → ${r.status}`);
      const challenge = r.headers.get('www-authenticate') ?? '';
      assert.match(challenge, /^Bearer resource_metadata="http:\/\/fake\.test\/\.well-known\/oauth-protected-resource\/cms\/mcp"/, `${name}: challenge`);
      assert.match(challenge, /error="invalid_token"/, `${name}: challenge error`);
      assert.equal(body?.error, 'invalid_token', `${name}: body`);
      assert.deepEqual(seen, [], `${name} (${method}) must not reach PostgREST or Storage`);
    }
  }
});

test('a bad token never lets the body through: tool calls in the request body are not executed', async () => {
  seen.length = 0;
  const calls = [{ name: 'list_tables', arguments: {} }, { name: 'select_rows', arguments: { schema: 'nordwind', table: 'products' } },
    { name: 'list_files', arguments: { bucket: 'images' } }, { name: 'call_function', arguments: { schema: 'public', name: 'match_documents' } }];
  for (const params of calls) {
    for (const token of [bad['alg=none'], bad['expired'], bad['signed with a foreign key (same kid)']]) {
      const r = await rpc(token, 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params });
      assert.equal(r.status, 401);
    }
  }
  assert.deepEqual(seen, []);
});

test('the error text names a reason but never echoes the token', async () => {
  for (const [name, token] of Object.entries(bad)) {
    if (!token || token.length < 20) continue;
    const r = await rpc(token);
    const text = (r.headers.get('www-authenticate') ?? '') + (await r.text());
    assert.ok(!text.includes(token.split('.')[1] ?? token), `${name}: payload of the token is echoed`);
  }
});

test('positive control: a valid token passes, and its calls reach PostgREST with the person\'s own token', async () => {
  const token = await sign({ role: 'agency_nordwind', email: 'agentur@example.com' });
  seen.length = 0;
  const init = await rpc(token, 'POST', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(init.status, 200);
  const who = await (await rpc(token, 'POST', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } })).json();
  assert.match(who.result.content[0].text, /agentur@example\.com/);
  assert.deepEqual(seen, [], 'whoami reads the token only');
  const lt = await (await rpc(token)).json();
  assert.equal(lt.result.isError, undefined);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/rest/v1/rpc/describe');
  assert.equal(seen[0].authorization, `Bearer ${token}`, 'the person\'s token is passed on unchanged');
  assert.equal(seen[0].apikey, 'anon-public', 'the gateway apikey is the public anon key');
  assert.equal(((await rpc(token, 'GET')).status), 405, 'a valid token on GET gets 405, not 401');
});

test('createAuthenticator directly: returns claims for a valid token, a reason for the rest', async () => {
  const authenticate = createAuthenticator(cfg);
  const req = (t) => ({ headers: t === undefined ? {} : { authorization: `Bearer ${t}` } });
  const ok = await authenticate(req(await sign({ role: 'hr_editor' })));
  assert.equal(ok.error, undefined);
  assert.equal(ok.claims.role, 'hr_editor');
  assert.equal(ok.claims.sub, USER);
  for (const [name, token] of Object.entries(bad)) {
    const r = await authenticate(req(token));
    assert.ok(r.error && !r.token && !r.claims, `${name}: rejected`);
  }
  assert.match((await authenticate(req(bad['expired']))).error, /ERR_JWT_EXPIRED/);
  assert.match((await authenticate(req(bad['signed with a foreign key (same kid)']))).error, /ERR_JWS_SIGNATURE_VERIFICATION_FAILED/);
  assert.match((await authenticate(req(bad['wrong issuer']))).error, /ERR_JWT_CLAIM_VALIDATION_FAILED/);
  assert.match((await authenticate(req(bad['wrong audience']))).error, /ERR_JWT_CLAIM_VALIDATION_FAILED/);
  assert.match((await authenticate(req(bad['role service_role']))).error, /not a user token/);
});
