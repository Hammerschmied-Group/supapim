// Admin API under /cms/api/admin/*: the only code that uses the service key.
//
//   POST /cms/api/admin/invite                {email}   invite a person (mail, or a one-time link — see below)
//   POST /cms/api/admin/users/:id/resend                resend the invite of someone who has not accepted yet
//   POST /cms/api/admin/users/:id/block                 block sign-in (new tokens; existing ones live until they expire)
//   POST /cms/api/admin/users/:id/unblock               undo that
//
// Roles are NOT handled here: assigning one is a database operation (cms_api.assign_role, with the
// admin's own token). Rules for the key (Task 5, decided 2026-10-28):
//   - read from the environment here and nowhere else; held only by ./gotrue.mjs, never passed on
//   - used only after ./gate.mjs approved the request: a valid token AND the database says admin
//   - never in a response, a log line or the browser bundle (scripts/check-no-service-key.sh, E2E grep)
//   - every request is logged with the admin's e-mail (./log.mjs)
// Without SUPABASE_SECRET_KEY the routes answer 503 and the rest of the server is unaffected.
//
// CMS_ADMIN_INVITE_DELIVERY=mail (default): GoTrue sends the invite mail → needs working SMTP.
// CMS_PUBLIC_UI_URL (e.g. https://cms.example.com/cms/): where invitation links land; without it, the caller's Origin + /cms/.
// CMS_ADMIN_INVITE_DELIVERY=link: nothing is sent; the response carries the one-time sign-in link for the
//   admin to pass on. For setups without SMTP (the local stack has none) and for tests.
import express from 'express';
import { createGate } from './gate.mjs';
import { createGoTrue } from './gotrue.mjs';
import { logAdmin } from './log.mjs';

const ADMIN_PATH = '/cms/api/admin';
const EMAIL = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Does this process hold a service key? server.mjs mounts the admin API only then: in a split deployment the `cms`
// service has none and /cms/api/admin/* is routed to `cms-admin` (admin.mjs) instead (docs/security F-15).
export const adminKeyPresent = (env = process.env) => Boolean(env.SUPABASE_SECRET_KEY);

// cfg: the shared, non-secret connection settings (config.mcp: supabaseUrl, anonKey, issuer, jwksUrl).
export function registerAdmin(app, cfg, env = process.env) {
  const key = env.SUPABASE_SECRET_KEY || '';
  const delivery = env.CMS_ADMIN_INVITE_DELIVERY === 'link' ? 'link' : 'mail';
  const gate = createGate(cfg);
  const gotrue = key ? createGoTrue({ baseUrl: cfg.supabaseUrl, key }) : null;

  const router = express.Router();
  router.use(express.json({ limit: '4kb' }));
  router.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); next(); });

  // One wrapper: gate → handler → access log. The handler runs only for an approved admin.
  const route = (action, handler) => async (req, res) => {
    const t0 = Date.now();
    const entry = { action, delivery: action === 'invite' || action === 'resend' ? delivery : undefined };
    const finish = (status, body, code) => {
      logAdmin({ ...entry, status, code, ms: Date.now() - t0 });
      res.status(status).json(body);
    };
    try {
      const g = await gate(req);
      if (!g.ok) {
        if (g.claims) Object.assign(entry, { sub: g.claims.sub, email: g.claims.email, role: g.claims.role });
        return finish(g.status, { error: g.code, message: g.message }, g.code);
      }
      Object.assign(entry, { sub: g.claims.sub, email: g.email, role: g.role });
      if (!gotrue) return finish(503, { error: 'not_configured', message: 'The admin API has no service key configured (SUPABASE_SECRET_KEY).' }, 'not_configured');
      const out = await handler({ req, admin: g, gotrue, entry });
      return finish(out.status, out.body, out.code);
    } catch {
      return finish(500, { error: 'internal', message: 'Unexpected error in the admin API.' }, 'exception');
    }
  };

  const fail = (r, fallbackCode) => {
    const code = r.error?.code ?? fallbackCode;
    const mailFailed = r.status >= 500 && /sending .*email/i.test(r.error?.message ?? '');
    if (mailFailed) {
      return { status: 502, code: 'mail_failed', body: { error: 'mail_failed',
        message: 'The Auth server could not send the mail (no SMTP configured?). Set CMS_ADMIN_INVITE_DELIVERY=link to get the link instead.' } };
    }
    const status = r.status >= 400 && r.status < 600 && r.status !== 401 && r.status !== 403 ? r.status : 502;
    return { status, code, body: { error: code, message: r.error?.message || 'The Auth server refused the request.' } };
  };

  // The invite link must land on the UI (/cms/), not on SITE_URL's root. CMS_PUBLIC_UI_URL (production) fixes it, so no
  // request header decides where an invitation leads (F-10). Without it (local development, Vite on any port) the UI's
  // own origin is used; GoTrue still checks either against its allow list.
  const fixedUiUrl = env.CMS_PUBLIC_UI_URL ? env.CMS_PUBLIC_UI_URL.replace(/\/?$/, '/') : null;
  const uiUrl = (req) => {
    if (fixedUiUrl) return fixedUiUrl;
    const origin = req.get('origin');
    return origin && /^https?:\/\/[^/\s]+$/.test(origin) ? `${origin}/cms/` : undefined;
  };

  const delivered = (r, user) => ({ status: 200, body: { ok: true, delivery, user, ...(delivery === 'link' ? { action_link: r.action_link } : {}) } });

  router.post('/invite', route('invite', async ({ req, gotrue, entry }) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email) || email.length > 254) return { status: 400, code: 'bad_email', body: { error: 'bad_email', message: 'Enter a valid e-mail address.' } };
    entry.target = email;
    const r = await gotrue.invite(email, delivery, uiUrl(req));
    return r.error ? fail(r, 'invite_failed') : delivered(r, r.user);
  }));

  router.post('/users/:id/resend', route('resend', async ({ req, gotrue, entry }) => {
    const id = req.params.id;
    if (!UUID.test(id)) return { status: 400, code: 'bad_id', body: { error: 'bad_id', message: 'Not a user id.' } };
    entry.target = id;
    const u = await gotrue.getUser(id);
    if (u.error) return fail(u, 'not_found');
    entry.target = u.user.email;
    if (u.user.last_sign_in_at || (u.user.confirmed_at && !u.user.invited_at)) {
      return { status: 409, code: 'already_accepted', body: { error: 'already_accepted', message: 'This person has already accepted the invitation.' } };
    }
    const r = await gotrue.invite(u.user.email, delivery, uiUrl(req));
    return r.error ? fail(r, 'invite_failed') : delivered(r, r.user);
  }));

  for (const [name, banned] of [['block', true], ['unblock', false]]) {
    router.post(`/users/:id/${name}`, route(name, async ({ req, admin, gotrue, entry }) => {
      const id = req.params.id;
      if (!UUID.test(id)) return { status: 400, code: 'bad_id', body: { error: 'bad_id', message: 'Not a user id.' } };
      entry.target = id;
      if (id === admin.claims.sub) return { status: 409, code: 'self', body: { error: 'self', message: 'You cannot block yourself.' } };
      const u = await gotrue.getUser(id);
      if (u.error) return fail(u, 'not_found');
      entry.target = u.user.email;
      const r = await gotrue.setBanned(id, banned);
      return r.error ? fail(r, 'update_failed') : { status: 200, body: { ok: true, user: r.user } };
    }));
  }

  router.use((_req, res) => res.status(404).json({ error: 'not_found', message: 'Unknown admin endpoint.' }));
  // body-parser errors (malformed JSON, too large) as JSON, before the gate: nothing was authorised yet
  router.use((err, _req, res, _next) => {
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    logAdmin({ action: 'request', status, code: 'bad_request' });
    res.status(status).json({ error: 'bad_request', message: 'The request body is not valid.' });
  });
  app.use(ADMIN_PATH, router);
  return { path: ADMIN_PATH, delivery, configured: Boolean(key) };
}
