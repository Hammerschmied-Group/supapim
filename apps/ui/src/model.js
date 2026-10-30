// cms_api.describe() → the UI model. Pure functions, no React, unit-tested in test/model.test.js.
//
// One resource per visible table or view, named "<schema>.<table>". Everything the UI shows or
// offers comes from the column and table privileges Postgres reports for the signed-in role:
//   column without select        → not shown at all (also never requested: see readColumns)
//   column without update        → read-only in the edit form
//   column without insert        → not in the create form
//   no insert / delete / update  → no Create button / Delete button / edit view (show view instead)
// RLS can still reject single rows; the UI then shows the database error.
//
// UI hints live in Postgres comments, so customers set them in SQL or Studio and describe()
// already carries them: "… @cms(markdown)", "@cms(hidden)", "@cms(label=Titel)",
// "@cms(image, bucket=images)" (5b). See ARCHITECTURE.md, "Hints in comments".

const HINT = /@cms\(([^)]*)\)/g;
const WIDGETS = new Set(['text', 'textarea', 'markdown', 'html', 'json', 'image', 'file', 'hidden', 'readonly']);
const LONG_TEXT = /(^|_)(description|answer|content|body|notes?|summary|html|markdown)$/;
const LABEL_COLUMNS = ['name', 'title', 'label', 'question', 'email', 'sku', 'slug', 'code'];
/** Timestamps the database keeps itself (default now(), moddatetime trigger): shown, never offered as input. */
const AUTO_TIMESTAMPS = new Set(['created_at', 'updated_at', 'inserted_at', 'modified_at']);
/** Order columns; in a gallery (child table with an image column) the gallery's arrows set them. */
export const ORDER_COLUMNS = ['position', 'sort_order', 'sort', 'rank'];

/** "Bildpfad @cms(image, bucket=images)" → { widget: 'image', bucket: 'images' } */
export function parseHints(comment) {
  const hints = {};
  if (!comment) return hints;
  for (const [, body] of comment.matchAll(HINT)) {
    for (const part of body.split(',').map((s) => s.trim()).filter(Boolean)) {
      const eq = part.indexOf('=');
      if (eq === -1) {
        if (WIDGETS.has(part)) hints.widget = part;
        else hints[part] = true;
      } else {
        hints[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
      }
    }
  }
  return hints;
}

/** The comment without its @cms(...) hints, for helper texts. */
export function stripHints(comment) {
  return comment ? comment.replace(HINT, '').replace(/\s+/g, ' ').trim() || null : null;
}

export function humanize(name) {
  const s = name.replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const baseUdt = (udt) => udt.split('.').pop().replace(/^_/, '');

/** Which input/field a column gets. Order: explicit hint, reference, generated, type. */
export function widgetFor(column) {
  const { hints, category, udt, isArray, name } = column;
  if (hints.widget) return hints.widget;
  if (column.reference) return 'reference';
  const base = baseUdt(udt);
  if (base === 'markdown' || base === 'html') return base;        // domains named markdown / html
  if (category === 'enum') return isArray ? 'enumArray' : 'enum';
  if (isArray) return ['text', 'varchar', 'bpchar', 'citext'].includes(base) ? 'textArray' : 'json';
  switch (category) {
    case 'boolean': return 'boolean';
    case 'number': return 'number';
    case 'datetime':
      if (base === 'date') return 'date';
      if (base === 'timestamp' || base === 'timestamptz') return 'datetime';
      return 'text';                                                  // time, timetz
    case 'string': return base === 'text' && LONG_TEXT.test(name) ? 'textarea' : 'text';
    case 'user':
      if (base === 'json' || base === 'jsonb') return 'json';
      if (base === 'vector' || base === 'halfvec' || base === 'sparsevec' || base === 'tsvector') return 'opaque';
      return 'text';                                                  // uuid and other scalar types
    default: return 'text';                                           // timespan, network, geometric …
  }
}

/**
 * What the role may do in one bucket, from describe().storage: the bucket must be visible to the
 * role (storage.buckets policy), the object table must carry the privilege, and an object policy
 * for the command (or ALL) must exist. Storage still decides per object; this only decides which
 * buttons are offered.
 */
export function bucketAbilities(storage, bucketId) {
  const b = (storage?.buckets ?? []).find((x) => x.id === bucketId);
  if (!b) return { known: false, public: false, select: false, insert: false, update: false, delete: false };
  const can = (cmd) => !!storage.object_privileges?.[cmd]
    && (b.object_policies ?? []).some((p) => p.command === 'all' || p.command === cmd);
  return { known: true, public: !!b.public, select: can('select'), insert: can('insert'), update: can('update'), delete: can('delete') };
}

/**
 * image / file columns (D8): the text column holds the object path. A column without a bucket
 * hint falls back to plain text. Images pick up their alt text and title from sibling columns
 * (alt_text / title_attr, or @cms(alt=…, title=…)); those are shown inside the image field and
 * marked consumedBy, so forms do not render them twice. Each column keeps its own privileges.
 */
function resolveStorage(columns, storage) {
  for (const c of columns) {
    if (c.widget !== 'image' && c.widget !== 'file') continue;
    if (!c.hints.bucket || c.category !== 'string' || c.isArray) { c.widget = 'text'; continue; }
    const sibling = (hint, fallback) => {
      if (c.widget !== 'image') return null;
      const s = columns.find((x) => x.name === (c.hints[hint] ?? fallback));
      return s && s !== c && s.canRead && s.category === 'string' && !s.isArray && !s.consumedBy ? s : null;
    };
    const alt = sibling('alt', 'alt_text');
    const title = sibling('title', 'title_attr');
    if (alt) alt.consumedBy = c.name;
    if (title) title.consumedBy = c.name;
    c.storage = { bucket: c.hints.bucket, kind: c.widget, alt: alt?.name ?? null, title: title?.name ?? null,
      ...bucketAbilities(storage, c.hints.bucket) };
  }
}

/** Widgets that do not fit into a list cell. */
const NOT_IN_LIST = new Set(['markdown', 'html', 'json', 'opaque', 'hidden', 'textArray', 'enumArray']);
const MAX_LIST_COLUMNS = 7;

/**
 * Column default → form default, only for plain literals ('EUR'::text, 'active'::status, true, 0).
 * Expressions such as now() or gen_random_uuid() stay with the database (undefined here).
 */
export function literalDefault(expr) {
  if (expr == null) return undefined;
  if (expr === 'true' || expr === 'false') return expr === 'true';
  if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
  const m = /^'((?:[^']|'')*)'::[\w."]+(\[\])?$/.exec(expr);
  if (!m) return undefined;
  const text = m[1].replace(/''/g, "'");
  if (/::jsonb?$/.test(expr)) { try { return JSON.parse(text); } catch { return undefined; } }
  return m[2] ? undefined : text;
}

function buildColumn(c, table) {
  const hints = parseHints(c.comment);
  const col = {
    name: c.name,
    label: hints.label ?? humanize(c.name),
    help: stripHints(c.comment),
    type: c.type,
    udt: c.udt,
    category: c.category,
    isArray: c.is_array,
    nullable: c.nullable,
    hasDefault: c.default != null || c.identity != null || c.generated != null,
    defaultValue: literalDefault(c.default),
    enum: c.enum ?? null,
    hints,
    canRead: c.privileges.select,
    // identity ALWAYS and generated columns can never be written, whatever the grants say
    canInsert: c.privileges.insert && c.identity !== 'a' && !c.generated,
    canUpdate: c.privileges.update && c.identity !== 'a' && !c.generated,
    reference: null,
  };
  const fk = table.foreign_keys.find((f) => f.columns.length === 1 && f.columns[0] === c.name);
  if (fk && fk.references.readable && fk.references.columns.length === 1) {
    col.reference = { resource: `${fk.references.schema}.${fk.references.table}`, column: fk.references.columns[0] };
  }
  col.widget = widgetFor(col);
  return col;
}

function recordLabelColumn(columns) {
  const readable = columns.filter((c) => c.canRead);
  for (const n of LABEL_COLUMNS) if (readable.some((c) => c.name === n)) return n;
  return readable.find((c) => c.widget === 'text' && c.category === 'string')?.name ?? null;
}

/**
 * @param {object} describe  the JSON returned by cms_api.describe()
 * @param {object} [whoami]    cms_api.whoami(): can_read_audit decides whether the change log is shown
 * @returns {{role: string, isAdmin: boolean, canReadAudit: boolean, schemas: {name, label, comment, resources: string[]}[],
 *            resources: object[], byName: Record<string, object>}}
 */
export function buildModel(describe, whoami = null) {
  const resources = [];
  const schemas = [];
  for (const s of describe.schemas ?? []) {
    const names = [];
    for (const t of s.tables ?? []) {
      const hints = parseHints(t.comment);
      if (hints.widget === 'hidden' || hints.hidden) continue;
      const columns = t.columns.map((c) => buildColumn(c, t));
      resolveStorage(columns.filter((c) => c.canRead), describe.storage);
      const visible = columns.filter((c) => c.canRead && c.widget !== 'hidden');
      // a primary key the role cannot read is no key for the UI: rows are then read-only
      const pk = t.primary_key && t.primary_key.every((k) => visible.some((c) => c.name === k)) ? t.primary_key : null;
      const p = t.privileges;
      const r = {
        name: `${s.name}.${t.name}`,
        schema: s.name,
        table: t.name,
        kind: t.kind,
        label: hints.label ?? humanize(t.name),
        help: stripHints(t.comment),
        hints,
        primaryKey: pk,
        columns: visible,
        // vectors are never loaded: the UI shows only their type, and 1536 floats per row add up
        readColumns: visible.filter((c) => c.widget !== 'opaque').map((c) => c.name),
        canList: p.select && visible.length > 0,
        canCreate: p.insert && visible.some((c) => c.canInsert),
        canEdit: !!pk && p.update && visible.some((c) => c.canUpdate),
        canDelete: !!pk && p.delete,
        labelColumn: recordLabelColumn(visible),
        referencedBy: [],
        // @cms(singleton) on the table: one row (a brand's settings) — no list, the menu opens that row
        isSingleton: !!hints.singleton && !!pk,
      };
      // a table named settings without its own label is labelled in the UI language
      if (r.isSingleton && t.name === 'settings' && !hints.label) r.labelKey = 'cms.settings.title';
      if (!r.canList && !r.canCreate) continue;      // e.g. delete-only: nothing the UI can show
      resources.push(r);
      names.push(r.name);
    }
    // a singleton (the brand's settings) comes first in its group
    names.sort((a, b) => Number(!!resources.find((x) => x.name === b).isSingleton) - Number(!!resources.find((x) => x.name === a).isSingleton));
    if (names.length) schemas.push({ name: s.name, label: humanize(s.name), comment: s.comment ?? null, resources: names });
  }

  const byName = Object.fromEntries(resources.map((r) => [r.name, r]));
  // keep only references to resources the role can list, and record the reverse direction
  for (const r of resources) {
    for (const c of r.columns) {
      if (!c.reference) continue;
      const target = byName[c.reference.resource];
      if (!target?.canList || !target.primaryKey || target.primaryKey.length !== 1 || target.primaryKey[0] !== c.reference.column) {
        c.reference = null;
        c.widget = widgetFor(c);
        continue;
      }
      if (r.canList) target.referencedBy.push({ resource: r.name, column: c.name, label: r.label });
    }
    r.listColumns = pickListColumns(r);
  }
  markSystemManaged(resources);
  return { role: describe.role, isAdmin: !!describe.is_admin, canReadAudit: !!whoami?.can_read_audit, schemas, resources, byName,
           storage: describe.storage ?? null };
}

/**
 * Columns the system fills, not the editor: automatic timestamps, and the order column (position, sort_order …),
 * which the gallery (images of a parent record) or the list's drag-and-drop sets. systemManaged is about the forms
 * only — the columns stay readable, the grants are untouched, and gallery and list still write the order with the
 * real privileges. @cms(readonly) in the column comment marks any other column the same way.
 * Also sets r.isGallery and r.orderColumn (the list can be reordered when the role may update it).
 */
function markSystemManaged(resources) {
  for (const r of resources) {
    r.isGallery = r.columns.some((c) => c.storage?.kind === 'image' && c.storage.known) && r.columns.some((c) => c.reference);
    const order = r.primaryKey?.length === 1 ? r.columns.find((c) => ORDER_COLUMNS.includes(c.name) && c.category === 'number') : null;
    r.orderColumn = order?.name ?? null;
    // drag-and-drop in the list: not for gallery tables (their order is per parent record, set in the gallery)
    r.canReorder = !!order && !r.isGallery && r.canList && r.canEdit && order.canUpdate;
    for (const c of r.columns) {
      if ((AUTO_TIMESTAMPS.has(c.name) && (c.widget === 'datetime' || c.widget === 'date')) || c.hints.readonly || c === order) {
        c.systemManaged = true;
      }
    }
  }
}

function pickListColumns(r) {
  const cols = r.columns.filter((c) => !NOT_IN_LIST.has(c.widget));
  // surrogate uuid keys tell an editor nothing; keep them only if nothing else is there
  const useful = cols.filter((c) => !(r.primaryKey?.includes(c.name) && c.udt === 'uuid'));
  return (useful.length ? useful : cols).slice(0, MAX_LIST_COLUMNS).map((c) => c.name);
}

/**
 * The columns a form or show view renders as fields of their own: alt text and title live inside
 * the image field, unless that field is not part of the form (create form without insert right on the path).
 */
export function formColumns(resource, include = () => true) {
  const shown = resource.columns.filter(include);
  const names = new Set(shown.map((c) => c.name));
  return shown.filter((c) => !c.consumedBy || !names.has(c.consumedBy));
}

/**
 * Only the fields the role may write, for create (insert) or update. On create, empty values of
 * columns with a database default are left out, so the default applies (now(), identity …).
 */
export function writableData(resource, data, mode) {
  const cols = new Map(resource.columns.filter((c) => (mode === 'create' ? c.canInsert : c.canUpdate)).map((c) => [c.name, c]));
  return Object.fromEntries(Object.entries(data).filter(([k, v]) =>
    cols.has(k) && !(mode === 'create' && cols.get(k).hasDefault && (v == null || v === ''))));
}
