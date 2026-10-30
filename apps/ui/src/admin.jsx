// Administration (admin roles only): people, invitations, roles, effective rights.
//   - roles are assigned with cms_api.assign_role / revoke_role (database functions, the admin's own token)
//   - inviting, resending an invitation and blocking go through /cms/api/admin/* (apps/server, the only
//     place with the service key); the server re-checks that this person is an admin
//   - files without a record: uploads no image / file column points to (cms_api.unreferenced_files), to open or delete
// GRANTs are not edited here (v1): the rights themselves stay SQL; this page only shows them.
import { useCallback, useContext, useEffect, useState } from 'react';
import { Title, useGetIdentity, usePermissions } from 'react-admin';
import {
  Alert, Box, Button, Card, CardContent, Chip, Dialog, DialogContent, DialogTitle, MenuItem, Select, Stack, Table,
  TableBody, TableCell, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import { ApiContext } from './api.js';
import { RenameFileButton, StorageContext } from './fields.jsx';
import { HistoryTable, useHistory } from './history.jsx';
import { summarizeRights, userStatus } from './format.js';

const NONE = '';
const errText = (e) => e?.message || String(e);

function InviteCard({ roles, onDone }) {
  const api = useContext(ApiContext);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState(NONE);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setResult(null);
    try {
      const r = await api.admin('/invite', { email });
      let warning = null;
      if (role && r.user?.id) {
        try { await api.rpc('assign_role', { user_id: r.user.id, role_name: role }); } catch (err) { warning = `The invitation went out, but the role could not be assigned: ${errText(err)}`; }
      }
      setResult({ ok: true, r, warning, email: r.user?.email ?? email });
      setEmail(''); setRole(NONE);
      onDone();
    } catch (err) {
      setResult({ ok: false, message: errText(err) });
    } finally { setBusy(false); }
  };

  return (
    <Card sx={{ mb: 3 }}>
      <CardContent>
        <Typography variant="h6" gutterBottom>Invite a person</Typography>
        <Box component="form" onSubmit={submit} sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <TextField label="E-mail" type="email" size="small" required value={email} onChange={(e) => setEmail(e.target.value)} sx={{ minWidth: 280 }} />
          <TextField select label="Role (optional)" size="small" value={role} onChange={(e) => setRole(e.target.value)} sx={{ minWidth: 200 }} data-testid="invite-role">
            <MenuItem value={NONE}><em>no role yet</em></MenuItem>
            {roles.map((r) => <MenuItem key={r.role_name} value={r.role_name}>{r.role_name}</MenuItem>)}
          </TextField>
          <Button type="submit" variant="contained" disabled={busy || !email}>Invite</Button>
        </Box>
        {result?.ok && (
          <Alert severity={result.warning ? 'warning' : 'success'} sx={{ mt: 2 }} data-testid="invite-result">
            {result.r.delivery === 'link'
              ? `${result.email} is invited. No mail is sent on this server — pass this one-time link on:`
              : `Invitation mailed to ${result.email}.`}
            {result.r.delivery === 'link' && (
              <Box component="code" sx={{ display: 'block', mt: 1, wordBreak: 'break-all' }} data-testid="invite-link">{result.r.action_link}</Box>
            )}
            {result.warning && <Box sx={{ mt: 1 }}>{result.warning}</Box>}
          </Alert>
        )}
        {result && !result.ok && <Alert severity="error" sx={{ mt: 2 }} data-testid="invite-error">{result.message}</Alert>}
      </CardContent>
    </Card>
  );
}

function RightsDialog({ role, onClose }) {
  const api = useContext(ApiContext);
  const [state, setState] = useState({ summary: null, error: null });
  useEffect(() => {
    let live = true;
    setState({ summary: null, error: null });
    if (!role) return undefined;
    api.rpc('effective_rights', { role_name: role })
      .then((r) => live && setState({ summary: summarizeRights(r), error: null }))
      .catch((error) => live && setState({ summary: null, error }));
    return () => { live = false; };
  }, [api, role]);
  const { summary, error } = state;
  const tick = (v) => (v ? '✓' : '–');
  return (
    <Dialog open={Boolean(role)} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Effective rights of <code>{role}</code></DialogTitle>
      <DialogContent data-testid="rights">
        {error && <Alert severity="error">{errText(error)}</Alert>}
        {!summary && !error && <Typography>Loading …</Typography>}
        {summary && (
          <>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              As Postgres computes them from GRANTs, column grants and policies. Rights are edited in SQL, not here.
            </Typography>
            {summary.tables.length === 0 ? <Typography>No tables.</Typography> : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Table</TableCell><TableCell align="center">Read</TableCell><TableCell align="center">Create</TableCell>
                    <TableCell>Change</TableCell><TableCell align="center">Delete</TableCell><TableCell align="center">RLS</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {summary.tables.map((t) => (
                    <TableRow key={t.name} data-testid="rights-row" data-table={t.name}>
                      <TableCell>{t.name}</TableCell>
                      <TableCell align="center">{tick(t.select)}</TableCell>
                      <TableCell align="center">{tick(t.insert)}</TableCell>
                      <TableCell>{t.update ? (t.updatableColumns.length ? t.updatableColumns.join(', ') : '✓') : '–'}</TableCell>
                      <TableCell align="center">{tick(t.delete)}</TableCell>
                      <TableCell align="center">{t.rls ? `${t.policies} pol.` : 'off'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <Typography variant="subtitle2" sx={{ mt: 2 }}>Storage</Typography>
            {summary.buckets.length === 0 ? <Typography variant="body2">No buckets.</Typography> : (
              <Stack direction="row" spacing={1} sx={{ mt: 0.5, flexWrap: 'wrap' }}>
                {summary.buckets.map((b) => <Chip key={b.id} size="small" label={`${b.id}${b.public ? ' (public)' : ''}`} />)}
              </Stack>
            )}
            {summary.objectPrivileges && (
              <Typography variant="body2" sx={{ mt: 1 }}>
                Objects: {Object.entries(summary.objectPrivileges).filter(([, v]) => v).map(([k]) => k).join(', ') || 'no access'}
              </Typography>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function HistoryDialog({ user, onClose }) {
  const { entries, error } = useHistory('cms.user_roles', user ? { user_id: user.user_id } : null, Boolean(user));
  return (
    <Dialog open={Boolean(user)} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Role history of {user?.email}</DialogTitle>
      <DialogContent data-testid="role-history">
        {error && <Alert severity="error">{errText(error)}</Alert>}
        {!entries && !error && <Typography>Loading …</Typography>}
        {entries && <HistoryTable entries={entries} table="cms.user_roles" />}
      </DialogContent>
    </Dialog>
  );
}

const STATUS_COLOR = { active: 'success', invited: 'info', blocked: 'warning' };

/**
 * Uploads that no image / file column points to: a form that was left, a save that failed, an upload over
 * MCP that was never linked. Link one in the record's image field ("Existing file") or delete it here.
 */
function UnreferencedFilesCard() {
  const api = useContext(ApiContext);
  const storage = useContext(StorageContext);
  const [state, setState] = useState({ files: null, error: null });
  const [message, setMessage] = useState(null);
  const load = useCallback(() => {
    api.rpc('unreferenced_files').then((files) => setState({ files, error: null })).catch((error) => setState({ files: null, error }));
  }, [api]);
  useEffect(() => { load(); }, [load]);
  const open = (f) => storage.fileUrl({ bucket: f.bucket_id, public: false }, f.name)
    .then((url) => window.open(url, '_blank', 'noopener')).catch((e) => setMessage({ ok: false, text: errText(e) }));
  const remove = async (f) => {
    if (!window.confirm(`Delete ${f.bucket_id}/${f.name}? This cannot be undone.`)) return;
    try {
      await storage.remove({ bucket: f.bucket_id }, f.name);
      setMessage({ ok: true, text: `Deleted ${f.bucket_id}/${f.name}.` });
    } catch (e) { setMessage({ ok: false, text: errText(e) }); }
    load();
  };
  return (
    <Card sx={{ mt: 3 }} data-testid="unreferenced-files">
      <CardContent>
        <Typography variant="h6" gutterBottom>Files without a record</Typography>
        <Typography variant="body2" color="text.secondary" gutterBottom>
          Uploads that no image or file column points to. Link one in the record&apos;s image field (&ldquo;Existing file&rdquo;) or delete it.
          Only rows you can see are taken into account.
        </Typography>
        {message && <Alert severity={message.ok ? 'success' : 'error'} sx={{ mb: 2 }} onClose={() => setMessage(null)}>{message.text}</Alert>}
        {state.error && <Alert severity="error">{errText(state.error)}</Alert>}
        {state.files?.length === 0 && <Typography color="text.secondary" data-testid="unreferenced-none">None — every file is in use.</Typography>}
        {state.files?.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow><TableCell>File</TableCell><TableCell>Size</TableCell><TableCell>Uploaded</TableCell><TableCell align="right">Actions</TableCell></TableRow>
            </TableHead>
            <TableBody>
              {state.files.map((f) => (
                <TableRow key={`${f.bucket_id}/${f.name}`} data-testid="unreferenced-file" data-path={f.name}>
                  <TableCell sx={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{f.bucket_id}/{f.name}</TableCell>
                  <TableCell>{f.size != null ? `${Math.round(f.size / 1024)} KB` : '–'}</TableCell>
                  <TableCell>{new Date(f.created_at).toLocaleString()}</TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    <Button size="small" onClick={() => open(f)}>Open</Button>
                    <RenameFileButton info={{ bucket: f.bucket_id, update: true }} path={f.name}
                      onDone={(p) => { setMessage({ ok: true, text: `Renamed to ${f.bucket_id}/${p}.` }); load(); }} />
                    <Button size="small" color="error" onClick={() => remove(f)}>Delete</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function AdminPage() {
  const api = useContext(ApiContext);
  const model = usePermissions().permissions;
  const { data: me } = useGetIdentity();
  const [users, setUsers] = useState(null);
  const [roles, setRoles] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [rightsRole, setRightsRole] = useState(null);
  const [historyUser, setHistoryUser] = useState(null);

  const load = useCallback(async () => {
    try {
      const [u, r] = await Promise.all([api.rpc('list_users'), api.rpc('list_assignable_roles')]);
      setUsers(u); setRoles(r); setError(null);
    } catch (e) { setError(e); }
  }, [api]);
  useEffect(() => { if (model?.isAdmin) load(); }, [model?.isAdmin, load]);

  if (!model) return null;
  if (!model.isAdmin) return <Alert severity="warning" sx={{ mt: 2 }} data-testid="admin-forbidden">Administration is only available to admin roles.</Alert>;

  const act = async (label, fn) => {
    setNotice(null);
    try { const r = await fn(); await load(); setNotice({ severity: 'success', text: label(r) }); }
    catch (e) { setNotice({ severity: 'error', text: errText(e) }); }
  };
  const setRole = (u, role) => act(
    () => (role ? `${u.email} → ${role}. It takes effect with their next sign-in or token refresh.` : `Role removed from ${u.email}. It ends with their next token refresh.`),
    () => (role ? api.rpc('assign_role', { user_id: u.user_id, role_name: role }) : api.rpc('revoke_role', { user_id: u.user_id })));
  const post = (u, what) => act((r) => (what === 'resend' ? (r.delivery === 'link' ? `Invitation renewed for ${u.email}; new link: ${r.action_link}` : `Invitation mailed to ${u.email}.`)
    : `${u.email} ${what === 'block' ? 'is blocked' : 'is unblocked'}.`), () => api.admin(`/users/${u.user_id}/${what}`));

  return (
    <Box sx={{ mt: 2 }} data-testid="admin-page">
      <Title title="Administration" />
      <InviteCard roles={roles} onDone={load} />
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>People</Typography>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            A role change takes effect with the person's next token (sign-in or refresh, within an hour). Blocking stops new sign-ins and refreshes the same way.
          </Typography>
          {notice && <Alert severity={notice.severity} sx={{ mb: 2 }} data-testid="admin-notice">{notice.text}</Alert>}
          {error && <Alert severity="error">{errText(error)}</Alert>}
          {users && (
            <Table size="small" data-testid="users-table">
              <TableHead>
                <TableRow><TableCell>E-mail</TableCell><TableCell>Status</TableCell><TableCell>Role</TableCell><TableCell>Last sign-in</TableCell><TableCell align="right">Actions</TableCell></TableRow>
              </TableHead>
              <TableBody>
                {users.map((u) => {
                  const status = userStatus(u);
                  const self = me?.id === u.user_id;
                  return (
                    <TableRow key={u.user_id} data-testid="user-row" data-email={u.email}>
                      <TableCell>{u.email}{self && <Chip size="small" label="you" sx={{ ml: 1 }} />}</TableCell>
                      <TableCell><Chip size="small" color={STATUS_COLOR[status]} label={status} /></TableCell>
                      <TableCell>
                        <Tooltip title={self ? 'You cannot change your own role.' : ''}>
                          <span>
                            <Select size="small" value={u.db_role ?? NONE} displayEmpty disabled={self} sx={{ minWidth: 170 }}
                              inputProps={{ 'aria-label': `Role of ${u.email}` }} onChange={(e) => setRole(u, e.target.value)}>
                              <MenuItem value={NONE}><em>no role</em></MenuItem>
                              {u.db_role && !roles.some((r) => r.role_name === u.db_role) && <MenuItem value={u.db_role}>{u.db_role}</MenuItem>}
                              {roles.map((r) => <MenuItem key={r.role_name} value={r.role_name}>{r.role_name}</MenuItem>)}
                            </Select>
                          </span>
                        </Tooltip>
                      </TableCell>
                      <TableCell>{u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString() : '–'}</TableCell>
                      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                        {u.db_role && <Button size="small" onClick={() => setRightsRole(u.db_role)}>Rights</Button>}
                        <Button size="small" onClick={() => setHistoryUser(u)}>History</Button>
                        {status === 'invited' && <Button size="small" onClick={() => post(u, 'resend')}>Resend invite</Button>}
                        {!self && (status === 'blocked'
                          ? <Button size="small" onClick={() => post(u, 'unblock')}>Unblock</Button>
                          : <Button size="small" color="error" onClick={() => post(u, 'block')}>Block</Button>)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card sx={{ mt: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>Effective rights of a role</Typography>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
            {roles.map((r) => (
              <Chip key={r.role_name} label={`${r.role_name} (${r.members})`} onClick={() => setRightsRole(r.role_name)} clickable data-testid={`rights-${r.role_name}`} />
            ))}
          </Stack>
        </CardContent>
      </Card>
      <UnreferencedFilesCard />
      <RightsDialog role={rightsRole} onClose={() => setRightsRole(null)} />
      <HistoryDialog user={historyUser} onClose={() => setHistoryUser(null)} />
    </Box>
  );
}
