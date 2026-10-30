# Installation: Supabase Cloud

> **Status: not tested against a real Cloud project.** The package is prepared for Cloud (container, SQL, check script), and the steps below follow the Supabase documentation. Two things need to be verified against a real project before you rely on Cloud; they are listed in [Open items: check before using Cloud in production](#open-items-check-before-using-cloud-in-production). `deploy/cloud/check.sh` runs this check in a minute without creating anything.

With Supabase Cloud, the project runs at supabase.com. SupaPIM there consists of **one SQL migration** (in the SQL editor) and **one container** that runs **externally** (any Docker host with a public https address, e.g. a small server) and talks to the project like any client: over the public project URL, with the public key and the signed-in person's token. It needs no internal network, no database password and no JWT secret. Introspection runs through `cms_api.describe()` instead of the OpenAPI.

Goal: under 15 minutes. Self-hosted: [`install-selfhosted.md`](install-selfhosted.md).

## Requirements

| | |
|---|---|
| Project | Supabase Cloud project, Postgres 15 or 17. Free is enough for trying it out (auth hook, OAuth server and TOTP are available on all plans according to the documentation; Free projects pause). |
| Server | A Docker host with Compose, publicly reachable under its own domain (`cms.example.com`), ports 80/443. The package optionally ships Caddy (automatic certificate). Claude and ChatGPT only connect over **https**. |
| Mail | Your own SMTP server in the project (Authentication → Emails → SMTP). The built-in mailer only sends a handful of emails per hour and only to team members; that isn't enough for invitations. |
| Keys | Settings → API Keys: **Publishable key** (`sb_publishable_…`) and **Secret key** (`sb_secret_…`, only for the admin API) |

## Installation

Unpack the package `supapim-cloud-<version>.tar.gz` (`./supapim-cloud/`).

### 1. Database (SQL editor, 1 minute)

1. Dashboard → **SQL Editor** → paste the contents of `sql/install.sql` → run (runs as `postgres`, idempotent, changes no privileges on your tables). Expected: `Success`.
2. `select max(version) from cms.schema_version;` → the schema version (currently 6).

### 2. Auth settings in the dashboard (4 minutes)

Keep the order: **SQL first**, then the hook, otherwise sign-ins fail.

| Where | Setting |
|---|---|
| **Settings → API → Exposed schemas** | Add `cms_api` (and later one schema per brand). **Not** `cms` and `audit`. |
| **Authentication → Hooks → Customize Access Token (JWT) Claims** | Postgres function, schema `cms`, function `custom_access_token_hook`. Result: `pg-functions://postgres/cms/custom_access_token_hook` |
| **Authentication → OAuth Server** | Turn it on; turn on **Allow dynamic OAuth apps** (dynamic client registration); **Authorization Path** `/oauth/consent` |
| **Authentication → URL Configuration** | **Site URL** = the container's address, exactly `https://cms.example.com`, because the consent page is Site URL + Authorization Path. **Redirect URLs**: `https://cms.example.com/cms/**` |
| **Authentication → Signing Keys** | An **asymmetric** key (ES256/RS256) must be active, otherwise there is no JWKS the server can verify tokens against. A project with only the legacy secret (HS256) is migrated here. `deploy/cloud/check.sh` shows what the project publishes. |
| **Authentication → Sign In / Providers** | **Multi-Factor (TOTP)** is on by default. Email + password is enough for the UI; if you use an authenticator app, set it up in the UI under "Security". |
| **Authentication → Emails → SMTP** | your own SMTP server |
| **Authentication → Sessions / JWT expiry** | Recommendation as for the self-hosted package: access token 900 s, sessions 30 days (timebox) and 7 days of inactivity (configurable depending on plan); password change only after re-authentication (security setting) |

> **Note on the Site URL.** A project has exactly **one** Site URL. Here it is the address of the SupaPIM container. If other applications on the same project use the Site URL (the default target of mail links), they must specify their targets through "Redirect URLs" and `redirectTo`. SupaPIM itself passes `redirectTo` for all its links.

The same can be done through the Management API (fields `hook_custom_access_token_*`, `oauth_server_*`, `site_url`, `uri_allow_list`, exposed schemas via `PATCH /v1/projects/{ref}/postgrest`). A script for that belongs in your own automation and is not part of v1.

### 3. Start the container (3 minutes)

```bash
cd supapim-cloud
docker load -i image/supapim-<version>.oci.tar     # or set CMS_IMAGE=ghcr.io/hammerschmied-group/supapim:<version>
cp env.example .env                                     # fill in: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, CMS_PUBLIC_URL (+ CMS_DOMAIN)
docker compose --profile caddy up -d                    # with Caddy (also sets HSTS); without --profile: container only, you provide TLS yourself
# Inviting from the CMS (admin API, separate container with the secret key):  docker compose --profile caddy --profile admin up -d
```

The DNS record for `cms.example.com` must point to the server beforehand (Caddy fetches the certificate itself). Your own proxy: forward everything under the address to port 8080 of the container; MCP streams (no buffering, timeout ≥ 120 s). The container itself serves `/cms`, `/cms/mcp`, `/cms/api/admin/*`, `/oauth/consent` and `/.well-known/oauth-protected-resource`; a gateway route as in the self-hosted stack is **not** needed.

| Variable | Meaning |
|---|---|
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | public key; it appears in every web page of a Supabase app |
| `SUPABASE_SECRET_KEY` | only for the separate `cms-admin` container (profile `admin`: invite, block). Without this profile the CMS runs without the admin API, and you invite people in the dashboard. The container checks token **and** database role first. |
| `CMS_PUBLIC_URL` | address of the container (`https://cms.example.com`) = the project's Site URL |
| `CMS_DOMAIN` | only for Caddy |
| `CMS_ADMIN_INVITE_DELIVERY` | `mail` (default) or `link` |

### 4. First admin (2 minutes)

1. Dashboard → **Authentication → Users → Add user** → email and password, "Auto confirm user" on.
2. SQL editor → `sql/first-admin.sql`, adjust the email line (`<<< EDIT`), run. This creates the role `cms_admin` and assigns it to the person.
3. Open `https://cms.example.com/cms/` and sign in. Add more people under **Admin → People**.

### 5. Verify

```bash
./check.sh https://<ref>.supabase.co https://cms.example.com
```

The script creates nothing and prints no keys. It checks the OAuth server metadata document, the JWKS, the **three OAuth endpoints without API key**, `cms_api` in PostgREST and the container.

### 6. New brand

The brand's schema needs privileges, RLS, audit and exposure. In the SQL editor, open `sql/brand-bootstrap.sql`, replace the six placeholders in the first statement (for example `'acme'`, `'Acme Outdoor'`, `'template'`, `'yes'`, `'images'`, `'yes'`), run everything, then add the schema under **Settings → API → Exposed schemas**. Everything about this and the "brand does not appear" checklist: [`brand-bootstrap.md`](brand-bootstrap.md#supabase-cloud-or-without-the-script).

### 7. Connect MCP

In Claude, under *Settings → Connectors → Add custom connector*: `https://cms.example.com/cms/mcp`.

## File storage

On Cloud, the project has its own storage; the backend can't be swapped. SupaPIM only uses the storage API.

## Open items: check before using Cloud in production

The Supabase documentation doesn't mention these points, or not clearly. A test against a real project settles them; `check.sh` covers 1 to 3.

1. **Are `/auth/v1/oauth/clients/register`, `/token` and `/authorize` reachable without `apikey`?** MCP clients don't send one. On the self-hosted gateway they are not open upstream, which is why the package ships an open route there. The Cloud gateway isn't publicly documented; a `400` response (Auth rejected the empty call) means open, `401 No API key found` means blocked. **If blocked:** MCP clients can't register directly with the project. Cloud is then limited to the UI, or the container would have to act as an auth proxy in front (not built; it would replace the auth server's metadata).
2. **Which signing keys does the project have?** New and migrated projects use asymmetric keys with a JWKS; older ones only have the legacy secret (HS256) and must migrate.
3. **Does the hook run for OAuth tokens?** Self-hosted: yes (GoTrue v2.197.0, tested). For Cloud, the documentation says hooks run on every token issuance. To check: obtain an OAuth token and look at the `role` claim (`cms_api.whoami()` with the token).
4. **PostgREST version** (Settings → General): `max-affected` applies from 13; older projects have no such limit for agents' write access.
5. **One Site URL per project** (see above): if you have several frontends on the project, check the mail links of all of them.
6. **The OAuth server's beta status.** According to the documentation it is in public beta on all plans (as of the research; no GA announcement was found). Check again before relying on it in production on Cloud.

## Update and uninstall

[`upgrade.md`](upgrade.md). Before uninstalling, **disable the hook in the dashboard**.
