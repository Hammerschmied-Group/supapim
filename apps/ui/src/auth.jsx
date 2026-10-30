// Sign-in pages: e-mail + password, magic link, TOTP code (AAL2), forgot / set password (invite and recovery).
// The session handling lives in providers.js (authProvider) and session.js; this file is only the screens.
import { useRef, useState } from 'react';
import { Login, useAuthProvider, useLogin, useTranslate } from 'react-admin';
import { useSetPassword } from 'ra-supabase-core';
import { Alert, Box, Button, Card, CardContent, Link as MuiLink, TextField, Typography } from '@mui/material';
import { Link } from 'react-router-dom';
import { appUrl, useSupabase } from './context.js';
import { LanguageSwitch } from './i18n/LanguageSwitch.jsx';
import { MadeBy } from './credit.jsx';
import { authErrorKey, takeUrlError, urlAuthParams } from './session.js';

/** Centered card for pages that live outside the layout (set password, forgot password, consent). */
export function AuthShell({ title, children, width = 400 }) {
  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', p: 2, bgcolor: 'background.default' }}>
      <Card sx={{ width: '100%', maxWidth: width }}>
        <CardContent sx={{ p: 3 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Typography variant="h5" component="h1">{title}</Typography>
            <LanguageSwitch />
          </Box>
          {children}
        </CardContent>
      </Card>
      <MadeBy sx={{ mt: 2, textAlign: 'center' }} />
    </Box>
  );
}

const useFail = (setError) => {
  const t = useTranslate();
  return (err) => {
    const key = authErrorKey(err);
    setError(key ? t(key) : (err?.message || t('ra.auth.sign_in_error')));
  };
};

/**
 * Password → (TOTP code) → signed in. `login` is react-admin's useLogin (redirects) or authProvider.login (consent page).
 * A sign-in with a verified TOTP factor leaves an AAL1 session behind; the app is only open at AAL2.
 */
export function SignInPanel({ login, initialStep = 'password', allowLink = true }) {
  const t = useTranslate();
  const supabase = useSupabase();
  const [step, setStep] = useState(initialStep);          // password | mfa | link-sent
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(() => takeUrlError());
  const emailRef = useRef(null);
  const fail = useFail(setError);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (err) { fail(err); } finally { setBusy(false); }
  };

  const signIn = (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    return run(async () => {
      try {
        await login({ email: f.get('email'), password: f.get('password') });
      } catch (err) {
        if (err?.code === 'mfa_required') setStep('mfa'); else throw err;
      }
    });
  };

  const submitCode = (e) => {
    e.preventDefault();
    const code = new FormData(e.currentTarget).get('code');
    return run(() => login({ mfaCode: code }));
  };

  const sendLink = () => run(async () => {
    const email = emailRef.current?.value?.trim();
    if (!email) throw new Error(t('cms.auth.error.email_required', { _: 'Enter your e-mail address first.' }));
    // Only people who already exist are let in (signups are off); an unknown address looks the same as a known one.
    const { error: err } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: appUrl() } });
    const unknownUser = err && (err.status === 422 || ['otp_disabled', 'signup_disabled', 'user_not_found'].includes(err.code));
    if (err && !unknownUser) throw err;
    setStep('link-sent');
  });

  const otherAccount = async (e) => {
    e.preventDefault();
    await supabase.auth.signOut({ scope: 'local' });
    setError(null);
    setStep('password');
  };

  if (step === 'link-sent') {
    return (
      <Box>
        <Alert severity="info" data-testid="link-sent">
          {t('cms.auth.link_sent', { _: 'If this address belongs to an account, a sign-in link is on its way. It works once and for a short time.' })}
        </Alert>
        <Button sx={{ mt: 2 }} onClick={() => setStep('password')}>{t('cms.auth.back', { _: 'Back' })}</Button>
      </Box>
    );
  }

  if (step === 'mfa') {
    return (
      <Box component="form" onSubmit={submitCode} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography variant="body2" color="text.secondary">
          {t('cms.auth.mfa_intro', { _: 'Enter the 6-digit code from your authenticator app.' })}
        </Typography>
        {error && <Alert severity="error" role="alert">{error}</Alert>}
        <TextField name="code" label={t('cms.auth.mfa_code', { _: 'Authentication code' })} required autoFocus
          slotProps={{ htmlInput: { inputMode: 'numeric', autoComplete: 'one-time-code', pattern: '[0-9 ]{6,7}', maxLength: 7 } }} />
        <Button type="submit" variant="contained" disabled={busy}>{t('cms.auth.mfa_verify', { _: 'Verify' })}</Button>
        <MuiLink href="#" onClick={otherAccount} variant="body2" underline="hover">
          {t('cms.auth.other_account', { _: 'Use a different account' })}
        </MuiLink>
      </Box>
    );
  }

  return (
    <Box component="form" onSubmit={signIn} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {error && <Alert severity="error" role="alert">{error}</Alert>}
      <TextField inputRef={emailRef} name="email" type="email" label={t('cms.login.email', { _: 'E-mail' })} autoComplete="username" required autoFocus />
      <TextField name="password" type="password" label={t('ra.auth.password')} autoComplete="current-password" required />
      <Button type="submit" variant="contained" disabled={busy}>{t('ra.auth.sign_in')}</Button>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
        <MuiLink component={Link} to="/forgot-password" variant="body2" underline="hover">
          {t('cms.auth.forgot_password', { _: 'Forgot your password?' })}
        </MuiLink>
        {allowLink && (
          <MuiLink component="button" type="button" variant="body2" underline="hover" onClick={sendLink} disabled={busy}>
            {t('cms.auth.send_link', { _: 'Email me a login link' })}
          </MuiLink>
        )}
      </Box>
    </Box>
  );
}

export function LoginPage() {
  const login = useLogin();
  return (
    <Login>
      <Box sx={{ p: 2, minWidth: 320 }}>
        <SignInPanel login={login} />
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}><LanguageSwitch /></Box>
        <MadeBy sx={{ mt: 2, textAlign: 'center' }} />
      </Box>
    </Login>
  );
}

// ── Forgot password: the mail leads to "#access_token=…&type=recovery", i.e. to SetPasswordPage ─────────

export function ForgotPasswordPage() {
  const t = useTranslate();
  const authProvider = useAuthProvider();
  const [state, setState] = useState({ sent: false, error: null, busy: false });
  const fail = useFail((error) => setState((s) => ({ ...s, error, busy: false })));
  const submit = async (e) => {
    e.preventDefault();
    const email = new FormData(e.currentTarget).get('email');
    setState({ sent: false, error: null, busy: true });
    try {
      await authProvider.resetPassword({ email, redirectTo: appUrl() });
      setState({ sent: true, error: null, busy: false });
    } catch (err) { fail(err); }
  };
  return (
    <AuthShell title={t('cms.auth.forgot_title', { _: 'Reset your password' })}>
      {state.sent ? (
        <Alert severity="info" data-testid="reset-sent">
          {t('cms.auth.reset_sent', { _: 'If this address belongs to an account, an e-mail with a link to choose a new password is on its way.' })}
        </Alert>
      ) : (
        <Box component="form" onSubmit={submit} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {state.error && <Alert severity="error" role="alert">{state.error}</Alert>}
          <TextField name="email" type="email" label={t('cms.login.email', { _: 'E-mail' })} autoComplete="username" required autoFocus />
          <Button type="submit" variant="contained" disabled={state.busy}>{t('cms.auth.reset_send', { _: 'Send link' })}</Button>
        </Box>
      )}
      <Box sx={{ mt: 2 }}>
        <MuiLink component={Link} to="/login" variant="body2" underline="hover">{t('cms.auth.back_to_login', { _: 'Back to sign in' })}</MuiLink>
      </Box>
    </AuthShell>
  );
}

// ── Set a password: after an invitation and after a recovery mail (tokens come in the URL) ──────────────

export function SetPasswordPage() {
  const t = useTranslate();
  const p = urlAuthParams();
  const access_token = p.get('access_token');
  const refresh_token = p.get('refresh_token');
  const invite = p.get('type') === 'invite';
  const [error, setError] = useState(null);
  const fail = useFail(setError);
  const [setPassword, { isPending }] = useSetPassword({
    // setSession() happened outside react-admin's login flow, so its cached permissions (the model) are from before
    // the session existed: start the app again with the new session instead of patching caches.
    onSuccess: () => { window.location.replace(`${window.location.pathname}#/`); window.location.reload(); },
    onError: fail,
  });

  const submit = (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get('password') !== f.get('confirm')) return setError(t('cms.auth.error.password_mismatch', { _: 'The passwords do not match.' }));
    setError(null);
    setPassword({ access_token, refresh_token, password: f.get('password') });
  };

  return (
    <AuthShell title={invite ? t('cms.auth.welcome', { _: 'Welcome — choose a password' }) : t('cms.auth.new_password', { _: 'Choose a new password' })}>
      {!access_token || !refresh_token ? (
        <Alert severity="error">{t('cms.auth.missing_tokens', { _: 'This link is incomplete or has expired. Request a new one.' })}</Alert>
      ) : (
        <Box component="form" onSubmit={submit} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {error && <Alert severity="error" role="alert">{error}</Alert>}
          <TextField name="password" type="password" label={t('cms.auth.new_password_label', { _: 'New password' })} autoComplete="new-password" required autoFocus />
          <TextField name="confirm" type="password" label={t('cms.auth.confirm_password', { _: 'Confirm password' })} autoComplete="new-password" required />
          <Button type="submit" variant="contained" disabled={isPending}>{t('ra.action.save')}</Button>
        </Box>
      )}
    </AuthShell>
  );
}
