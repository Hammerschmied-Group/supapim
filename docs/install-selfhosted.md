# Installation: self-hosted Supabase

Goal: **under 15 minutes** from "Supabase is running" to "a person signs in to the CMS and Claude connects over MCP". Measured on a fresh stack: see [Timing measurement](#timing-measurement).

SupaPIM plugs into an existing Supabase stack. It consists of **one container** (CMS UI, MCP server and admin API in a single image) and **one SQL migration**. No Supabase files are modified: the integration is Docker Compose layering (`COMPOSE_FILE`), and a wrapper inserts the gateway routes at startup into the configuration the gateway reads anyway. This works for **Envoy** (the default since self-hosted v0.8) and **Kong**.

For Supabase Cloud see [`install-cloud.md`](install-cloud.md).

## Requirements

| | |
|---|---|
| Supabase | Self-hosted stack from the official `docker/` directory, tag `self-hosted/v0.8.x` (matrix: [`compatibility.md`](compatibility.md)), Postgres 15 or 17 |
| Docker | Docker Engine with Compose ≥ 2.24 (`docker compose version`), `linux/amd64` or `linux/arm64` |
| Address | **One** public address for the gateway, e.g. `https://supabase.example.com`. Claude and ChatGPT only connect over **https**. TLS terminates in front of the gateway (Caddy/nginx/Cloudflare; upstream ships `docker-compose.caddy.yml` and `docker-compose.nginx.yml`). For trying it out, `http://localhost:8000` is enough. |
| Mail | An SMTP server for invitations and password resets (`SMTP_*` in `.env`). Without SMTP you can use the invitation links the script prints. |
| Tools | `curl`, `bash`; no Node, no Git |

The Supabase `.env` should already have `POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY` and `SERVICE_ROLE_KEY` set (upstream: `sh utils/generate-keys.sh`). The asymmetric keys (`JWT_KEYS`, `JWT_JWKS`, `SUPABASE_SECRET_KEY`) come from `sh utils/add-new-auth-keys.sh`; the SupaPIM script can do that for you (`--generate-keys`).

## Installation in 4 steps

Run all commands in the **Supabase `docker/` directory** (where `docker-compose.yml` and `.env` live).

### 1. Unpack the package

```bash
tar -xzf supapim-selfhosted-<version>.tar.gz        # creates ./cms/
```

Checksum: `shasum -a 256 -c SHA256SUMS`.

### 2. Provide the image

The image `ghcr.io/hammerschmied-group/supapim:<version>` (multi-arch: amd64 and arm64) is available in one of these ways:

```bash
docker load -i cms/image/supapim-<version>.oci.tar         # archive is in the package ("with image" variant)
# or from the registry:  CMS_IMAGE=ghcr.io/hammerschmied-group/supapim:<version> in .env
```

### 3. Install

```bash
cms/install.sh --public-url https://supabase.example.com --generate-keys all admin@example.com
```

`all` runs the following steps in order (each can be repeated on its own, see `cms/install.sh --help`):

| Step | What happens |
|---|---|
| `sql` | The migration `cms/sql/install.sql` runs as `postgres` (idempotent). Creates the schemas `cms`, `cms_api`, `audit`. Changes **no** privileges on your tables. |
| `env` | `.env` is extended (with a backup `.env.bak.cms-…`): `CMS_IMAGE`, `cms_api` in `PGRST_DB_SCHEMAS`, the addresses (`SUPABASE_PUBLIC_URL`, `API_EXTERNAL_URL`, `SITE_URL`), and `COMPOSE_FILE` extended with the package files for your gateway. With `--generate-keys`, missing keys are generated. Values are never printed. |
| `docker compose up -d --wait` | The `cms` container starts; `auth`, `rest`, `storage`, `realtime`, `functions` and the gateway are recreated with the new settings. |
| `admin <mail>` | Creates the role `cms_admin` (no login, no DDL), sets it as the admin role, invites the person and assigns the role to them. Prints a **one-time link**. |
| `check` | Checks through the public address: UI, MCP, metadata, **open OAuth route without API key**, registration, `cms_api` in PostgREST, database. Each line is `ok` or `FAIL` with a reason. |

Kong instead of Envoy: run `sh run.sh config add kong` first (upstream), then the same command; the script detects Kong in `COMPOSE_FILE`. `--gateway kong` forces it.

### 4. Sign in and connect

1. Open the printed link: the CMS UI asks for a password (and offers an authenticator app under "Security"). After that the person is an admin. Add more people under **Admin → People**.
2. **New brand** (the brand's schema, privileges, audit, exposure in PostgREST) in one command: see [New brand](#new-brand). Without a brand the CMS is empty, because SupaPIM only shows what a role is allowed to see via GRANT.
3. **MCP client**: in Claude, under *Settings → Connectors → Add custom connector*, enter the address `https://supabase.example.com/cms/mcp`. The CMS consent page opens; after that Claude works with that person's privileges.

## New brand

A brand is a Postgres schema. It only appears in the CMS once privileges, RLS policies, audit and the PostgREST exposure are in place. One command takes care of that; it is idempotent and can be repeated after every new table:

```bash
cms/install.sh brand acme --label "Acme Outdoor"      # with default tables
cms/install.sh brand mybrand --no-tables              # your own tables (e.g. created in Studio)
```

Options, privilege model, removal and the "brand does not appear" checklist: [`brand-bootstrap.md`](brand-bootstrap.md).

## What the installation changes in `.env` and in the services

You don't have to do any of this by hand; the table is a checklist in case you want to do it yourself or verify it.

**Values in `.env`**

| Value | Target | Why |
|---|---|---|
| `SUPABASE_PUBLIC_URL` | `https://supabase.example.com` | the one address for gateway, Auth, UI, MCP |
| `API_EXTERNAL_URL` | `<SUPABASE_PUBLIC_URL>/auth/v1` | issuer (`iss`) of the tokens; the MCP server checks it |
| `SITE_URL` | `<SUPABASE_PUBLIC_URL>` | for MCP sign-in, Auth opens `SITE_URL/oauth/consent` |
| `PGRST_DB_SCHEMAS` | `…,cms_api` (+ one entry per brand) | PostgREST serves `cms_api`; `cms` and `audit` stay internal |
| `JWT_KEYS`, `JWT_JWKS`, `SUPABASE_SECRET_KEY` | not empty | ES256 signing keys as in Cloud; SupaPIM needs a JWKS and, for the admin API, the secret key |
| `CMS_IMAGE` | `ghcr.io/hammerschmied-group/supapim:<version>` | the image |
| `CMS_REDIRECT_URLS` | default `<SUPABASE_PUBLIC_URL>/cms/**` | where mail links (invitation, magic link, password) may redirect back to |
| `CMS_ADMIN_INVITE_DELIVERY` | `mail` (default, keep it in production) or `link` | `mail`: Auth sends the invitation (SMTP required); `link`: the admin gets the link, for testing only |
| `CMS_JWT_EXPIRY`, `CMS_SESSION_TIMEBOX`, `CMS_SESSION_INACTIVITY` | 900 / 720h / 168h | token and session lifetime, see below |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_ADMIN_EMAIL`, `SMTP_SENDER_NAME` | your mail server | invitations, password reset, magic link |
| `COMPOSE_FILE` | `docker-compose.yml:cms/docker-compose.cms.yml:cms/docker-compose.envoy.yml` (Kong: `…kong.yml:cms/…cms.yml:cms/…kong.yml`) | Compose layering, as upstream intends |

**Supabase Auth settings** (set by `docker-compose.cms.yml` through environment variables of `auth`)

| Setting | Value | Purpose |
|---|---|---|
| `GOTRUE_JWT_KEYS` | `${JWT_KEYS}` | signing keys (ES256) |
| `GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED` / `_URI` | `true` / `pg-functions://postgres/cms/custom_access_token_hook` | **Custom access token hook**: sets the `role` claim from `cms.user_roles` |
| `GOTRUE_OAUTH_SERVER_ENABLED` | `true` | Supabase Auth as an **OAuth 2.1 server** for MCP clients |
| `GOTRUE_OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION` | `true` | clients register themselves (DCR), PKCE |
| `GOTRUE_OAUTH_SERVER_AUTHORIZATION_PATH` | `/oauth/consent` | consent page = `SITE_URL` + path; the gateway forwards it to the container |
| `GOTRUE_URI_ALLOW_LIST` | `${CMS_REDIRECT_URLS}` or `<SUPABASE_PUBLIC_URL>/cms/**` | redirect list for mail links |
| `GOTRUE_MFA_TOTP_ENROLL_ENABLED` / `_VERIFY_ENABLED` | `true` | authenticator app (TOTP) |
| `GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION` | `true` | An MCP client's token must not change the password without re-confirmation |
| `GOTRUE_JWT_EXP` | `${CMS_JWT_EXPIRY}`, default **900** (15 min) | Revoked privileges take effect after this time at the latest; 3600 locally |
| `GOTRUE_SESSIONS_TIMEBOX` / `_INACTIVITY_TIMEOUT` | `720h` / `168h` (`CMS_SESSION_TIMEBOX`, `CMS_SESSION_INACTIVITY`) | Sessions, and with them the MCP clients' refresh tokens, expire |

`realtime`, `storage` and `functions` receive `JWT_JWKS` so they can verify ES256 tokens. The image runs as **two services**: `cms` (UI, MCP, consent page) only gets the URLs and the anon key; `cms-admin` (`node admin.mjs`, the admin API under `/cms/api/admin/*`) is the **only** service with the secret key. An MCP call never reaches this process. No service gets a database password or the JWT secret. `scripts/check-no-service-key.sh` in the repo verifies this.

**Gateway.** Both wrappers insert the same routes, all without an API key (the container and Auth protect themselves):

| Route | Target | Why open |
|---|---|---|
| `/auth/v1/oauth/` | Auth | Upstream only opens the discovery routes; registration, token and authorize require an API key there, which MCP clients don't send. Auth protects the endpoints itself (client auth + PKCE, rate limit, user JWT). The rest of `/auth/v1/` stays protected. |
| `/cms` | `cms` | UI (`/cms/`, `/cms/config.json`) |
| `/cms/api/admin` | `cms-admin` | Admin API; checks token and database role itself |
| `/storage/v1/object/` | Storage | as upstream, but every response carries `Content-Security-Policy: default-src 'none'; sandbox` and `X-Content-Type-Options: nosniff`: an uploaded SVG must not run a script in the UI's origin |
| `/cms/mcp` | Container | MCP, Streamable HTTP (timeout 120 s). The bearer token is checked in the server. |
| `/oauth/consent` | Container | Consent page; redirects to `/cms/#/consent` |
| `/.well-known/oauth-protected-resource[/cms/mcp]` | Container | RFC 9728 metadata, shows MCP clients the auth server |

`/mcp` stays with the Studio MCP; SupaPIM deliberately uses `/cms/mcp`.

## TLS and reverse proxy

The gateway speaks http on `API_GW_HTTP_PORT`; a TLS proxy belongs in front of it and must pass **all** SupaPIM paths. The upstream proxy (`docker-compose.caddy.yml`, `docker-compose.nginx.yml`) only forwards fixed paths to the gateway and sends everything else to Studio (basic auth). In that case `/cms` and the OAuth pages never arrive. Add the following (**untested**; `cms/install.sh check --url https://…` shows whether it works):

```text
# Caddy: volumes/proxy/caddy/Caddyfile, extend the @supabase_api matcher with these paths
@supabase_api path /auth/v1/* /rest/v1/* /graphql/v1 /realtime/v1/* /storage/v1/* /functions/v1/* /mcp /sso/* /.well-known/oauth-authorization-server/auth/v1 /cms /cms/* /oauth/consent /.well-known/oauth-protected-resource /.well-known/oauth-protected-resource/*
```

```text
# nginx: volumes/proxy/nginx/supabase-nginx.conf.tpl, one additional block next to the other location blocks
location ~ ^/(cms|oauth/consent|\.well-known/oauth-protected-resource) {
    proxy_pass http://api_gw_upstream;
    proxy_buffering off;          # MCP streams
    proxy_read_timeout 120s;
}
```

**HSTS:** The TLS proxy sets `Strict-Transport-Security: max-age=31536000` (Caddy: `header Strict-Transport-Security "max-age=31536000"`, nginx: `add_header Strict-Transport-Security "max-age=31536000" always;`); the gateway does not.

Your own proxy (Traefik, Cloudflare Tunnel, …): forward everything under the same address to the gateway, with **no** path filter in front of `/cms`, `/oauth/consent` and `/.well-known/`.

## Verifying and troubleshooting

```bash
cms/install.sh check          # can be repeated at any time
docker compose logs cms       # MCP and admin API requests (JSON, no tokens)
```

| Message | Cause and fix |
|---|---|
| `JWT_KEYS is empty …` on `docker compose` | `sh utils/add-new-auth-keys.sh --update-env` or `install.sh env --generate-keys` |
| `check`: *OAuth routes open without apikey → 401* | The gateway is still running without the package files. `docker compose config \| grep -c cms-gateway` must be > 0; check `COMPOSE_FILE`, then `docker compose up -d api-gw` |
| `check`: *protected-resource metadata does not name …/auth/v1* | `SUPABASE_PUBLIC_URL`/`API_EXTERNAL_URL` don't match (`API_EXTERNAL_URL` = `SUPABASE_PUBLIC_URL` + `/auth/v1`); then `docker compose up -d` |
| `check`: *no registration_endpoint* | `auth` is running without the OAuth settings: `docker compose up -d auth` |
| `check`: *cms_api … (404/406)* | `PGRST_DB_SCHEMAS` lacks `cms_api` or PostgREST wasn't restarted: `docker compose up -d rest` |
| Sign-in fails after installation ("Error running hook") | The migration is missing: `cms/install.sh sql`. Never enable the hook without the function (see [`upgrade.md`](upgrade.md), uninstalling). |
| Claude: "Connection failed" | `SUPABASE_PUBLIC_URL` must be reachable from outside over **https**; `cms/install.sh check --url https://…` |
| Invitation doesn't arrive | Check SMTP (`docker compose logs auth`); until then use `CMS_ADMIN_INVITE_DELIVERY=link` |
| `install.sql failed` with *must be owner of schema cms* | `cms` belongs to a different role (leftover). Clean up or recreate it as `supabase_admin`; nothing happens silently. |
| Brand missing in the CMS | [`brand-bootstrap.md`](brand-bootstrap.md), checklist |

## File storage

Files (image uploads) live in the storage API's volume by default. Hetzner Object Storage or any other S3 works without changes to SupaPIM: [`storage-s3.md`](storage-s3.md).

## Updates and uninstalling

[`upgrade.md`](upgrade.md). In short: unpack the new package, `cms/install.sh sql`, `docker compose up -d`. Before uninstalling, **disable the hook first**, otherwise every sign-in fails.

## Timing measurement

Measured on 29 Oct 2026 with `scripts/test-package.sh` on a fresh upstream stack `self-hosted/v0.8.3` (a laptop running Docker Desktop, upstream images already local; the archive unpacked as a user would, image loaded from the archive, Postgres 17):

| | Envoy | Kong |
|---|---|---|
| Unpack archive and load image | 2 s | 2 s |
| `install.sh all`: SQL, `.env`, `docker compose up -d --wait`, first admin, 13 checks | 28 s | 26 s |
| **Total** | **30 s** | **28 s** |
| Tested afterwards: sign-in with role claim, admin API, new brand, end-to-end chain (130 checks) | green | green |

That is machine time. On top of it comes what a person has to do and the test doesn't time: fetching the archive, entering the address, TLS and DNS (if not already in place), SMTP, opening the link and choosing a password. Without TLS/DNS/SMTP work that is four commands. If the images first have to come from the network, add their download time (Kong: `kong/kong:3.9.3`; SupaPIM image: in the archive or from the registry).
