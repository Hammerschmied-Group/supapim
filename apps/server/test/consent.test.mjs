// /oauth/consent forwards to the UI's consent route (no stack needed): node --test apps/server/test
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerConsent } from '../src/consent.mjs';

async function withServer(fn) {
  const app = express();
  await registerConsent(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('consent: forwards to /cms/#/consent with the authorization id; page keeps the text the chain test looks for', () => withServer(async (base) => {
  const r = await fetch(`${base}/oauth/consent?authorization_id=abc123XYZ`);
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.match(html, /http-equiv="refresh" content="0;url=\/cms\/#\/consent\?authorization_id=abc123XYZ"/);
  assert.match(html, /href="\/cms\/#\/consent\?authorization_id=abc123XYZ"/);
  assert.ok(html.includes('möchte Zugriff'));
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
}));

test('consent: a missing or odd id is not forwarded (and cannot break out of the attribute)', () => withServer(async (base) => {
  for (const q of ['', '?authorization_id=', '?authorization_id=a%22%3E%3Cscript%3E', '?authorization_id=a&authorization_id=b', `?authorization_id=${'x'.repeat(300)}`]) {
    const html = await (await fetch(`${base}/oauth/consent${q}`)).text();
    assert.ok(html.includes('url=/cms/#/consent"'), `no id forwarded for ${q.slice(0, 40)}`);
    assert.ok(!html.includes('<script'));
  }
}));
