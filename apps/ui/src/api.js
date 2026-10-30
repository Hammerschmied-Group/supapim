// Calls beyond the data provider: the plugin's RPC functions (cms_api.*, with the person's token, through
// PostgREST) and the admin API of apps/server (/cms/api/admin/*, same origin). The browser never holds a
// key other than the public anon key; the admin API decides on its own whether this person may use it.
import { createContext } from 'react';

export const ApiContext = createContext(null);

function fail(message, extra) {
  return Object.assign(new Error(message), extra);
}

export function createApi({ supabase }) {
  /** cms_api.<fn>(args) as the signed-in role. */
  async function rpc(fn, args = {}) {
    const { data, error } = await supabase.schema('cms_api').rpc(fn, args);
    if (error) throw fail(error.message, { code: error.code, status: error.status });
    return data;
  }

  /** POST /cms/api/admin<path>; the server answers 401 / 403 / 4xx with { error, message }. */
  async function admin(path, body) {
    const { data } = await supabase.auth.getSession();
    const r = await fetch(`${import.meta.env.BASE_URL}api/admin${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${data.session?.access_token ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const json = await r.json().catch(() => null);
    if (!r.ok) throw fail(json?.message ?? `HTTP ${r.status}`, { code: json?.error, status: r.status });
    return json;
  }

  return { rpc, admin };
}
