// Supabase client, auth provider (ra-supabase-core) and the data provider
// (@raphiniert/ra-data-postgrest, the provider ra-supabase uses internally).
//
// Every request carries the person's access token; PostgREST switches into the role from its
// "role" claim, so the database decides. The UI never holds any other key than the public anon key.
import { createClient } from '@supabase/supabase-js';
import { fetchUtils } from 'react-admin';
import { supabaseAuthProvider } from 'ra-supabase-core';
import postgrestRestProvider from '@raphiniert/ra-data-postgrest';
import { buildModel, writableData } from './model.js';
import { createStorage } from './storage.js';
import { createApi } from './api.js';
import { needsMfa, verifyTotp } from './session.js';

export function createProviders({ supabaseUrl, anonKey }) {
  // detectSessionInUrl is off: with the hash router, a magic-link / invite / recovery redirect lands as
  // "/cms/#access_token=…&type=…". supabase-js would sign the person in and wipe the hash before the
  // auth provider sees "invite" or "recovery" (the person must set a password first). session.js reads the URL itself.
  const supabase = createClient(supabaseUrl, anonKey, { auth: { storageKey: 'supabase-cms-auth', detectSessionInUrl: false } });
  const apiUrl = `${supabaseUrl}/rest/v1`;

  async function httpClient(url, options = {}) {
    const headers = options.headers ?? new Headers();
    headers.set('apikey', anonKey);
    const { data } = await supabase.auth.getSession();
    const user = data.session ? { authenticated: true, token: `Bearer ${data.session.access_token}` } : undefined;
    return fetchUtils.fetchJson(url, { ...options, headers, user });
  }

  // ── the model: cms_api.describe() with the person's token, cached per signed-in user ──────────
  let cached = { key: null, promise: null };
  async function loadModel() {
    const { data } = await supabase.auth.getSession();
    if (!data.session) return null;
    const key = data.session.user.id;
    if (cached.key !== key) {
      cached = {
        key,
        promise: Promise.all(['describe', 'whoami'].map((fn) => httpClient(`${apiUrl}/rpc/${fn}`, {
          method: 'POST',
          body: '{}',
          headers: new Headers({ 'Content-Profile': 'cms_api', 'Content-Type': 'application/json' }),
        }))).then(([d, w]) => buildModel(d.json, w.json)),
      };
      cached.promise.catch(() => { cached = { key: null, promise: null }; });
    }
    return cached.promise;
  }
  supabase.auth.onAuthStateChange((event) => {
    if (['SIGNED_OUT', 'SIGNED_IN', 'USER_UPDATED', 'MFA_CHALLENGE_VERIFIED'].includes(event)) cached = { key: null, promise: null };
  });

  const base = supabaseAuthProvider(supabase, {
    // permissions = the UI model; App renders the resources from it
    getPermissions: () => loadModel(),
    getIdentity: async (user) => ({ id: user.id, fullName: user.email }),
  });
  const authProvider = {
    ...base,
    // Password login. If the person has a verified TOTP factor the session is only AAL1 at this point:
    // reject with code "mfa_required" (the session stays in storage) and let the login page ask for the code,
    // which comes back here as { mfaCode }. checkAuth keeps an AAL1 session out of the app.
    login: async ({ email, username, password, mfaCode }) => {
      if (mfaCode) return verifyTotp(supabase, mfaCode);
      await base.login({ email: email ?? username, password });
      if (await needsMfa(supabase)) throw Object.assign(new Error('mfa_required'), { code: 'mfa_required' });
    },
    // "local": only this browser. The default (global) would also end every other session of the person,
    // including the ones that belong to MCP clients they approved (OAuth tokens are sessions in Supabase Auth).
    logout: async () => {
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) throw error;
    },
    // The app is only open at AAL2 for people who have a verified factor. (Magic link / invite / recovery URLs
    // are handled once at start-up, see handleUrlAuth in session.js and main.jsx.)
    checkAuth: async (params) => {
      await base.checkAuth(params);
      if (await needsMfa(supabase)) return Promise.reject({ message: false });
    },
    // ra-supabase-core logs out on 403 as well. Here 403 is the database saying "permission denied"
    // for one action (42501) — the person must stay signed in and see the message. Only 401 ends the session.
    checkError: (error) => (error?.status === 401 ? Promise.reject() : Promise.resolve()),
  };

  // ── data provider: resource "<schema>.<table>" → Accept-/Content-Profile + table ──────────────
  // One postgrest provider per resource, so primaryKeys (keyed by the table name in the URL)
  // never collide between nordwind.products and suedwind.products.
  const perResource = new Map();
  function providerFor(r) {
    if (!perResource.has(r.name)) {
      perResource.set(r.name, postgrestRestProvider({
        apiUrl, httpClient, defaultListOp: 'eq', schema: () => '',
        primaryKeys: new Map([[r.table, r.primaryKey ?? ['id']]]),
      }));
    }
    return perResource.get(r.name);
  }

  const call = (method) => async (resource, params = {}) => {
    const model = await loadModel();
    const r = model?.byName[resource];
    if (!r) throw new Error(`Unknown resource ${resource}`);
    // never "select=*": with column grants Postgres rejects * as soon as one column is not readable
    const meta = { ...params.meta, schema: r.schema, columns: params.meta?.columns ?? r.readColumns };
    let p = { ...params, meta };
    if (method === 'update' || method === 'updateMany') p.data = writableData(r, params.data, 'update');
    if (method === 'create') p.data = writableData(r, params.data, 'create');
    const result = await providerFor(r)[method](r.table, p);
    // tables without a primary key: rows get a positional id so lists render (no edit links)
    if (!r.primaryKey && Array.isArray(result.data)) {
      const offset = ((params.pagination?.page ?? 1) - 1) * (params.pagination?.perPage ?? 0);
      result.data = result.data.map((row, i) => ({ ...row, id: offset + i }));
    }
    return result;
  };

  const dataProvider = Object.fromEntries(
    ['getList', 'getOne', 'getMany', 'getManyReference', 'update', 'updateMany', 'create', 'delete', 'deleteMany']
      .map((m) => [m, call(m)]));

  return { supabase, authProvider, dataProvider, loadModel, anonKey, storage: createStorage(supabase), api: createApi({ supabase }) };
}
