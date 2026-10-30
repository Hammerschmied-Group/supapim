// Turns database and storage refusals into something a person (and the model talking to them) can
// act on: which role, which table/column, what is allowed instead. The facts come from
// cms_api.describe(), i.e. from what Postgres itself enforces for that role.
import { errorResult } from './result.mjs';

const q = (s) => `\`${s}\``;
const list = (a) => (a.length ? a.map(q).join(', ') : 'nothing');

export function findTable(d, schema, table) {
  return d?.schemas?.find((s) => s.name === schema)?.tables?.find((t) => t.name === table) ?? null;
}
const colsWith = (t, right) => (t.columns ?? []).filter((c) => c.privileges?.[right]).map((c) => c.name);

// ctx: { schema, table, op: select|insert|update|delete, columns: [], filterColumns: [] }
export function explainDenied(d, ctx, pg = {}) {
  const role = d.role;
  const where = `${ctx.schema}.${ctx.table}`;
  const schemaEntry = d.schemas?.find((s) => s.name === ctx.schema);
  const t = findTable(d, ctx.schema, ctx.table);

  if (!schemaEntry) {
    const visible = (d.schemas ?? []).map((s) => s.name);
    return `Role ${q(role)} has no access to schema ${q(ctx.schema)}. Schemas it can use: ${list(visible)}.`;
  }
  if (!t) {
    return `Role ${q(role)} has no access to table ${q(where)} (or it does not exist). Tables it can use in ${q(ctx.schema)}: ${list(schemaEntry.tables.map((x) => x.name))}.`;
  }

  const rls = /row-level security/i.test(pg.message ?? '');
  const policies = (t.rls?.policies ?? []).filter((p) => p.command === ctx.op || p.command === 'all').map((p) => p.name);

  if (ctx.op === 'delete') {
    return t.privileges?.delete
      ? `Row-level security of ${q(where)} does not let role ${q(role)} delete these rows.${policies.length ? ` Policies for delete: ${list(policies)}.` : ''}`
      : `Role ${q(role)} may not delete rows in ${q(where)}.`;
  }

  if (ctx.op === 'select') {
    const readable = colsWith(t, 'select');
    const wanted = [...new Set([...(ctx.columns ?? []), ...(ctx.filterColumns ?? [])])];
    const all = wanted.includes('*');
    const blocked = all
      ? (t.columns ?? []).map((c) => c.name).filter((c) => !readable.includes(c))
      : wanted.filter((c) => !readable.includes(c));
    if (!readable.length) return `Role ${q(role)} may not read ${q(where)}.`;
    if (blocked.length) {
      return `Role ${q(role)} may not read ${blocked.length > 1 ? 'columns' : 'column'} ${list(blocked)} of ${q(where)}` +
        `${all ? ' (needed by select=*)' : ''}. Readable: ${list(readable)}. Ask for those columns in \`select\` and filter only on them.`;
    }
    return rls || policies.length
      ? `Row-level security of ${q(where)} blocks this read for role ${q(role)}.${policies.length ? ` Policies for select: ${list(policies)}.` : ''}`
      : `Role ${q(role)} may not read ${q(where)} this way.`;
  }

  // insert / update
  const right = ctx.op;
  const allowed = colsWith(t, right);
  const verb = right === 'insert' ? 'set' : 'change';
  if (!allowed.length) {
    return `Role ${q(role)} may not ${right} rows in ${q(where)}${right === 'update' ? ' (all its columns are read-only for this role)' : ''}.`;
  }
  const blocked = (ctx.columns ?? []).filter((c) => !allowed.includes(c));
  if (blocked.length) {
    return `Role ${q(role)} may not ${verb} ${blocked.length > 1 ? 'columns' : 'column'} ${list(blocked)} in ${q(where)}. Allowed to ${right}: ${list(allowed)}.`;
  }
  if (right === 'update') {
    const readable = colsWith(t, 'select');
    const needs = (ctx.filterColumns ?? []).filter((c) => !readable.includes(c));
    if (needs.length) return `Role ${q(role)} may not read ${list(needs)} in ${q(where)}, so it cannot filter on ${needs.length > 1 ? 'them' : 'it'}. Readable: ${list(readable)}.`;
  }
  return `Row-level security of ${q(where)} does not let role ${q(role)} ${right} these rows.${policies.length ? ` Policies for ${right}: ${list(policies)}.` : ''}`;
}

export function explainStorageDenied(d, { bucket, op }, status) {
  const role = d.role;
  const buckets = d.storage?.buckets ?? [];
  const b = buckets.find((x) => x.id === bucket);
  if (!b) {
    return `Role ${q(role)} cannot see storage bucket ${q(bucket)} (it may not exist). Buckets it can see: ${list(buckets.map((x) => x.id))}.`;
  }
  const rights = d.storage?.object_privileges ?? {};
  const right = op === 'upload' ? 'insert' : op === 'read' ? 'select' : op;
  if (rights[right] === false) {
    return `Role ${q(role)} may not ${op} files in bucket ${q(bucket)} (it has no ${right} right on storage objects).`;
  }
  const policies = (b.object_policies ?? []).filter((p) => p.command === right || p.command === 'all');
  const shown = policies.map((p) => `${q(p.name)} (${p.using ?? p.check ?? 'true'})`);
  return `Storage policies of bucket ${q(bucket)} do not allow role ${q(role)} to ${op} this path${status ? ` (HTTP ${status})` : ''}.` +
    `${shown.length ? ` Policies for ${right}: ${shown.join('; ')}.` : ` No ${right} policy applies to this role.`}`;
}

// PostgREST error → tool error. `describeFn` is lazy: only called when an explanation needs it.
export async function postgrestFailure(r, ctx, describeFn) {
  const pg = r.data && typeof r.data === 'object' ? r.data : { message: String(r.data ?? '') };
  const detail = { http_status: r.status, postgres: { code: pg.code, message: pg.message, details: pg.details ?? null, hint: pg.hint ?? null } };
  let message;

  if (pg.code === '42501') {
    const d = await describeFn();
    message = d.ok ? explainDenied(d.describe, ctx, pg)
      : 'Permission denied by the database (role rights could not be loaded for a detailed explanation).';
  } else if (pg.code === 'PGRST124') {
    message = `This would affect more rows than max_rows allows. Nothing was changed. Narrow the filters, or raise max_rows if that is really intended.`;
  } else if (pg.code === 'PGRST106') {
    const d = await describeFn();
    message = `Schema ${q(ctx.schema)} is not available through the API.${d.ok ? ` Schemas this role can use: ${list(d.describe.schemas.map((s) => s.name))}.` : ''}`;
  } else if (pg.code === 'PGRST205' || pg.code === '42P01' || pg.code === 'PGRST202') {
    const d = await describeFn();
    message = d.ok
      ? explainDenied(d.describe, { ...ctx, op: ctx.op ?? 'select' }, pg)
      : `${pg.message ?? 'Not found'}.`;
  } else if (pg.code === 'PGRST204' || pg.code === '42703') {
    const d = await describeFn();
    const t = d.ok ? findTable(d.describe, ctx.schema, ctx.table) : null;
    message = `${pg.message}.${t ? ` Columns of ${q(`${ctx.schema}.${ctx.table}`)} this role can see: ${list(t.columns.map((c) => c.name))}.` : ''}`;
  } else if (r.status === 401 || pg.code === 'PGRST301' || pg.code === 'PGRST303') {
    message = 'The access token was rejected or has expired. Reconnect the MCP server to sign in again.';
  } else if (r.status === 429) {
    message = 'The database API is rate limiting requests. Wait a moment and retry.';
  } else {
    message = pg.message ?? `Request failed (HTTP ${r.status}).`;
  }
  return { result: errorResult(message, detail), denied: pg.code === '42501', code: pg.code };
}

export async function storageFailure(status, body, ctx, describeFn) {
  const msg = body?.message ?? body?.error ?? (typeof body === 'string' ? body : '');
  const detail = { http_status: status, storage: { error: body?.error ?? null, message: msg || null } };
  // Storage reports a policy refusal as 400/401/403, and hides objects the role cannot see as 404.
  const both = `${msg} ${body?.error ?? ''}`;
  const denied = [401, 403, 404].includes(status) || /row-level security|unauthorized|permission denied|not[_ ]found/i.test(both);
  let message;
  if (status === 409 || /duplicate/i.test(body?.error ?? '')) {
    message = 'A file already exists at that path. Pass upsert=true to replace it.';
  } else if (status === 413) {
    message = 'The file is larger than the storage limit of this project.';
  } else if (denied) {
    const d = await describeFn();
    message = d.ok ? explainStorageDenied(d.describe, ctx, status) : (msg || `Storage refused the request (HTTP ${status}).`);
  } else {
    message = msg || `Storage request failed (HTTP ${status}).`;
  }
  return { result: errorResult(message, detail), denied };
}
