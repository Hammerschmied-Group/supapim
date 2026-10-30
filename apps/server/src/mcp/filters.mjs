// Structured filters [{column, op, value}] → PostgREST query parameters. Models get these right far
// more often than hand-written PostgREST syntax; the raw `filter` string stays available too.
import { z } from 'zod';

export const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const ident = z.string().regex(IDENT, 'SQL identifier: letters, digits, underscore');

const scalar = z.union([z.string(), z.number(), z.boolean()]);

export const OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'not_in', 'is_null', 'not_null', 'contains'];

export const filterSchema = z.object({
  column: ident,
  op: z.enum(OPS).describe('eq, neq, gt, gte, lt, lte; like/ilike (use % as wildcard); in/not_in (value is an array); is_null/not_null (no value); contains (array/jsonb column contains value)'),
  value: z.union([scalar, z.array(scalar)]).optional().describe('Comparison value; omit for is_null/not_null'),
});
export const filtersArg = z.array(filterSchema).max(20).default([])
  .describe('All filters are combined with AND. Example: [{"column":"sku","op":"eq","value":"NW-1001"}]');

// PostgREST list syntax: values containing , ( ) " \ or spaces are double-quoted.
const listItem = (v) => {
  const s = String(v);
  return /[,()"\\\s]/.test(s) || s === '' ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s;
};

export function filterParams(filters = []) {
  const out = [];
  for (const { column, op, value } of filters) {
    const need = () => { if (value === undefined || value === null) throw new Error(`filter on "${column}": op "${op}" needs a value`); return value; };
    switch (op) {
      case 'eq': case 'neq': case 'gt': case 'gte': case 'lt': case 'lte': case 'like': case 'ilike': {
        const v = need();
        if (Array.isArray(v)) throw new Error(`filter on "${column}": op "${op}" takes a single value, use "in" for lists`);
        out.push([column, `${op}.${v}`]);
        break;
      }
      case 'in': case 'not_in': {
        const v = need();
        if (!Array.isArray(v)) throw new Error(`filter on "${column}": op "${op}" needs an array`);
        out.push([column, `${op === 'in' ? 'in' : 'not.in'}.(${v.map(listItem).join(',')})`]);
        break;
      }
      case 'is_null': out.push([column, 'is.null']); break;
      case 'not_null': out.push([column, 'not.is.null']); break;
      case 'contains': {
        const v = need();
        out.push([column, `cs.${Array.isArray(v) ? `{${v.map(listItem).join(',')}}` : v}`]);
        break;
      }
    }
  }
  return out;
}

// Parameters that shape a request rather than filter rows.
const SHAPING = new Set(['select', 'order', 'limit', 'offset', 'columns', 'on_conflict', 'returning']);

// Merge structured filters and the raw PostgREST query string into one URLSearchParams.
export function buildQuery({ filters = [], filter = '' } = {}) {
  const qs = new URLSearchParams(filter.replace(/^\?/, ''));
  for (const [k, v] of filterParams(filters)) qs.append(k, v);
  return qs;
}

export function hasRowFilter(qs) {
  for (const k of qs.keys()) if (!SHAPING.has(k)) return true;
  return false;
}

// Columns a query touches, for explaining permission errors. Best effort, never throws.
export function columnsOf({ filters = [], filter = '' } = {}) {
  const cols = new Set(filters.map((f) => f.column));
  try {
    for (const k of new URLSearchParams(filter).keys()) if (IDENT.test(k) && !SHAPING.has(k)) cols.add(k);
  } catch { /* ignore */ }
  return [...cols];
}

export function selectColumns(select) {
  if (!select || select === '*') return ['*'];
  const parts = []; let depth = 0; let cur = '';
  for (const ch of select) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim().replace(/^[^:]*:/, '').replace(/::.*$/, '').split(/[.>-]/)[0]).filter((p) => p === '*' || IDENT.test(p));
}
