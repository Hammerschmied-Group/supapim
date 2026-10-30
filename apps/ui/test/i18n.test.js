// German must cover every English key (react-admin's pack and ours), and the other way round.
// Every cms.* key used in src/ must exist in both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import en from '../src/i18n/en.js';
import de from '../src/i18n/de.js';

const keys = (o, prefix = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
const enKeys = new Set(keys(en));
const deKeys = new Set(keys(de));

test('German has every English key', () => {
  assert.deepEqual([...enKeys].filter((k) => !deKeys.has(k)), []);
});

test('German has no keys English lacks', () => {
  assert.deepEqual([...deKeys].filter((k) => !enKeys.has(k)), []);
});

test('placeholders agree between English and German', () => {
  const get = (o, k) => k.split('.').reduce((a, p) => a?.[p], o);
  const holes = (s) => [...String(s).matchAll(/%\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const bad = [...enKeys].filter((k) => holes(get(en, k)) !== holes(get(de, k)));
  assert.deepEqual(bad.map((k) => `${k}: ${get(en, k)} ≠ ${get(de, k)}`), []);
});

test('every cms.* key used in src/ exists', () => {
  const dir = new URL('../src/', import.meta.url);
  const used = new Set();
  for (const f of readdirSync(dir).filter((n) => /\.(jsx?|js)$/.test(n))) {
    for (const m of readFileSync(new URL(f, dir), 'utf8').matchAll(/['"](cms\.[a-z_]+(?:\.[a-z_]+)+)['"]/g)) used.add(m[1]);
  }
  assert.ok(used.size > 40);
  assert.deepEqual([...used].filter((k) => !enKeys.has(k)), []);
});
