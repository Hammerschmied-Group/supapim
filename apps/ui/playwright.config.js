// E2E against the production build, served by apps/server itself (server.mjs: UI, admin API, MCP),
// on :55391 (E2E_PORT) so it can run next to the Vite dev server (:55390, UI_DEV_PORT). Gateway and users: the local stack.
import { defineConfig, devices } from '@playwright/test';
import { readEnv } from './e2e/env.js';

const env = readEnv();
const PORT = Number(process.env.E2E_PORT || 55391);   // parallel worktrees: set E2E_PORT

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}/cms/`,
    ...devices['Desktop Chrome'],
    viewport: { width: 1400, height: 900 },
    locale: 'en-US',
    trace: 'retain-on-failure',
  },
  webServer: {
    // the real server (UI + admin API + MCP), so the admin tests run against what ships: same origin for UI and /cms/api/admin
    command: 'node ../server/server.mjs',
    url: `http://127.0.0.1:${PORT}/cms/config.json`,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT), SUPABASE_PUBLIC_URL: env.SUPABASE_PUBLIC_URL, SUPABASE_ANON_KEY: env.ANON_KEY,
      PUBLIC_BASE_URL: `http://127.0.0.1:${PORT}`, AUTH_ISSUER: env.API_EXTERNAL_URL,
      // only this server process gets the key (for src/admin); invites return links, the stack has no SMTP
      SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY, CMS_ADMIN_INVITE_DELIVERY: 'link',
    },
  },
});
