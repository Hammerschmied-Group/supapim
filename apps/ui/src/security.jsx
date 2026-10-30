// "Security" page: two-factor authentication with an authenticator app (TOTP). Enrolling, listing, removing.
import { useCallback, useEffect, useState } from 'react';
import { Title, useTranslate } from 'react-admin';
import { Alert, Box, Button, Card, CardContent, Chip, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, TextField, Typography } from '@mui/material';
import { useSupabase } from './context.js';
import { authErrorKey, enrollTotp, removeFactor, verifiedFactors, verifyEnrollment } from './session.js';

export function SecurityPage() {
  const t = useTranslate();
  const supabase = useSupabase();
  const [factors, setFactors] = useState(null);
  const [enrolling, setEnrolling] = useState(null);     // { id, secret, qr }
  const [removing, setRemoving] = useState(null);       // factor
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  const message = (err) => { const k = authErrorKey(err); return k ? t(k) : err?.message; };
  const reload = useCallback(async () => {
    try { setFactors(await verifiedFactors(supabase)); } catch (err) { setError(message(err)); }
  }, [supabase]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [reload]);

  const start = async () => {
    setError(null); setDone(null);
    try { setEnrolling(await enrollTotp(supabase)); } catch (err) { setError(message(err)); }
  };
  const confirm = async (e) => {
    e.preventDefault();
    const code = new FormData(e.currentTarget).get('code');
    setError(null);
    try {
      await verifyEnrollment(supabase, enrolling.id, code);
      setEnrolling(null);
      setDone(t('cms.security.enabled_done', { _: 'Two-factor authentication is on. You will be asked for a code at every sign-in.' }));
      await reload();
    } catch (err) { setError(message(err)); }
  };
  const cancel = async () => {
    // an unverified factor is useless and would be removed by the next attempt anyway
    try { await removeFactor(supabase, enrolling.id); } catch { /* ignore */ }
    setEnrolling(null);
  };
  const remove = async () => {
    setError(null);
    try {
      await removeFactor(supabase, removing.id);
      setRemoving(null);
      setDone(t('cms.security.disabled_done', { _: 'Two-factor authentication is off.' }));
      await reload();
    } catch (err) { setRemoving(null); setError(message(err)); }
  };

  return (
    <Card sx={{ mt: 2, maxWidth: 640 }}>
      <Title title={t('cms.security.title', { _: 'Security' })} />
      <CardContent>
        <Typography variant="h6" gutterBottom>{t('cms.security.mfa_title', { _: 'Two-factor authentication' })}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t('cms.security.mfa_intro', { _: 'Use an authenticator app (for example 1Password, Authy or Google Authenticator) to confirm your sign-in with a 6-digit code.' })}
        </Typography>
        {error && <Alert severity="error" role="alert" sx={{ mb: 2 }}>{error}</Alert>}
        {done && <Alert severity="success" sx={{ mb: 2 }} data-testid="security-done">{done}</Alert>}

        {factors && factors.length > 0 && !enrolling && (
          <Box data-testid="mfa-enabled">
            {factors.map((f) => (
              <Box key={f.id} sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
                <Chip color="success" label={t('cms.security.on', { _: 'On' })} />
                <Typography sx={{ flex: 1 }}>{f.friendly_name || t('cms.security.authenticator', { _: 'Authenticator app' })}</Typography>
                <Button color="error" onClick={() => setRemoving(f)}>{t('cms.security.turn_off', { _: 'Turn off' })}</Button>
              </Box>
            ))}
          </Box>
        )}

        {factors && factors.length === 0 && !enrolling && (
          <Button variant="contained" onClick={start}>{t('cms.security.set_up', { _: 'Set up authenticator app' })}</Button>
        )}

        {enrolling && (
          <Box component="form" onSubmit={confirm} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }} data-testid="mfa-enroll">
            <Typography variant="body2">{t('cms.security.scan', { _: 'Scan this QR code with your authenticator app, or type the key in by hand.' })}</Typography>
            <Box component="img" src={enrolling.qr} alt={t('cms.security.qr_alt', { _: 'QR code for the authenticator app' })} sx={{ width: 180, height: 180, bgcolor: '#fff', p: 1, borderRadius: 1 }} />
            <Typography variant="body2" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }} data-testid="totp-secret">{enrolling.secret}</Typography>
            <TextField name="code" label={t('cms.auth.mfa_code', { _: 'Authentication code' })} required autoFocus
              slotProps={{ htmlInput: { inputMode: 'numeric', autoComplete: 'one-time-code', pattern: '[0-9 ]{6,7}', maxLength: 7 } }} />
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button type="submit" variant="contained">{t('cms.security.verify_enable', { _: 'Verify and turn on' })}</Button>
              <Button onClick={cancel}>{t('ra.action.cancel')}</Button>
            </Box>
          </Box>
        )}
      </CardContent>

      <Dialog open={!!removing} onClose={() => setRemoving(null)}>
        <DialogTitle>{t('cms.security.turn_off_title', { _: 'Turn off two-factor authentication?' })}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t('cms.security.turn_off_text', { _: 'Your account will be protected by the password alone.' })}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoving(null)}>{t('ra.action.cancel')}</Button>
          <Button color="error" onClick={remove}>{t('cms.security.turn_off', { _: 'Turn off' })}</Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}
