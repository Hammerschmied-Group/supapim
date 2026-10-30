// The ONLY place that holds the service key. It lives in this closure: it is never exported, never
// put on a request, response, log line or error. Everything goes to the Auth admin API through the
// gateway (like any client would; Cloud: https://<ref>.supabase.co) and only these four operations
// exist: look up a user, invite (mail or link), ban, unban.

const TIMEOUT_MS = 20_000;
const BAN_FOREVER = '876000h';      // ~100 years; GoTrue has no "ban without end"

export function createGoTrue({ baseUrl, key }) {
  const headers = {
    apikey: key, 'Content-Type': 'application/json', Accept: 'application/json',
    // legacy service_role keys are JWTs and must also be the bearer; sb_secret_… keys are exchanged by the gateway
    ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}),
  };

  async function call(method, path, body) {
    let r;
    try {
      r = await fetch(`${baseUrl}/auth/v1${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      return { status: 502, error: { code: e.name === 'TimeoutError' ? 'timeout' : 'unreachable' } };
    }
    const text = await r.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    // Only a fixed subset of GoTrue's error body is passed on.
    if (!r.ok) return { status: r.status, error: { code: data?.error_code ?? 'auth_error', message: String(data?.msg ?? data?.message ?? '').slice(0, 200) } };
    return { status: r.status, data };
  }

  // What leaves this module about a user. No tokens, no metadata.
  const pick = (u) => u && ({
    id: u.id, email: u.email, invited_at: u.invited_at ?? null, confirmed_at: u.confirmed_at ?? u.email_confirmed_at ?? null,
    last_sign_in_at: u.last_sign_in_at ?? null, banned_until: u.banned_until ?? null,
  });

  return {
    isConfigured: true,
    async getUser(id) { const r = await call('GET', `/admin/users/${id}`); return r.error ? r : { ...r, user: pick(r.data) }; },
    // delivery 'mail': GoTrue sends the invite (needs working SMTP). 'link': nothing is sent; the admin gets the one-time link.
    // redirectTo: where the accepted link lands (the UI's set-password page). GoTrue only honours it when it matches
    // GOTRUE_URI_ALLOW_LIST and otherwise falls back to SITE_URL.
    async invite(email, delivery, redirectTo) {
      if (delivery === 'link') {
        const r = await call('POST', '/admin/generate_link', { type: 'invite', email, ...(redirectTo ? { redirect_to: redirectTo } : {}) });
        return r.error ? r : { ...r, user: pick(r.data), action_link: r.data?.action_link ?? null };
      }
      const r = await call('POST', `/invite${redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : ''}`, { email });
      return r.error ? r : { ...r, user: pick(r.data) };
    },
    async setBanned(id, banned) {
      const r = await call('PUT', `/admin/users/${id}`, { ban_duration: banned ? BAN_FOREVER : 'none' });
      return r.error ? r : { ...r, user: pick(r.data) };
    },
  };
}
