#!/usr/bin/env node
// Storage backend check: what the CMS and the MCP server rely on, run against the live stack with a
// real person's token (admin@example.com, role cms_admin) through the gateway. Backend-neutral —
// meant to qualify a storage backend (local volume, Hetzner / any S3) before using it.
//   small upload + byte-identical download, image render (imgproxy), signed URL, list,
//   large upload (multipart to S3), resumable upload (TUS, 6 MB chunks), upsert, delete,
//   and that policies still hold (agency cannot read HR files).
// Writes only below images/_storage-check/ and removes everything again. Prints no secrets.
import { readFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';

const root = new URL('..', import.meta.url).pathname;
const env = Object.fromEntries(readFileSync(`${root}.env`, 'utf8').split('\n')
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));
const SB = env.SUPABASE_PUBLIC_URL;
const ANON = env.ANON_KEY;
const PREFIX = `_storage-check/${Date.now()}`;

let failed = 0;
const check = (ok, label, detail = '') => { if (!ok) failed++; console.log(`   ${ok ? 'PASS' : '** FAIL **'}  ${label}${detail ? `  — ${detail}` : ''}`); };
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);

async function login(email) {
  const r = await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: env.TEST_USER_PASSWORD }) });
  if (!r.ok) throw new Error(`login ${email}: HTTP ${r.status}`);
  return (await r.json()).access_token;
}
const H = (token, extra = {}) => ({ apikey: ANON, Authorization: `Bearer ${token}`, ...extra });

// a real PNG, so imgproxy has something to render
function png(w, h) {
  const row = Buffer.alloc(1 + w * 3); const raw = [];
  for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) row.set([(x * 7) & 255, (y * 5) & 255, 120], 1 + x * 3); raw.push(Buffer.from(row)); }
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([Buffer.from(t), d]))); return Buffer.concat([len, Buffer.from(t), d, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(raw))), chunk('IEND', Buffer.alloc(0))]);
}

const admin = await login('admin@example.com');
const agency = await login('agentur.nordwind@example.com');
console.log(`== storage backend check (STORAGE_BACKEND=${env.STORAGE_BACKEND || 'file'}), objects under images/${PREFIX}/`);

const created = [];
async function upload(name, body, type, upsert = false) {
  const r = await fetch(`${SB}/storage/v1/object/images/${PREFIX}/${name}`, { method: 'POST',
    headers: H(admin, { 'Content-Type': type, ...(upsert ? { 'x-upsert': 'true' } : {}) }), body });
  if (r.ok) created.push(`${PREFIX}/${name}`);
  return r;
}
const download = async (name, token = admin) => {
  const r = await fetch(`${SB}/storage/v1/object/authenticated/images/${PREFIX}/${name}`, { headers: H(token) });
  return { status: r.status, body: r.ok ? Buffer.from(await r.arrayBuffer()) : null };
};

try {
  // 1. small file, byte-identical round trip
  const img = png(640, 400);
  let r = await upload('small.png', img, 'image/png');
  check(r.ok, 'upload small image', `HTTP ${r.status} ${r.ok ? '' : await r.text()}`);
  let d = await download('small.png');
  check(d.status === 200 && d.body.equals(img), 'download is byte-identical', `${img.length} B, sha ${sha(img)} / ${d.body ? sha(d.body) : '-'}`);

  // 2. image transformation (imgproxy reads the object through the backend)
  r = await fetch(`${SB}/storage/v1/render/image/authenticated/images/${PREFIX}/small.png?width=200&height=125&resize=contain`, { headers: H(admin) });
  const rendered = r.ok ? Buffer.from(await r.arrayBuffer()) : Buffer.alloc(0);
  check(r.ok && rendered.length > 0 && !rendered.equals(img), 'image render (imgproxy)', `HTTP ${r.status}, ${r.headers.get('content-type')}, ${rendered.length} B`);

  // 3. signed URL, fetched without any key
  r = await fetch(`${SB}/storage/v1/object/sign/images/${PREFIX}/small.png`, { method: 'POST',
    headers: H(admin, { 'Content-Type': 'application/json' }), body: JSON.stringify({ expiresIn: 60 }) });
  const signed = r.ok ? (await r.json()).signedURL : null;
  const s = signed ? await fetch(`${SB}/storage/v1${signed}`) : null;
  check(!!s && s.ok && Buffer.from(await s.arrayBuffer()).equals(img), 'signed URL works without a key', `HTTP ${s?.status}`);

  // 4. large upload (the S3 backend uses multipart above its part size)
  const big = randomBytes(18 * 1024 * 1024);
  r = await upload('large.bin', big, 'application/octet-stream');
  check(r.ok, 'upload 18 MB (multipart)', `HTTP ${r.status} ${r.ok ? '' : (await r.text()).slice(0, 200)}`);
  d = await download('large.bin');
  check(d.status === 200 && d.body.equals(big), '18 MB download is byte-identical', `sha ${sha(big)} / ${d.body ? sha(d.body) : '-'}`);

  // 5. resumable upload (TUS), 6 MB chunks as Supabase requires
  const tusBody = randomBytes(13 * 1024 * 1024);
  const meta = { bucketName: 'images', objectName: `${PREFIX}/resumable.bin`, contentType: 'application/octet-stream' };
  r = await fetch(`${SB}/storage/v1/upload/resumable`, { method: 'POST', headers: H(admin, {
    'Tus-Resumable': '1.0.0', 'Upload-Length': String(tusBody.length),
    'Upload-Metadata': Object.entries(meta).map(([k, v]) => `${k} ${Buffer.from(v).toString('base64')}`).join(',') }) });
  const loc = r.headers.get('location');
  let offset = 0, tusOk = r.status === 201 && !!loc;
  const CHUNK = 6 * 1024 * 1024;
  while (tusOk && offset < tusBody.length) {
    const part = tusBody.subarray(offset, offset + CHUNK);
    const p = await fetch(loc.startsWith('http') ? loc : `${SB}${loc}`, { method: 'PATCH', headers: H(admin, {
      'Tus-Resumable': '1.0.0', 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' }), body: part });
    tusOk = p.status === 204; if (!tusOk) console.log(`      PATCH at ${offset}: HTTP ${p.status} ${(await p.text()).slice(0, 200)}`);
    offset += part.length;
  }
  if (tusOk) created.push(meta.objectName);
  d = await download('resumable.bin');
  check(tusOk && d.status === 200 && d.body.equals(tusBody), 'resumable upload (TUS, 3 chunks) is byte-identical', `create HTTP ${r.status}, sha ${sha(tusBody)} / ${d.body ? sha(d.body) : '-'}`);

  // 6. upsert replaces the content
  const v2 = png(320, 200);
  r = await upload('small.png', v2, 'image/png', true);
  d = await download('small.png');
  check(r.ok && d.body?.equals(v2), 'upsert replaces the object', `HTTP ${r.status}`);

  // 7. list
  r = await fetch(`${SB}/storage/v1/object/list/images`, { method: 'POST', headers: H(admin, { 'Content-Type': 'application/json' }), body: JSON.stringify({ prefix: PREFIX }) });
  const names = r.ok ? (await r.json()).map((o) => o.name).sort() : [];
  check(names.join(',') === 'large.bin,resumable.bin,small.png', 'list shows the three objects', names.join(', '));

  // 8. policies still decide (backend-independent)
  r = await fetch(`${SB}/storage/v1/object/authenticated/hr-files/handbuch/onboarding.md`, { headers: H(agency) });
  check(r.status >= 400, 'agency cannot read an HR file', `HTTP ${r.status}`);
  r = await fetch(`${SB}/storage/v1/object/authenticated/hr-files/handbuch/onboarding.md`, { headers: H(await login('hr@example.com')) });
  check(r.ok, 'HR reads its seeded file from the backend', `HTTP ${r.status}`);
} finally {
  // 9. delete (also the cleanup)
  if (created.length) {
    const r = await fetch(`${SB}/storage/v1/object/images`, { method: 'DELETE', headers: H(admin, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefixes: [...new Set(created)] }) });
    const gone = (await download('small.png')).status;
    check(r.ok && gone >= 400, 'delete removes the objects', `HTTP ${r.status}, afterwards ${gone}`);
  }
}

console.log(`\n${failed === 0 ? 'ALL STORAGE CHECKS PASSED' : `${failed} STORAGE CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
