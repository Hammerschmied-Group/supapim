// Unit tests for the pure parts of the MCP module (no stack needed): node --test apps/server/test
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, columnsOf, filterParams, hasRowFilter, selectColumns } from '../src/mcp/filters.mjs';
import { TokenBuckets } from '../src/mcp/ratelimit.mjs';
import { accessLogLine } from '../src/mcp/log.mjs';
import { explainDenied, explainStorageDenied } from '../src/mcp/errors.mjs';
import { okResult } from '../src/mcp/result.mjs';
import { loadConfig } from '../src/config.mjs';

test('filters: operators map to PostgREST syntax', () => {
  const p = filterParams([
    { column: 'sku', op: 'eq', value: 'NW-1' }, { column: 'price', op: 'gte', value: 5 }, { column: 'name', op: 'ilike', value: '%jacke%' },
    { column: 'status', op: 'in', value: ['draft', 'a,b', 'say "hi"'] }, { column: 'status', op: 'not_in', value: ['x'] },
    { column: 'd', op: 'is_null' }, { column: 'd', op: 'not_null' }, { column: 'tags', op: 'contains', value: ['a', 'b'] },
  ]);
  assert.deepEqual(p, [
    ['sku', 'eq.NW-1'], ['price', 'gte.5'], ['name', 'ilike.%jacke%'],
    ['status', 'in.(draft,"a,b","say \\"hi\\"")'], ['status', 'not.in.(x)'], ['d', 'is.null'], ['d', 'not.is.null'], ['tags', 'cs.{a,b}'],
  ]);
});

test('filters: bad input is an error, not a silent no-op', () => {
  assert.throws(() => filterParams([{ column: 'a', op: 'in', value: 'x' }]), /needs an array/);
  assert.throws(() => filterParams([{ column: 'a', op: 'eq' }]), /needs a value/);
  assert.throws(() => filterParams([{ column: 'a', op: 'eq', value: [1] }]), /single value/);
});

test('filters: values cannot add query parameters (URL-encoded)', () => {
  const qs = buildQuery({ filters: [{ column: 'name', op: 'eq', value: 'x&limit=1&select=password' }] });
  assert.equal([...qs.keys()].join(), 'name');
  assert.match(qs.toString(), /name=eq\.x%26limit%3D1%26select%3Dpassword/);
});

test('filters: update/delete need a real row filter, not only select/limit/order', () => {
  assert.equal(hasRowFilter(buildQuery({})), false);
  assert.equal(hasRowFilter(buildQuery({ filter: 'select=id&limit=1&order=id' })), false);
  assert.equal(hasRowFilter(buildQuery({ filter: 'id=eq.1' })), true);
  assert.equal(hasRowFilter(buildQuery({ filter: 'or=(a.eq.1,b.eq.2)' })), true);
  assert.equal(hasRowFilter(buildQuery({ filters: [{ column: 'id', op: 'is_null' }] })), true);
});

test('filters: columns for error explanations', () => {
  assert.deepEqual(columnsOf({ filters: [{ column: 'sku', op: 'eq', value: 1 }], filter: 'price=lt.5&limit=2' }).sort(), ['price', 'sku']);
  assert.deepEqual(selectColumns('id,name,price'), ['id', 'name', 'price']);
  assert.deepEqual(selectColumns('*'), ['*']);
  assert.deepEqual(selectColumns('id,alias:name,images(id,alt_text)'), ['id', 'name']);   // embedded resources are not columns
});

test('rate limit: burst, refill, per key', () => {
  let t = 0;
  const b = new TokenBuckets({ burst: 3, perMinute: 60, now: () => t });
  assert.ok(b.take('a').ok && b.take('a').ok && b.take('a').ok);
  const blocked = b.take('a');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.retryAfterSeconds, 1);
  assert.ok(b.take('other').ok, 'other person unaffected');
  t = 1000;                                   // 60/min = 1 token per second
  assert.ok(b.take('a').ok);
  assert.equal(b.take('a').ok, false);
  t = 60_000;                                 // never above the burst
  assert.ok(b.take('a').ok && b.take('a').ok && b.take('a').ok);
  assert.equal(b.take('a').ok, false);
  b.sweep();
  t = 200_000; b.sweep();
  assert.equal(b.buckets.size, 0, 'idle full buckets are dropped');
});

test('access log: fixed fields only, no values or tokens', () => {
  const line = JSON.parse(accessLogLine({
    sub: 's', email: 'a@b.c', role: 'r', client_id: 'c', tool: 'update_rows', target: 'nordwind.products', status: 'denied', rows: 0, code: '42501', ms: 7,
    token: 'eyJsecret.x.y', values: { price: 1 }, args: { a: 1 },
  }, new Date('2026-10-28T12:00:00Z')));
  assert.deepEqual(Object.keys(line).sort(), ['client_id', 'code', 'email', 'ms', 'role', 'rows', 'status', 'sub', 'target', 'tool', 'ts', 'type']);
  assert.equal(line.ts, '2026-10-28T12:00:00.000Z');
});

const D = {
  role: 'agency_nordwind',
  schemas: [{ name: 'nordwind', functions: [], tables: [
    { name: 'products', privileges: { select: true, insert: false, update: true, delete: false }, rls: { policies: [{ name: 'rbac: agency_nordwind update', command: 'update' }] },
      columns: [
        { name: 'name', privileges: { select: true, insert: false, update: true } },
        { name: 'price', privileges: { select: true, insert: false, update: false } },
        { name: 'secret', privileges: { select: false, insert: false, update: false } },
      ] },
  ] }],
  storage: { object_privileges: { select: true, insert: false, update: false, delete: false },
    buckets: [{ id: 'images', object_policies: [{ name: 'rbac: agency_nordwind select', command: 'select', using: "name ~~ 'nordwind/%'" }] }] },
};

test('explain 42501: update of a read-only column names role, column and what is allowed', () => {
  const m = explainDenied(D, { schema: 'nordwind', table: 'products', op: 'update', columns: ['name', 'price'], filterColumns: ['name'] });
  assert.equal(m, 'Role `agency_nordwind` may not change column `price` in `nordwind.products`. Allowed to update: `name`.');
});
test('explain 42501: select * names the unreadable columns; filter on an unreadable column too', () => {
  assert.match(explainDenied(D, { schema: 'nordwind', table: 'products', op: 'select', columns: ['*'] }), /column `secret` of `nordwind.products` \(needed by select=\*\)\. Readable: `name`, `price`/);
  assert.match(explainDenied(D, { schema: 'nordwind', table: 'products', op: 'select', columns: ['name'], filterColumns: ['secret'] }), /may not read column `secret`/);
});
test('explain 42501: insert/delete, unknown schema/table, RLS', () => {
  assert.match(explainDenied(D, { schema: 'nordwind', table: 'products', op: 'insert', columns: ['name'] }), /may not insert rows in `nordwind.products`/);
  assert.match(explainDenied(D, { schema: 'nordwind', table: 'products', op: 'delete' }), /may not delete rows/);
  assert.match(explainDenied(D, { schema: 'suedwind', table: 'x', op: 'select' }), /no access to schema `suedwind`.*`nordwind`/);
  assert.match(explainDenied(D, { schema: 'nordwind', table: 'nope', op: 'select' }), /no access to table `nordwind.nope`.*`products`/);
  assert.match(explainDenied(D, { schema: 'nordwind', table: 'products', op: 'update', columns: ['name'] },
    { message: 'new row violates row-level security policy for table "products"' }), /Row-level security.*Policies for update: `rbac: agency_nordwind update`/);
});
test('explain storage refusals', () => {
  assert.match(explainStorageDenied(D, { bucket: 'hr-files', op: 'read' }), /cannot see storage bucket `hr-files`.*`images`/);
  assert.match(explainStorageDenied(D, { bucket: 'images', op: 'upload' }), /may not upload files in bucket `images`/);
  assert.match(explainStorageDenied(D, { bucket: 'images', op: 'read' }, 400), /Policies for select: `rbac: agency_nordwind select` \(name ~~ 'nordwind\/%'\)/);
});

test('result: oversized row lists are cut with a note', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ i, blob: 'x'.repeat(1000) }));
  const out = JSON.parse(okResult({ rows, row_count: 100 }, { maxChars: 20_000 }).content[0].text);
  assert.equal(out.truncated, true);
  assert.ok(out.rows.length < 100 && out.rows.length >= 1);
  assert.match(out.note, /showing \d+ of 100 rows/);
});

test('config: the MCP part carries the anon key only, nothing else from the environment', () => {
  const cfg = loadConfig({ SUPABASE_ANON_KEY: 'anon', SERVICE_ROLE_KEY: 'svc', SUPABASE_SECRET_KEY: 'sec', JWT_SECRET: 'j', POSTGRES_PASSWORD: 'p' });
  const dump = JSON.stringify(cfg.mcp);
  for (const secret of ['svc', 'sec', '"j"', '"p"']) assert.ok(!dump.includes(secret), `config.mcp must not carry ${secret}`);
  assert.equal(cfg.mcp.anonKey, 'anon');
});
