// node --test test/ — pure helpers of the admin area and the change log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarizeChange, summarizeRights, userStatus, whoChanged } from '../src/format.js';

const fixture = (n) => JSON.parse(readFileSync(new URL(`./fixtures/describe-${n}.json`, import.meta.url)));

test('change log: UPDATE lists each column, INSERT/DELETE one line', () => {
  assert.deepEqual(summarizeChange({ op: 'UPDATE', changes: { name: { old: 'A', new: 'B' }, price: { old: 1, new: null } } }),
    ['name: A → B', 'price: 1 → ∅']);
  assert.deepEqual(summarizeChange({ op: 'INSERT', changes: { id: 1 } }), ['created']);
  assert.deepEqual(summarizeChange({ op: 'DELETE', changes: { id: 1 } }), ['deleted']);
  assert.match(summarizeChange({ op: 'UPDATE', changes: { d: { old: 'x'.repeat(200), new: 'y' } } })[0], /…/);
});

test('change log: role assignments read as such', () => {
  const t = 'cms.user_roles';
  assert.deepEqual(summarizeChange({ op: 'INSERT', changes: { email: 'a@b.co', db_role: 'hr_editor' } }, t), ['assigned role hr_editor to a@b.co']);
  assert.deepEqual(summarizeChange({ op: 'UPDATE', changes: { email: 'a@b.co', db_role: { old: 'hr_editor', new: 'cms_admin' } } }, t),
    ['changed the role of a@b.co: hr_editor → cms_admin']);
  assert.deepEqual(summarizeChange({ op: 'DELETE', changes: { email: 'a@b.co', db_role: 'hr_editor' } }, t), ['removed role hr_editor from a@b.co']);
});

test('who changed: e-mail, else the role', () => {
  assert.equal(whoChanged({ jwt_email: 'admin@example.com', db_role: 'cms_admin' }), 'admin@example.com');
  assert.equal(whoChanged({ jwt_email: null, db_role: 'postgres' }), 'postgres (no sign-in)');
});

test('rights summary from a real describe() answer: agency may only update names', () => {
  const s = summarizeRights(fixture('agentur'));
  assert.equal(s.role, 'agency_nordwind');
  const p = s.tables.find((t) => t.name === 'nordwind.products');
  assert.deepEqual([p.select, p.insert, p.update, p.delete], [true, false, true, false]);
  assert.deepEqual(p.updatableColumns, ['name']);
  assert.ok(p.readOnlyColumns.includes('price'));
  assert.deepEqual(s.buckets.map((b) => b.id), ['images']);
  assert.equal(summarizeRights(null).tables.length, 0);
});

test('user status', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  assert.equal(userStatus({ last_sign_in_at: null }, now), 'invited');
  assert.equal(userStatus({ last_sign_in_at: '2026-10-01T00:00:00Z' }, now), 'active');
  assert.equal(userStatus({ last_sign_in_at: '2026-10-01T00:00:00Z', banned_until: '2126-01-01T00:00:00Z' }, now), 'blocked');
  assert.equal(userStatus({ last_sign_in_at: '2026-10-01T00:00:00Z', banned_until: '2020-01-01T00:00:00Z' }, now), 'active');
});
