// Talks to Supabase the way any client does: through the gateway, with the anon key as `apikey`
// and the person's own access token as Bearer. PostgREST and the Storage API switch to the
// person's Postgres role from the token; GRANTs, column grants and RLS decide.

const TIMEOUT_MS = 20_000;

export function createSupabase(cfg) {
  const headers = (token, extra = {}) => ({ apikey: cfg.anonKey, Authorization: `Bearer ${token}`, ...extra });
  const parse = (text) => { try { return text ? JSON.parse(text) : null; } catch { return text; } };

  // PostgREST. `schema` picks the Accept-/Content-Profile (which exposed schema the request runs in).
  async function rest(token, method, path, { schema, body, prefer, query } = {}) {
    const h = headers(token, { Accept: 'application/json' });
    if (schema) { h['Accept-Profile'] = schema; h['Content-Profile'] = schema; }
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (prefer) h.Prefer = prefer;
    const qs = query && [...query].length ? `?${query}` : '';
    const r = await fetch(`${cfg.supabaseUrl}/rest/v1${path}${qs}`, {
      method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = parse(await r.text());
    return { status: r.status, ok: r.ok, data, range: r.headers.get('content-range') };
  }

  // Storage API. Returns the raw Response so callers can stream or inspect headers.
  function storage(token, method, path, { json, body, headers: extra } = {}) {
    const h = headers(token, extra);
    let payload = body;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(json); }
    return fetch(`${cfg.supabaseUrl}/storage/v1${path}`, { method, headers: h, body: payload, signal: AbortSignal.timeout(TIMEOUT_MS) });
  }

  // cms_api.describe(): what this role can see and do (Task 3). Cached briefly per person+role, since a
  // single tool call (and the explanation of its error) may need it more than once.
  const cache = new Map();
  async function describe(auth, { fresh = false } = {}) {
    const key = `${auth.claims.sub}:${auth.claims.role}`;
    const hit = cache.get(key);
    if (!fresh && hit && hit.until > Date.now()) return hit.value;
    const r = await rest(auth.token, 'POST', '/rpc/describe', { schema: 'cms_api', body: {} });
    const value = r.ok ? { ok: true, describe: r.data } : { ok: false, status: r.status, error: r.data };
    if (value.ok) {
      if (cache.size > 500) cache.clear();
      cache.set(key, { value, until: Date.now() + 10_000 });
    }
    return value;
  }

  return { rest, storage, describe };
}
