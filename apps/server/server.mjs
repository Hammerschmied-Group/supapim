// Entry point of the plugin container: one Express app, one `register…(app, config)` per feature.
//   registerMcp      → /cms/mcp (+ /.well-known/oauth-protected-resource/cms/mcp)        src/mcp/
//   registerConsent  → /oauth/consent  (forwards to the consent page in the UI, /cms/#/consent; the page is apps/ui/src/consent.jsx)
//   mountCmsUi       → /cms/ + /cms/config.json (static apps/ui build)                     src/ui/
// Task 5c adds the admin API (/cms/api/admin/*) with one more line below; each feature
// lives in its own directory and brings its own body parser, so nothing here is shared state.
import express from 'express';
import { loadConfig } from './src/config.mjs';
import { registerMcp } from './src/mcp/index.mjs';
import { registerConsent } from './src/consent.mjs';
import { mountCmsUi } from './src/ui/index.mjs';
import { adminKeyPresent, registerAdmin } from './src/admin/index.mjs';

const config = loadConfig();
const app = express();
app.disable('x-powered-by');

app.get('/health', (_req, res) => res.json({ ok: true, version: process.env.CMS_VERSION || 'dev' }));
// Auth links that fall back to SITE_URL land on the root; the browser keeps the #fragment (tokens) across the redirect.
app.get('/', (_req, res) => res.redirect(302, '/cms/'));

const mcp = registerMcp(app, config.mcp);
await registerConsent(app, config);
// /cms/api/admin/*: the only code that reads a service key (src/admin). Only in a process that has one; without it the
// admin API runs as its own service (admin.mjs, `cms-admin`) and this process serves UI, MCP and consent alone.
if (adminKeyPresent()) registerAdmin(app, config.mcp);
// The UI gets only the public URL and the anon key, never anything else from the environment.
mountCmsUi(app, { supabaseUrl: config.supabasePublicUrl, anonKey: config.supabaseAnonKey });

app.listen(config.port, () => console.log(JSON.stringify({
  type: 'startup', port: config.port, mcp_resource: mcp.resource, issuer: config.mcp.issuer, supabase: config.mcp.supabaseUrl })));
