// The two checks that must both pass before the admin module may use the service key:
//   1. the bearer token is a valid Supabase Auth user token (JWKS signature, issuer, audience, expiry)
//   2. the DATABASE says this person's role is an admin role (cms.settings.admin_roles): cms_api.whoami(),
//      called with the person's own token through PostgREST. The role claim in the token alone is not trusted.
// No key is handled here. 401 = no usable token, 403 = valid person, not an admin, 502 = database unreachable.
import { createRemoteJWKSet, jwtVerify } from 'jose';

const NOT_A_PERSON = new Set(['anon', 'service_role', 'supabase_admin', 'postgres', 'authenticator']);
const TIMEOUT_MS = 10_000;

export function createGate({ jwksUrl, issuer, supabaseUrl, anonKey }) {
  const jwks = createRemoteJWKSet(new URL(jwksUrl));

  return async function gate(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (!m) return { status: 401, code: 'missing_token', message: 'Sign in first (missing bearer token).' };
    const token = m[1];

    let claims;
    try {
      ({ payload: claims } = await jwtVerify(token, jwks, { issuer, audience: 'authenticated' }));
    } catch (e) {
      return { status: 401, code: e.code === 'ERR_JWT_EXPIRED' ? 'token_expired' : 'invalid_token',
               message: e.code === 'ERR_JWT_EXPIRED' ? 'The token has expired. Sign in again.' : 'The token is not valid.' };
    }
    if (!claims.sub || !claims.role || NOT_A_PERSON.has(claims.role)) {
      return { status: 401, code: 'invalid_token', message: 'The token is not a user token.' };
    }
    // The admin area belongs to the CMS UI. A connected program (MCP client, OAuth token with client_id) holds a
    // token of the same person, but never gets to invite or block people with it (docs/security/findings.md F-03).
    if (claims.client_id) {
      return { status: 403, code: 'oauth_client_token', message: 'Connected programs cannot use the admin area. Sign in to the CMS.', claims };
    }

    let r;
    try {
      r = await fetch(`${supabaseUrl}/rest/v1/rpc/whoami`, {
        method: 'POST',
        headers: { apikey: anonKey, Authorization: `Bearer ${token}`, 'Content-Profile': 'cms_api', 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { status: 502, code: 'database_unreachable', message: 'Could not check the admin right in the database.' };
    }
    if (r.status === 401) return { status: 401, code: 'invalid_token', message: 'The token was rejected.' };
    if (!r.ok) return { status: 502, code: 'database_error', message: 'Could not check the admin right in the database.' };
    const who = await r.json().catch(() => null);
    if (!who || who.is_admin !== true || who.user_id !== claims.sub) {
      return { status: 403, code: 'not_admin', message: 'Only CMS admins may do this.', claims };
    }
    return { ok: true, token, claims, email: who.email ?? claims.email ?? null, role: who.role };
  };
}
