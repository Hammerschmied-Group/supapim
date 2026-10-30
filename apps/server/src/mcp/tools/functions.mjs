// call_function: runs a database function through PostgREST RPC, but only one that cms_api.describe()
// reports as executable for the person's role. Embeddings are not computed here (that would need a
// model key): the caller passes a ready vector, e.g. as a JSON array of numbers.
import { z } from 'zod';
import { errorResult, okResult } from '../result.mjs';
import { postgrestFailure } from '../errors.mjs';
import { ident } from '../filters.mjs';

export function registerFunctions({ tool, supabase, cfg }) {
  tool('call_function', {
    title: 'Call a database function',
    description:
      'Calls a database function (RPC) with named arguments, e.g. a vector search: ' +
      'schema "public", name "match_documents", args {"query_embedding": [0.01, …], "match_count": 5}. ' +
      'Only functions listed by list_tables for this person can be called. This server does not turn text into embeddings; ' +
      'pass a vector you already have. Functions may change data (see "volatility" in list_tables).',
    inputSchema: {
      schema: ident, name: ident,
      args: z.record(z.string(), z.any()).default({}).describe('Argument name → value'),
    },
    annotations: { destructiveHint: true, openWorldHint: false },
  }, async ({ auth, args, entry }) => {
    const { schema, name } = args;
    entry.target = `${schema}.${name}()`;
    const d = await supabase.describe(auth);
    if (d.ok) {
      const s = d.describe.schemas.find((x) => x.name === schema);
      if (!s?.functions.some((f) => f.name === name)) {
        const avail = (s?.functions ?? []).map((f) => `\`${f.name}\``);
        entry.status = 'denied';
        return errorResult(`Role \`${d.describe.role}\` may not call ${schema}.${name}() (it does not exist or the role has no EXECUTE right). ` +
          `Functions it can call${s ? ` in ${schema}` : ''}: ${avail.length ? avail.join(', ') : 'none'}.`, { http_status: 403 });
      }
    }
    const r = await supabase.rest(auth.token, 'POST', `/rpc/${name}`, { schema, body: args.args });
    if (!r.ok) {
      const out = await postgrestFailure(r, { schema, table: name, op: 'select' }, () => supabase.describe(auth));
      entry.status = out.denied ? 'denied' : 'error';
      entry.code = out.code;
      return out.result;
    }
    const rows = Array.isArray(r.data) ? r.data : null;
    entry.rows = rows ? rows.length : undefined;
    return okResult(rows ? { rows, row_count: rows.length } : { result: r.data }, { maxChars: cfg.maxResultChars });
  });
}
