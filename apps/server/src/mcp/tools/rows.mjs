// Row tools. Every call goes to PostgREST with the person's token. Updates and deletes need a
// filter and a row limit; the limit is enforced by PostgREST itself (Prefer: max-affected) so a
// too-broad filter changes nothing at all.
import { z } from 'zod';
import { errorResult, okResult } from '../result.mjs';
import { postgrestFailure } from '../errors.mjs';
import { buildQuery, columnsOf, filtersArg, hasRowFilter, ident, selectColumns } from '../filters.mjs';

const rawFilter = z.string().default('').describe(
  'Optional raw PostgREST query string, e.g. "price=lt.20&active=is.true". Prefer `filters`; use this only for syntax they cannot express (or=(…), nested paths).');
const maxRows = z.number().int().min(1).max(500).default(25)
  .describe('Safety limit: if more rows would be affected, nothing is changed and an error is returned');

const SELECT_DESC = 'Which columns, PostgREST syntax: "id,name,price". Avoid "*" on tables with large text or vector columns.';

export function registerRows({ tool, supabase, cfg }) {
  const fail = async (r, ctx, auth, entry) => {
    const out = await postgrestFailure(r, ctx, () => supabase.describe(auth));
    entry.status = out.denied ? 'denied' : 'error';
    entry.code = out.code;
    return out.result;
  };
  const noFilter = () => errorResult('This operation needs at least one filter so it cannot touch the whole table. Use `filters`, e.g. [{"column":"id","op":"eq","value":"…"}].');

  tool('select_rows', {
    title: 'Read rows',
    description: 'Reads rows from a table. Use `filters` for conditions, `order` for sorting, `limit`/`offset` for paging.',
    inputSchema: {
      schema: ident, table: ident,
      select: z.string().default('*').describe(SELECT_DESC),
      filters: filtersArg, filter: rawFilter,
      order: z.array(z.object({ column: ident, direction: z.enum(['asc', 'desc']).default('asc') })).max(5).default([]),
      limit: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0),
      count: z.boolean().default(false).describe('Also return the total number of matching rows'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ auth, args, entry }) => {
    const { schema, table, select, filters, filter, order, limit, offset, count } = args;
    entry.target = `${schema}.${table}`;
    let qs;
    try { qs = buildQuery({ filters, filter }); } catch (e) { return errorResult(e.message); }
    qs.set('select', select); qs.set('limit', String(limit));
    if (offset) qs.set('offset', String(offset));
    if (order.length) qs.set('order', order.map((o) => `${o.column}.${o.direction}`).join(','));
    const r = await supabase.rest(auth.token, 'GET', `/${table}`, { schema, query: qs, prefer: count ? 'count=exact' : undefined });
    if (!r.ok) return fail(r, { schema, table, op: 'select', columns: selectColumns(select), filterColumns: columnsOf({ filters, filter }) }, auth, entry);
    entry.rows = r.data.length;
    const total = count ? Number(/\/(\d+)$/.exec(r.range ?? '')?.[1] ?? NaN) : undefined;
    return okResult({ rows: r.data, row_count: r.data.length, ...(Number.isFinite(total) ? { total_count: total } : {}) }, { maxChars: cfg.maxResultChars });
  });

  tool('insert_rows', {
    title: 'Insert rows',
    description: 'Inserts rows (array of objects, column → value; columns left out get their default). Returns the inserted rows.',
    inputSchema: { schema: ident, table: ident, rows: z.array(z.record(z.string(), z.any())).min(1).max(100) },
    annotations: { destructiveHint: false, openWorldHint: false },
  }, async ({ auth, args, entry }) => {
    const { schema, table, rows } = args;
    entry.target = `${schema}.${table}`;
    const r = await supabase.rest(auth.token, 'POST', `/${table}`, { schema, body: rows, prefer: 'return=representation,missing=default' });
    if (!r.ok) return fail(r, { schema, table, op: 'insert', columns: [...new Set(rows.flatMap((x) => Object.keys(x)))] }, auth, entry);
    entry.rows = r.data.length;
    return okResult({ rows: r.data, row_count: r.data.length }, { maxChars: cfg.maxResultChars });
  });

  tool('update_rows', {
    title: 'Update rows',
    description: 'Updates the rows matching the filters (required) with `values` (column → new value). Returns the updated rows. ' +
      'If more than `max_rows` rows match, nothing is changed. Zero rows can also mean the person may not see them.',
    inputSchema: {
      schema: ident, table: ident,
      values: z.record(z.string(), z.any()).describe('Column → new value'),
      filters: filtersArg, filter: rawFilter, max_rows: maxRows,
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ auth, args, entry }) => {
    const { schema, table, values, filters, filter, max_rows } = args;
    entry.target = `${schema}.${table}`;
    if (!Object.keys(values).length) return errorResult('`values` is empty: nothing to update.');
    let qs;
    try { qs = buildQuery({ filters, filter }); } catch (e) { return errorResult(e.message); }
    if (!hasRowFilter(qs)) return noFilter();
    const r = await supabase.rest(auth.token, 'PATCH', `/${table}`, { schema, query: qs, body: values,
      prefer: `return=representation,handling=strict,max-affected=${max_rows}` });
    if (!r.ok) return fail(r, { schema, table, op: 'update', columns: Object.keys(values), filterColumns: columnsOf({ filters, filter }) }, auth, entry);
    entry.rows = r.data.length;
    return okResult({ rows: r.data, row_count: r.data.length,
      ...(r.data.length ? {} : { note: 'No row matched. The filters match nothing, or row-level security hides the rows from this role.' }) },
      { maxChars: cfg.maxResultChars });
  });

  tool('delete_rows', {
    title: 'Delete rows',
    description: 'Deletes the rows matching the filters (required). Returns the deleted rows. If more than `max_rows` rows match, nothing is deleted.',
    inputSchema: { schema: ident, table: ident, filters: filtersArg, filter: rawFilter, max_rows: maxRows },
    annotations: { destructiveHint: true, openWorldHint: false },
  }, async ({ auth, args, entry }) => {
    const { schema, table, filters, filter, max_rows } = args;
    entry.target = `${schema}.${table}`;
    let qs;
    try { qs = buildQuery({ filters, filter }); } catch (e) { return errorResult(e.message); }
    if (!hasRowFilter(qs)) return noFilter();
    const r = await supabase.rest(auth.token, 'DELETE', `/${table}`, { schema, query: qs,
      prefer: `return=representation,handling=strict,max-affected=${max_rows}` });
    if (!r.ok) return fail(r, { schema, table, op: 'delete', filterColumns: columnsOf({ filters, filter }) }, auth, entry);
    entry.rows = r.data.length;
    return okResult({ rows: r.data, row_count: r.data.length,
      ...(r.data.length ? {} : { note: 'No row matched. The filters match nothing, or row-level security hides the rows from this role.' }) },
      { maxChars: cfg.maxResultChars });
  });
}
