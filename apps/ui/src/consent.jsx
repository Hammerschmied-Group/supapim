// OAuth consent page for MCP clients (Claude, ChatGPT, …): "#/consent?authorization_id=…".
// Supabase Auth sends the browser to SITE_URL/oauth/consent?authorization_id=…; apps/server forwards that to
// /cms/#/consent?… . Same session as the rest of the UI (supabase-js, storage key supabase-cms-auth), so someone
// who is already signed in only sees the question. The decision goes to /auth/v1/oauth/authorizations/*.
import { useCallback, useEffect, useState } from 'react';
import { useAuthProvider, useTranslate } from 'react-admin';
import { Alert, Box, Button, CircularProgress, Link as MuiLink, Typography } from '@mui/material';
import { useSearchParams } from 'react-router-dom';
import { AuthShell, SignInPanel } from './auth.jsx';
import { useSupabase } from './context.js';
import { claimsOf, needsMfa } from './session.js';

// Where an approval may send the browser: back to the client, never into a script.
const SAFE_REDIRECT = (url) => { try { return !/^(javascript|data|vbscript|blob|file):$/i.test(new URL(url).protocol); } catch { return false; } };
// A web address on another machine receives the access (any program can register itself, with any name): say where it goes.
const REMOTE_HOST = (url) => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ? u.host : null;
  } catch { return null; }
};

export function ConsentPage() {
  const t = useTranslate();
  const supabase = useSupabase();
  const authProvider = useAuthProvider();
  const [params] = useSearchParams();
  const id = params.get('authorization_id');
  const [view, setView] = useState({ phase: 'loading' });   // loading | login | mfa | consent | redirecting | error
  const [busy, setBusy] = useState(false);

  // A person with a second factor: the OAuth tokens of this client are aal1, so the token hook gives them the role
  // only for clients confirmed here with the aal2 session (cms_api.confirm_mfa_client, install.sql step 4).
  const confirmClient = useCallback(async (session) => {
    if (claimsOf(session.access_token).aal !== 'aal2') return null;
    const { error } = await supabase.schema('cms_api').rpc('confirm_mfa_client', { authorization_id: id });
    return error;
  }, [id, supabase]);

  const go = (url) => {
    if (!SAFE_REDIRECT(url)) return setView({ phase: 'error', key: 'load_failed', detail: 'unsafe redirect' });
    setView({ phase: 'redirecting' });
    window.location.assign(url);
  };

  const load = useCallback(async () => {
    if (!id) return setView({ phase: 'error', key: 'missing_id' });
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return setView({ phase: 'login' });
    if (await needsMfa(supabase)) return setView({ phase: 'mfa' });
    const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(id);
    if (error) {
      if (error.status === 401 || error.name === 'AuthSessionMissingError') return setView({ phase: 'login' });
      return setView({ phase: 'error', key: 'load_failed', detail: error.message });
    }
    if ('redirect_url' in data && !('authorization_id' in data)) {      // already decided: straight back to the client
      const failed = await confirmClient(session);
      if (failed) return setView({ phase: 'error', key: 'load_failed', detail: failed.message });
      return go(data.redirect_url);
    }
    setView({ phase: 'consent', details: data, role: claimsOf(session.access_token).role ?? '' });
  }, [id, supabase, confirmClient]);
  useEffect(() => { load(); }, [load]);

  const decide = async (approve) => {
    setBusy(true);
    if (approve) {
      const { data: { session } } = await supabase.auth.getSession();
      const failed = session ? await confirmClient(session) : null;
      if (failed) {
        setBusy(false);
        return setView((v) => ({ ...v, decisionError: failed.message }));
      }
    }
    const call = approve ? supabase.auth.oauth.approveAuthorization : supabase.auth.oauth.denyAuthorization;
    const { data, error } = await call(id, { skipBrowserRedirect: true });
    if (error || !data?.redirect_url) {
      setBusy(false);
      return setView((v) => ({ ...v, decisionError: error?.message ?? 'no redirect' }));
    }
    go(data.redirect_url);
  };

  const otherAccount = async (e) => {
    e.preventDefault();
    await supabase.auth.signOut({ scope: 'local' });
    setView({ phase: 'login' });
  };

  const signedIn = () => load();
  const login = (p) => authProvider.login(p).then(signedIn);
  const d = view.details;
  const title = view.phase === 'consent'
    ? t('cms.consent.title', { client: d.client?.name || d.client?.id || t('cms.consent.a_program', { _: 'A program' }), _: '%{client} wants access' })
    : t('cms.consent.sign_in_title', { _: 'Sign in to continue' });

  return (
    <AuthShell title={title} width={460}>
      {view.phase === 'loading' || view.phase === 'redirecting' ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }} role="status">
          <CircularProgress size={20} />
          <Typography>{view.phase === 'loading' ? t('cms.consent.loading', { _: 'Loading request …' }) : t('cms.consent.redirecting', { _: 'Redirecting …' })}</Typography>
        </Box>
      ) : null}

      {view.phase === 'error' && (
        <Alert severity="error">
          {view.key === 'missing_id'
            ? t('cms.consent.missing_id', { _: 'Invalid link: authorization_id is missing.' })
            : t('cms.consent.load_failed', { _: 'The request could not be loaded:' }) + ' ' + view.detail}
        </Alert>
      )}

      {(view.phase === 'login' || view.phase === 'mfa') && (
        <Box>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {t('cms.consent.sign_in_intro', { _: 'A program wants to act on your behalf. Sign in first.' })}
          </Typography>
          {/* no magic link here: the link opens the dashboard, not this request */}
          <SignInPanel key={view.phase} login={login} initialStep={view.phase === 'mfa' ? 'mfa' : 'password'} allowLink={false} />
        </Box>
      )}

      {view.phase === 'consent' && (
        <Box>
          <Typography sx={{ mb: 2 }}>
            {t('cms.consent.intro', { _: 'The program acts on your behalf and with exactly your rights. Every change is logged with your e-mail.' })}
          </Typography>
          <Box component="dl" sx={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px', m: 0, mb: 3, fontSize: 14 }}>
            <Box component="dt" sx={{ color: 'text.secondary' }}>{t('cms.consent.signed_in_as', { _: 'Signed in as' })}</Box>
            <Box component="dd" sx={{ m: 0, wordBreak: 'break-all' }} data-testid="consent-user">{d.user?.email}</Box>
            <Box component="dt" sx={{ color: 'text.secondary' }}>{t('cms.consent.role', { _: 'Database role' })}</Box>
            <Box component="dd" sx={{ m: 0 }} data-testid="consent-role">{view.role || '—'}</Box>
            <Box component="dt" sx={{ color: 'text.secondary' }}>{t('cms.consent.scope', { _: 'Scope' })}</Box>
            <Box component="dd" sx={{ m: 0 }}>{d.scope || '—'}</Box>
            <Box component="dt" sx={{ color: 'text.secondary' }}>{t('cms.consent.redirect', { _: 'Redirect to' })}</Box>
            <Box component="dd" sx={{ m: 0, wordBreak: 'break-all' }} data-testid="consent-redirect">{d.redirect_uri}</Box>
          </Box>
          {REMOTE_HOST(d.redirect_uri) && (
            <Alert severity="warning" sx={{ mb: 2 }} data-testid="consent-remote">
              {t('cms.consent.remote_redirect', { host: REMOTE_HOST(d.redirect_uri), _: 'The access goes to %{host}. Only allow it if you have just connected this program yourself.' })}
            </Alert>
          )}
          {view.decisionError && <Alert severity="error" role="alert" sx={{ mb: 2 }}>{t('cms.consent.decision_failed', { _: 'Error:' })} {view.decisionError}</Alert>}
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button fullWidth variant="outlined" disabled={busy} onClick={() => decide(false)}>{t('cms.consent.deny', { _: 'Deny' })}</Button>
            <Button fullWidth variant="contained" disabled={busy} onClick={() => decide(true)}>{t('cms.consent.approve', { _: 'Allow' })}</Button>
          </Box>
          <Typography variant="body2" sx={{ mt: 2 }}>
            <MuiLink href="#" onClick={otherAccount} underline="hover" color="text.secondary">{t('cms.auth.other_account', { _: 'Use a different account' })}</MuiLink>
          </Typography>
        </Box>
      )}
    </AuthShell>
  );
}
