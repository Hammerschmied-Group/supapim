// node --test test/  — the pure parts of src/storage.js (object names) and the upload flow against a fake client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage, directoryOf, objectPath, sanitizeFileName } from '../src/storage.js';

test('sanitizeFileName keeps names URL- and policy-safe', () => {
  assert.equal(sanitizeFileName('Größe & Preis (1).PNG'), 'Grosse-Preis-1.png');
  assert.equal(sanitizeFileName('regenjacke.png'), 'regenjacke.png');
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFileName('.png'), 'png');
  assert.equal(sanitizeFileName('日本.jpg'), 'file.jpg');
  assert.equal(sanitizeFileName('archive.tar.gz'), 'archive-tar.gz');
});

test('directoryOf / objectPath', () => {
  assert.equal(directoryOf('nordwind/fleece.png'), 'nordwind');
  assert.equal(directoryOf('a/b/c.png'), 'a/b');
  assert.equal(directoryOf('fleece.png'), '');
  assert.equal(directoryOf(null), '');
  assert.equal(objectPath({ directory: 'suedwind', fileName: 'Neu Bild.png' }), 'suedwind/Neu-Bild.png');
  assert.equal(objectPath({ directory: 'suedwind/', fileName: 'x.png', suffix: 'ab12' }), 'suedwind/x-ab12.png');
  assert.equal(objectPath({ directory: '', fileName: 'x' , suffix: 's'}), 'x-s');
});

function fakeClient(handlers) {
  return { storage: { from: (bucket) => ({ ...handlers, bucket }) } };
}

test('upload never overwrites: a taken name gets a suffix', async () => {
  const tried = [];
  const s = createStorage(fakeClient({
    upload: async (path, _file, opts) => {
      tried.push(path);
      assert.equal(opts.upsert, false);
      return tried.length === 1 ? { error: { statusCode: '409', message: 'The resource already exists' } } : { error: null };
    },
  }));
  const path = await s.upload({ bucket: 'images' }, { name: 'a.png', type: 'image/png' }, { directory: 'suedwind' });
  assert.equal(tried[0], 'suedwind/a.png');
  assert.match(path, /^suedwind\/a-[a-z0-9]+\.png$/);
});

test('upload surfaces the policy error of Storage', async () => {
  const s = createStorage(fakeClient({ upload: async () => ({ error: Object.assign(new Error('new row violates row-level security policy'), { statusCode: '403' }) }) }));
  await assert.rejects(s.upload({ bucket: 'images' }, { name: 'a.png' }, { directory: 'nordwind' }), /row-level security/);
});

test('previewUrl: public bucket → imgproxy render URL, private bucket → signed URL', async () => {
  const seen = [];
  const s = createStorage(fakeClient({
    getPublicUrl: (p, o) => { seen.push(['public', p, o.transform]); return { data: { publicUrl: 'http://x/render/image/public/images/' + p } }; },
    createSignedUrl: async (p, ttl, o) => { seen.push(['signed', p, o.transform]); return { data: { signedUrl: 'http://x/render/image/sign/hr/' + p + '?token=t' } }; },
  }));
  assert.match(await s.previewUrl({ bucket: 'images', public: true }, 'a.png', { width: 100, height: 100 }), /render\/image\/public/);
  assert.match(await s.previewUrl({ bucket: 'hr', public: false }, 'a.png'), /render\/image\/sign.*token/);
  assert.deepEqual(seen[0][2], { width: 100, height: 100, resize: 'contain' });
  assert.equal(seen[1][0], 'signed');
});

test('remove reports a silent refusal (empty list) as an error', async () => {
  const s = createStorage(fakeClient({ remove: async () => ({ data: [], error: null }) }));
  await assert.rejects(s.remove({ bucket: 'images' }, 'a.png'), /did not remove/);
  const ok = createStorage(fakeClient({ remove: async () => ({ data: [{ name: 'a.png' }], error: null }) }));
  await ok.remove({ bucket: 'images' }, 'a.png');
});
