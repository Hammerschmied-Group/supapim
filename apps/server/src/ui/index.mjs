// Serves the CMS UI (apps/ui, a static Vite build) under /cms and its runtime config.
//
// /cms/config.json carries only what the browser needs and may see: the public Supabase URL and the
// anon key. Nothing else from the server's environment reaches this module — the caller passes the
// two values explicitly (the service key, used by /cms/api/admin/* in 5c, is never handed in here).
// The UI uses a hash router, so there is no SPA fallback: /cms/mcp and /cms/api/* stay free.
import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIST = fileURLToPath(new URL('../../../ui/dist', import.meta.url));   // apps/ui/dist in the repo

export function mountCmsUi(app, { supabaseUrl, anonKey, distDir = process.env.CMS_UI_DIR || DEFAULT_DIST }) {
  if (!existsSync(distDir)) {
    console.warn(`cms ui: ${distDir} missing (run "npm run build" in apps/ui) — /cms not served`);
    return;
  }
  const csp = [
    "default-src 'self'",
    `connect-src 'self' ${supabaseUrl}`,
    `img-src 'self' data: blob: ${supabaseUrl}`,
    "style-src 'self' 'unsafe-inline'",          // emotion (MUI) injects style tags
    "script-src 'self'",
    "font-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');

  app.get('/cms/config.json', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ supabaseUrl, anonKey });
  });
  // Headers only on files actually served here, never on /cms/mcp or /cms/api/* responses.
  app.use('/cms', express.static(distDir, {
    index: 'index.html',          // also redirects /cms → /cms/
    setHeaders: (res, path) => {
      res.set('Content-Security-Policy', csp);
      res.set('Referrer-Policy', 'no-referrer');
      res.set('X-Content-Type-Options', 'nosniff');
      // hashed bundles are immutable; index.html must always be revalidated
      res.set('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  }));
}
