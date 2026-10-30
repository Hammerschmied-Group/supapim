// Runtime configuration, read once at start-up. The only place that touches process.env.
// The MCP module (src/mcp/*) gets its own object from here and never sees the environment: it holds
// the anon key only, never a service key or a database credential.

export const MCP_PATH = '/cms/mcp';

export function loadConfig(env = process.env) {
  const get = (k, d) => env[k] ?? d;
  const port = Number(get('PORT', 8080));
  const supabasePublicUrl = get('SUPABASE_PUBLIC_URL', 'http://localhost:55321').replace(/\/$/, '');
  // What a client (browser, Claude, ChatGPT) calls: the gateway host that also serves /cms/mcp.
  const publicBaseUrl = get('PUBLIC_BASE_URL', supabasePublicUrl).replace(/\/$/, '');
  // What this server calls: the Supabase gateway, like any other client (Cloud: https://<ref>.supabase.co).
  const supabaseUrl = get('SUPABASE_URL', supabasePublicUrl).replace(/\/$/, '');
  const issuer = get('AUTH_ISSUER', `${supabasePublicUrl}/auth/v1`);
  const maxUploadBytes = Number(get('MCP_MAX_UPLOAD_BYTES', 5 * 1024 * 1024));

  return {
    port,
    supabasePublicUrl,
    supabaseAnonKey: get('SUPABASE_ANON_KEY', ''),
    mcp: {
      publicBaseUrl,
      supabaseUrl,
      supabasePublicUrl,
      anonKey: get('SUPABASE_ANON_KEY', ''),
      issuer,
      jwksUrl: get('JWKS_URL', `${supabaseUrl}/auth/v1/.well-known/jwks.json`),
      rate: { burst: Number(get('MCP_RATE_BURST', 60)), perMinute: Number(get('MCP_RATE_PER_MINUTE', 120)) },
      maxUploadBytes,
      maxTextDownloadBytes: Number(get('MCP_MAX_TEXT_DOWNLOAD_BYTES', 256 * 1024)),
      maxInlineImageBytes: Number(get('MCP_MAX_INLINE_IMAGE_BYTES', 1536 * 1024)),
      maxResultChars: Number(get('MCP_MAX_RESULT_CHARS', 200_000)),
      // base64 inflates by 4/3; leave room for the JSON envelope
      bodyLimitBytes: Math.ceil(maxUploadBytes * 4 / 3) + 256 * 1024,
    },
  };
}
