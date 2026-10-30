// Only the CMS UI, without the MCP server: for the Playwright E2E tests (apps/ui/playwright.config.js)
// and for trying a build locally. Same module as in server.mjs, so the tests cover the real serving.
//   PORT=55391 SUPABASE_PUBLIC_URL=… SUPABASE_ANON_KEY=… node apps/server/src/ui/standalone.mjs
import express from 'express';
import { mountCmsUi } from './index.mjs';

const PORT = Number(process.env.PORT ?? 55391);
const app = express();
app.disable('x-powered-by');
mountCmsUi(app, { supabaseUrl: process.env.SUPABASE_PUBLIC_URL, anonKey: process.env.SUPABASE_ANON_KEY ?? '' });
app.listen(PORT, '127.0.0.1', () => console.log(`cms ui on http://127.0.0.1:${PORT}/cms/`));
