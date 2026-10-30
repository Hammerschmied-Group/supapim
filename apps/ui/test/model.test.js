// node --test test/  — the describe() → UI model mapping, against real describe() answers of the demo roles
// (fixtures captured from the local stack on 28.10.2026; no secrets in them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bucketAbilities, buildModel, formColumns, literalDefault, parseHints, stripHints, widgetFor, writableData } from '../src/model.js';

const fixture = (n) => JSON.parse(readFileSync(new URL(`./fixtures/describe-${n}.json`, import.meta.url)));
const col = (r, n) => r.columns.find((c) => c.name === n);

test('agency: only its brand, name editable, price read-only, no create/delete', () => {
  const m = buildModel(fixture('agentur'));
  assert.equal(m.role, 'agency_nordwind');
  assert.deepEqual(m.schemas.map((s) => s.name), ['nordwind']);
  const p = m.byName['nordwind.products'];
  assert.equal(p.canList, true);
  assert.equal(p.canEdit, true);
  assert.equal(p.canCreate, false);
  assert.equal(p.canDelete, false);
  assert.equal(col(p, 'name').canUpdate, true);
  assert.equal(col(p, 'price').canUpdate, false);
  assert.equal(col(p, 'status').widget, 'enum');
  assert.deepEqual(col(p, 'status').enum, ['draft', 'active', 'archived']);
  assert.equal(p.labelColumn, 'name');
  const faq = m.byName['nordwind.faq'];
  assert.equal(faq.canEdit, false, 'faq: select only → show view');
});

test('foreign keys become references in both directions', () => {
  const m = buildModel(fixture('agentur'));
  const img = m.byName['nordwind.product_images'];
  assert.equal(col(img, 'product_id').widget, 'reference');
  assert.deepEqual(col(img, 'product_id').reference, { resource: 'nordwind.products', column: 'id' });
  assert.deepEqual(m.byName['nordwind.products'].referencedBy,
    [{ resource: 'nordwind.product_images', column: 'product_id', label: 'Product images' }]);
});

test('hr: no brand schemas, documents read-only, vector column opaque', () => {
  const m = buildModel(fixture('hr'));
  assert.deepEqual(m.schemas.map((s) => s.name), ['public']);
  const d = m.byName['public.documents'];
  assert.equal(d.canEdit, false);
  assert.equal(d.canCreate, false);
  assert.equal(col(d, 'embedding').widget, 'opaque');
  assert.equal(col(d, 'metadata').widget, 'json');
  assert.equal(col(d, 'content').widget, 'textarea');
  assert.ok(!d.listColumns.includes('embedding'));
  assert.ok(!d.readColumns.includes('embedding'), 'vectors are never fetched');
  assert.equal(col(d, 'id').canInsert, false, 'identity always is never writable');
});

test('admin: everything, create + delete; no role: nothing', () => {
  const m = buildModel(fixture('admin'));
  assert.deepEqual(m.schemas.map((s) => s.name).sort(), ['nordwind', 'public', 'suedwind']);
  const p = m.byName['suedwind.products'];
  assert.equal(p.canCreate && p.canDelete && p.canEdit, true);
  assert.equal(col(p, 'price').canUpdate, true);
  assert.equal(buildModel(fixture('ohne')).resources.length, 0);
});

test('readColumns never contains a column without select', () => {
  const d = structuredClone(fixture('agentur'));
  const t = d.schemas[0].tables.find((x) => x.name === 'products');
  t.columns.find((c) => c.name === 'price').privileges.select = false;
  t.columns.find((c) => c.name === 'price').privileges.update = true;      // write-only stays invisible
  const p = buildModel(d).byName['nordwind.products'];
  assert.ok(!p.readColumns.includes('price'));
  assert.equal(col(p, 'price'), undefined);
});

test('writableData strips what the role may not write', () => {
  const p = buildModel(fixture('agentur')).byName['nordwind.products'];
  assert.deepEqual(writableData(p, { id: 'x', name: 'N', price: 1 }, 'update'), { name: 'N' });
  assert.deepEqual(writableData(p, { name: 'N' }, 'create'), {});
  const admin = buildModel(fixture('admin')).byName['nordwind.products'];
  assert.deepEqual(writableData(admin, { sku: 'X', currency: '', updated_at: null, active: false }, 'create'),
    { sku: 'X', active: false }, 'empty values with a DB default are left to the database');
});

test('literal defaults prefill the create form, expressions do not', () => {
  assert.equal(literalDefault("'EUR'::text"), 'EUR');
  assert.equal(literalDefault("'active'::nordwind.product_status"), 'active');
  assert.equal(literalDefault("'it''s'::text"), "it's");
  assert.equal(literalDefault('true'), true);
  assert.equal(literalDefault('0'), 0);
  assert.deepEqual(literalDefault("'{}'::jsonb"), {});
  assert.equal(literalDefault('now()'), undefined);
  assert.equal(literalDefault('gen_random_uuid()'), undefined);
  assert.equal(literalDefault(null), undefined);
});

test('hints in comments', () => {
  assert.deepEqual(parseHints('Bildpfad @cms(image, bucket=images)'), { widget: 'image', bucket: 'images' });
  assert.deepEqual(parseHints('@cms(markdown) @cms(label=Antwort)'), { widget: 'markdown', label: 'Antwort' });
  assert.deepEqual(parseHints(null), {});
  assert.equal(stripHints('Antwort für die Website. @cms(markdown)'), 'Antwort für die Website.');
  const base = { hints: {}, isArray: false, name: 'x', reference: null };
  assert.equal(widgetFor({ ...base, category: 'string', udt: 'public.markdown' }), 'markdown');
  assert.equal(widgetFor({ ...base, category: 'array', isArray: true, udt: '_text' }), 'textArray');
  assert.equal(widgetFor({ ...base, category: 'array', isArray: true, udt: '_int4' }), 'json');
  assert.equal(widgetFor({ ...base, category: 'datetime', udt: 'date' }), 'date');
  assert.equal(widgetFor({ ...base, category: 'datetime', udt: 'timestamptz' }), 'datetime');
  assert.equal(widgetFor({ ...base, category: 'user', udt: 'uuid' }), 'text');
  assert.equal(widgetFor({ ...base, hints: { widget: 'html' }, category: 'string', udt: 'text' }), 'html');
});

// ── 5b: image columns (ARCHITECTURE D8) ─────────────────────────────────────────────────────────
test('parseHints: image with bucket, alt and title overrides', () => {
  assert.deepEqual(parseHints('Pfad @cms(image, bucket=images, alt=alt, title=caption)'),
    { widget: 'image', bucket: 'images', alt: 'alt', title: 'caption' });
  assert.deepEqual(parseHints('@cms(file, bucket=hr-files)'), { widget: 'file', bucket: 'hr-files' });
});

test('agency: image field with preview, alt text and title, but no upload and no path change', () => {
  const m = buildModel(fixture('agentur'));
  const img = m.byName['nordwind.product_images'];
  const path = col(img, 'storage_path');
  assert.equal(path.widget, 'image');
  assert.equal(path.storage.bucket, 'images');
  assert.equal(path.storage.alt, 'alt_text');
  assert.equal(path.storage.title, 'title_attr');
  assert.equal(path.storage.known, true);
  assert.equal(path.storage.public, true);
  assert.equal(path.storage.select, true);
  assert.equal(path.storage.insert, false, 'object policy select only → no upload button');
  assert.equal(path.storage.delete, false);
  assert.equal(path.canUpdate, false, 'path column is not updatable for the agency');
  // alt text and title keep their own column privileges …
  assert.equal(col(img, 'alt_text').canUpdate, true);
  assert.equal(col(img, 'title_attr').canUpdate, true);
  // … and are shown inside the image field, not twice
  assert.equal(col(img, 'alt_text').consumedBy, 'storage_path');
  assert.ok(!formColumns(img).some((c) => c.name === 'alt_text' || c.name === 'title_attr'));
  assert.ok(formColumns(img).some((c) => c.name === 'storage_path'));
});

test('admin: the object policies allow upload and delete', () => {
  const m = buildModel(fixture('admin'));
  for (const s of ['nordwind', 'suedwind']) {
    const path = col(m.byName[`${s}.product_images`], 'storage_path');
    assert.equal(path.widget, 'image');
    assert.equal(path.storage.insert, true);
    assert.equal(path.storage.delete, true);
    assert.equal(path.canInsert && path.canUpdate, true);
  }
});

test('formColumns: alt text stays a field of its own if the image field is not part of the form', () => {
  const m = buildModel(fixture('admin'));
  const img = m.byName['suedwind.product_images'];
  const without = formColumns(img, (c) => c.name !== 'storage_path');
  assert.ok(without.some((c) => c.name === 'alt_text'));
});

test('image hint without bucket, or on a non-text column, falls back to a plain widget', () => {
  const d = fixture('admin');
  const t = d.schemas.find((s) => s.name === 'suedwind').tables.find((x) => x.name === 'product_images');
  t.columns.find((c) => c.name === 'storage_path').comment = '@cms(image)';
  t.columns.find((c) => c.name === 'position').comment = '@cms(image, bucket=images)';
  const r = buildModel(d).byName['suedwind.product_images'];
  assert.equal(col(r, 'storage_path').widget, 'text');
  assert.equal(col(r, 'storage_path').storage, undefined);
  assert.equal(col(r, 'position').widget, 'text', 'an int column cannot hold an object path');
  assert.equal(col(r, 'alt_text').consumedBy, undefined);
});

test('alt= and title= name other sibling columns; a missing sibling is simply absent', () => {
  const d = fixture('admin');
  const t = d.schemas.find((s) => s.name === 'suedwind').tables.find((x) => x.name === 'product_images');
  t.columns.find((c) => c.name === 'storage_path').comment = '@cms(image, bucket=images, alt=title_attr, title=nope)';
  const r = buildModel(d).byName['suedwind.product_images'];
  assert.equal(col(r, 'storage_path').storage.alt, 'title_attr');
  assert.equal(col(r, 'storage_path').storage.title, null);
  assert.equal(col(r, 'alt_text').consumedBy, undefined);
});

test('bucketAbilities: bucket must be visible, privilege and policy both needed', () => {
  const st = fixture('agentur').storage;
  assert.deepEqual(bucketAbilities(st, 'images'), { known: true, public: true, select: true, insert: false, update: false, delete: false });
  assert.equal(bucketAbilities(st, 'hr-files').known, false, 'bucket not visible to this role');
  assert.equal(bucketAbilities(fixture('hr').storage, 'hr-files').public, false);
  assert.equal(bucketAbilities(fixture('hr').storage, 'hr-files').insert, true);
  // policy without privilege on storage.objects does not count
  const noPriv = { ...fixture('admin').storage, object_privileges: { select: true, insert: false, update: false, delete: false } };
  assert.equal(bucketAbilities(noPriv, 'images').insert, false);
  assert.equal(bucketAbilities(undefined, 'images').known, false);
});

test('system-managed columns: timestamps and order columns; the list reorders, galleries order per parent', () => {
  const m = buildModel(fixture('admin'));
  const images = m.byName['nordwind.product_images'];
  const products = m.byName['nordwind.products'];
  const faq = m.byName['nordwind.faq'];
  assert.equal(col(products, 'updated_at').systemManaged, true);
  assert.equal(col(images, 'updated_at').systemManaged, true);
  assert.equal(col(images, 'position').systemManaged, true);      // the gallery's arrows set it
  assert.equal(col(faq, 'position').systemManaged, true);          // the list's drag-and-drop sets it
  assert.equal(faq.canReorder, true);
  assert.equal(images.canReorder, false);                          // ordered per product, in the gallery
  assert.equal(products.canReorder, false);                        // no order column
  assert.equal(col(images, 'alt_text').systemManaged, undefined);
  // still readable and still granted: only the forms leave them alone, the gallery still writes the order
  assert.equal(col(images, 'position').canUpdate, true);
  assert.deepEqual(Object.keys(writableData(images, { position: 3 }, 'edit')), ['position']);
});

test('agency: FAQ cannot be reordered (no update on position)', () => {
  const m = buildModel(fixture('agentur'));
  assert.equal(m.byName['nordwind.faq'].canReorder, false);
});

test('settings: @cms(singleton) → one row, first in the brand group, labelled in the UI language', () => {
  const m = buildModel(fixture('admin'));
  const s = m.byName['nordwind.settings'];
  assert.equal(s.isSingleton, true);
  assert.equal(s.labelKey, 'cms.settings.title');
  assert.equal(m.schemas.find((x) => x.name === 'nordwind').resources[0], 'nordwind.settings');
  assert.equal(m.byName['nordwind.products'].isSingleton, false);
  assert.equal(col(s, 'logo_path').storage.kind, 'image');
  assert.equal(col(s, 'logo_path').storage.alt, 'logo_alt');
  assert.equal(col(s, 'updated_at').systemManaged, true);
  assert.equal(col(s, 'default_currency').widget, 'enum');
  assert.equal(col(s, 'default_locale').widget, 'enum');           // dropdown, not free text
  assert.ok(col(s, 'default_locale').enum.includes('en-GB'));
  // the agency reads the settings, but may not change them
  const a = buildModel(fixture('agentur')).byName['nordwind.settings'];
  assert.equal(a.isSingleton, true);
  assert.equal(a.canEdit, false);
});

test('currency: an enum of ISO codes (dropdown); empty on create → the brand default', () => {
  const p = buildModel(fixture('admin')).byName['nordwind.products'];
  const c = col(p, 'currency');
  assert.equal(c.widget, 'enum');
  assert.ok(c.enum.includes('EUR') && c.enum.includes('CHF'));
  assert.equal(c.hasDefault, true);
  assert.deepEqual(writableData(p, { name: 'X', price: 1, currency: '' }, 'create'), { name: 'X', price: 1 });
});
