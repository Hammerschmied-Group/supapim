import { text } from '../result.mjs';

export function registerWhoami({ tool }) {
  tool('whoami', {
    title: 'Who am I',
    description: 'Shows the signed-in person, their database role and the OAuth client this connection belongs to.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ auth }) => {
    const c = auth.claims;
    const me = { email: c.email, user_id: c.sub, db_role: c.role, oauth_client_id: c.client_id ?? null,
                 scope: c.scope ?? null, token_expires_at: new Date(c.exp * 1000).toISOString() };
    return { content: [text(JSON.stringify(me, null, 2))] };
  });
}
