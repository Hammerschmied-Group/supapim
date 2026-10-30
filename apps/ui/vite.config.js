// Build: static files under /cms/ (served by apps/server, see apps/server/src/ui/).
// Dev: `npm run dev` on :55390 (UI_DEV_PORT) against the gateway; config.json comes from the repo .env
// (only SUPABASE_PUBLIC_URL and the public ANON_KEY are read).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function devConfig() {
  return {
    name: 'cms-dev-config',
    configureServer(server) {
      server.middlewares.use('/cms/config.json', (_req, res) => {
        const env = Object.fromEntries(readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')
          .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ supabaseUrl: env.SUPABASE_PUBLIC_URL, anonKey: env.ANON_KEY }));
      });
    },
  };
}

export default defineConfig({
  base: '/cms/',
  plugins: [react(), devConfig()],
  // decode-uri-component ≤ 0.4.2 (via react-admin → query-string 7) has a DoS advisory; the shim keeps it out of the bundle
  resolve: { alias: { 'decode-uri-component': fileURLToPath(new URL('./src/shims/decode-uri-component.cjs', import.meta.url)) } },
  // parallel worktrees on the shared stack: UI_DEV_PORT
  server: { port: Number(process.env.UI_DEV_PORT || 55390), strictPort: true, host: '127.0.0.1',
    // /cms/api/admin lives in apps/server (scripts/dev-admin.sh); CMS_API_PROXY points the dev server at it
    proxy: { '/cms/api': process.env.CMS_API_PROXY || 'http://127.0.0.1:55381' } },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
});
