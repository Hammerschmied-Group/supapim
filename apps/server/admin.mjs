// Entry point for the admin API alone (/cms/api/admin/*), for a deployment that keeps the service key out of the
// process that serves the MCP server and the UI (docs/security/findings.md F-15): run this image twice,
//   cms        node server.mjs   — UI, MCP, consent; without the service key (its admin routes answer 503)
//   cms-admin  node admin.mjs    — only the admin API; the one process that gets the service key
// and route /cms/api/admin/ to cms-admin at the gateway. Same configuration variables as server.mjs.
import express from 'express';
import { loadConfig } from './src/config.mjs';
import { registerAdmin } from './src/admin/index.mjs';

const config = loadConfig();
const app = express();
app.disable('x-powered-by');
app.get('/health', (_req, res) => res.json({ ok: true }));
const admin = registerAdmin(app, config.mcp);
app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
app.listen(config.port, () => console.log(JSON.stringify({ type: 'startup', component: 'admin', port: config.port, configured: admin.configured })));
