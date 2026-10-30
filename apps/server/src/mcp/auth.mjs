// Verifies the person's access token against the Supabase Auth JWKS. The server has no signing
// key, so it can only check tokens, never issue them.
import { createRemoteJWKSet, jwtVerify } from 'jose';

// A token for one of these is not a person. They never get through, even if the signature is valid.
const NOT_A_PERSON = new Set(['anon', 'service_role', 'supabase_admin', 'postgres', 'authenticator']);

export function createAuthenticator(cfg) {
  const jwks = createRemoteJWKSet(new URL(cfg.jwksUrl));
  return async function authenticate(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (!m) return { error: 'missing bearer token' };
    try {
      const { payload } = await jwtVerify(m[1], jwks, { issuer: cfg.issuer, audience: 'authenticated' });
      if (!payload.sub || !payload.role) return { error: 'invalid token: not a user token' };
      if (NOT_A_PERSON.has(payload.role)) return { error: 'invalid token: not a user token' };
      return { token: m[1], claims: payload };
    } catch (e) {
      return { error: `invalid token: ${e.code ?? e.message}` };
    }
  };
}
