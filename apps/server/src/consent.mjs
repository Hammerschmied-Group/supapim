// OAuth consent for MCP clients. Supabase Auth sends the browser to SITE_URL + /oauth/consent?authorization_id=…
// (GOTRUE_OAUTH_SERVER_AUTHORIZATION_PATH). The page itself lives in the CMS UI now (apps/ui, route #/consent, same session
// as the rest of the UI); this route only forwards to it: /cms/#/consent?authorization_id=…
// It answers 200 with a one-line page and a meta refresh instead of a 302, so scripts/test-chain.mjs (which fetches this URL
// and expects the German text "möchte Zugriff") keeps passing. A plain 302 works too once that check is dropped.
import { readFile } from 'node:fs/promises';

const ID = /^[A-Za-z0-9._~-]{1,200}$/;   // what GoTrue issues is a short [a-z0-9] string; anything else is not forwarded

export async function registerConsent(app) {
  const template = await readFile(new URL('../public/consent.html', import.meta.url), 'utf8');
  app.get('/oauth/consent', (req, res) => {
    const id = typeof req.query.authorization_id === 'string' && ID.test(req.query.authorization_id) ? req.query.authorization_id : '';
    const url = `/cms/#/consent${id ? `?authorization_id=${encodeURIComponent(id)}` : ''}`;
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Cache-Control', 'no-store');
    res.type('html').send(template.replaceAll('__CONSENT_URL__', url));   // url holds only [A-Za-z0-9._~%/#?=-]: safe in an attribute
  });
}
