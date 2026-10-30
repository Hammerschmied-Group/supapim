// Session helpers around supabase-js: what arrives in the URL (magic link, invite, recovery), and TOTP-MFA.
// No React in here; the pages in auth.jsx / security.jsx / consent.jsx call these.

const URL_ERROR_KEY = 'supabase-cms-url-error';

/** Parameters Supabase Auth puts into the URL: the fragment "#access_token=…&type=magiclink" (implicit flow)
 *  or, behind the hash route, "#/set-password?access_token=…". Same rule as ra-supabase-core. */
export function urlAuthParams(loc = window.location) {
  const hash = loc.hash.substring(1);
  const raw = loc.search || (hash.includes('?') ? hash.split('?')[1] : hash);
  return new URLSearchParams(raw);
}

/**
 * Runs once at start-up, before React renders (so no component or auth check can race with it).
 *  - magic link / sign-up confirmation ("#access_token=…&type=magiclink"): take the session, clean the URL
 *  - invite / recovery: do NOT sign in; move the tokens to the set-password page ("#/set-password?access_token=…"),
 *    where the person chooses a password first (ra-supabase-core's useSetPassword signs them in with it)
 *  - failed link ("#error=access_denied&error_code=otp_expired&error_description=…"): keep the message for the login page
 * Tokens never stay in the address bar or the history (location.replace / replaceState).
 */
export async function handleUrlAuth(supabase) {
  const p = urlAuthParams();
  const flash = (m) => { try { sessionStorage.setItem(URL_ERROR_KEY, m); } catch { /* private mode */ } };
  if (p.get('error') && (p.get('error_description') || p.get('error_code'))) {
    flash(p.get('error_description') || p.get('error_code'));
    return window.location.replace(`${window.location.pathname}#/`);
  }
  const access_token = p.get('access_token');
  const refresh_token = p.get('refresh_token');
  const type = p.get('type');
  if (!access_token || !refresh_token) return;
  if (type === 'invite' || type === 'recovery') {
    if (window.location.hash.startsWith('#/set-password')) return;
    const q = new URLSearchParams({ access_token, refresh_token, type });
    return window.history.replaceState(null, '', `${window.location.pathname}#/set-password?${q}`);
  }
  const { error } = await supabase.auth.setSession({ access_token, refresh_token });
  if (error) flash(error.message);
  window.location.replace(`${window.location.pathname}#/`);
}

/** The message of a failed link, once (read by the login page). */
export function takeUrlError() {
  try {
    const m = sessionStorage.getItem(URL_ERROR_KEY);
    sessionStorage.removeItem(URL_ERROR_KEY);
    return m;
  } catch { return null; }
}

/** Claims of an access token, for display only (the server never trusts what the browser decodes). */
export function claimsOf(token) {
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return {}; }
}

// ── MFA (TOTP) ────────────────────────────────────────────────────────────────────────────────

/** True while the session is AAL1 but the person has a verified factor — they must still enter the code. */
export async function needsMfa(supabase) {
  const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  return !!data && data.nextLevel === 'aal2' && data.currentLevel !== 'aal2';
}

export async function verifiedFactors(supabase) {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw error;
  return data.totp ?? [];          // listFactors returns verified factors only
}

/** Second step of a login (or of the consent page): challenge the person's TOTP factor and verify the code. */
export async function verifyTotp(supabase, code) {
  const [factor] = await verifiedFactors(supabase);
  if (!factor) throw new Error('No TOTP factor');
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code: String(code).replace(/\s+/g, '') });
  if (error) throw error;
}

/** Start enrolling a TOTP factor: returns { id, secret, uri, qr } — qr is an SVG data URI. Unverified until verifyEnrollment. */
export async function enrollTotp(supabase) {
  // an abandoned, never-verified factor would make enroll fail ("factor already exists"): remove those first
  const { data: all } = await supabase.auth.mfa.listFactors();
  for (const f of all?.all ?? []) {
    if (f.factor_type === 'totp' && f.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: f.id });
  }
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `authenticator ${new Date().toISOString().slice(0, 10)}` });
  if (error) throw error;
  return { id: data.id, secret: data.totp.secret, uri: data.totp.uri, qr: data.totp.qr_code };
}

export async function verifyEnrollment(supabase, factorId, code) {
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: String(code).replace(/\s+/g, '') });
  if (error) throw error;
}

export async function removeFactor(supabase, factorId) {
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) throw error;
}

/** Maps Supabase Auth errors to message keys (cms.auth.*), so they can be shown in the person's language. */
export function authErrorKey(err) {
  switch (err?.code) {
    case 'invalid_credentials': return 'cms.auth.error.invalid_credentials';
    case 'mfa_verification_failed': return 'cms.auth.error.mfa_code';
    case 'mfa_challenge_expired': return 'cms.auth.error.mfa_code';
    case 'insufficient_aal': return 'cms.auth.error.insufficient_aal';
    case 'over_email_send_rate_limit':
    case 'over_request_rate_limit': return 'cms.auth.error.rate_limit';
    case 'same_password': return 'cms.auth.error.same_password';
    case 'weak_password': return 'cms.auth.error.weak_password';
    default: return null;
  }
}
