// list_tables: the one place that tells the model what exists. Built from cms_api.describe(), which
// computes it from the catalog for the person's role, so it shows exactly what Postgres will allow.
import { z } from 'zod';
import { errorResult, okResult } from '../result.mjs';
import { ident } from '../filters.mjs';

const rights = (p) => ['select', 'insert', 'update', 'delete'].filter((k) => p?.[k]);

export function compactTable(t) {
  return {
    name: t.name,
    kind: t.kind,
    ...(t.comment ? { comment: t.comment } : {}),
    can: rights(t.privileges),
    primary_key: t.primary_key,
    columns: t.columns.map((c) => ({
      name: c.name,
      type: c.type,
      ...(c.nullable ? { nullable: true } : {}),
      ...(c.default != null ? { default: c.default } : {}),
      ...(c.enum ? { enum: c.enum } : {}),
      ...(c.comment ? { comment: c.comment } : {}),
      can: rights(c.privileges),
    })),
    ...(t.foreign_keys?.length ? { foreign_keys: t.foreign_keys.map((f) => ({
      columns: f.columns, references: `${f.references.schema}.${f.references.table}(${f.references.columns.join(',')})` })) } : {}),
  };
}

export function registerTables({ tool, supabase }) {
  tool('list_tables', {
    title: 'List tables, functions and buckets',
    description:
      'Lists what the signed-in person can access: schemas with tables (columns, types, primary keys, foreign keys), ' +
      'callable functions and storage buckets. "can" shows the rights of the role per table and per column ' +
      '(select, insert, update, delete); anything not listed is not allowed. Call this first. Optionally narrow to one schema.',
    inputSchema: { schema: ident.optional().describe('Only this schema') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ auth, args, entry }) => {
    const d = await supabase.describe(auth, { fresh: true });
    if (!d.ok) {
      return errorResult('Could not load the access overview (cms_api.describe). Is the plugin migration installed and cms_api exposed to PostgREST?',
        { http_status: d.status, postgres: d.error });
    }
    const { role, is_admin, schemas, storage } = d.describe;
    const picked = args.schema ? schemas.filter((s) => s.name === args.schema) : schemas;
    entry.target = args.schema ?? '*';
    return okResult({
      role, is_admin,
      schemas: picked.map((s) => ({
        name: s.name,
        ...(s.comment ? { comment: s.comment } : {}),
        tables: s.tables.map(compactTable),
        functions: s.functions.map((f) => ({ name: f.name, arguments: f.arguments, returns: f.returns,
          volatility: f.volatility, ...(f.comment ? { comment: f.comment } : {}) })),
      })),
      storage: storage ? {
        object_rights: rights(storage.object_privileges),
        buckets: storage.buckets.map((b) => ({ id: b.id, public: b.public, policies: (b.object_policies ?? []).map((p) => ({ name: p.name, command: p.command, restriction: p.using ?? p.check ?? null })) })),
      } : null,
      ...(args.schema && !picked.length ? { note: `Role ${role} has no access to schema ${args.schema}.` } : {}),
      ...(!schemas.length && !(storage?.buckets?.length) ? { note: `Role ${role} has no access to any table, function or bucket. Ask an admin to assign a role.` } : {}),
    });
  });
}
