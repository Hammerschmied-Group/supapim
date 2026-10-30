# SupaPIM

**A schema-first CMS / PIM and a remote MCP server for Supabase, where every person — and every AI agent acting for them — works with exactly their own Postgres rights.**

SupaPIM reads your database schema and builds an editing interface from it: lists, forms, image galleries, drag-and-drop ordering, a settings page per brand and a change history. The same rights also drive an MCP server, so Claude, ChatGPT or Cursor can read and edit your content on a person's behalf, and never more than that person may.

There is one identity (Supabase Auth) and one rights system (Postgres `GRANT`s, column grants and row-level security). SupaPIM adds no permission model of its own.

Made by [AutomateThis!](https://automatethis.pro) · Free to use · [Licence](#licence)

> SupaPIM is not affiliated with, endorsed by, or sponsored by Supabase Inc.

---

## Features

**Content and product data**
- The UI is generated from your schema (via `cms_api.describe()`): every table the person may read appears, every column they may change is editable, everything else is read-only.
- One Postgres schema per brand (e.g. `nordwind`, `suedwind`), each with its own menu group.
- Brand settings page (display name, website, contact, default currency and locale, SEO defaults, logo), with currency and locale as dropdowns.
- Images and files from Supabase Storage: upload, replace, rename (every row using the file follows), pick an existing file, alt text and title, galleries with several images per product, a list of files no record uses.
- Drag-and-drop ordering in lists, enums as dropdowns, Markdown and HTML fields, references between tables in both directions.
- Hints in Postgres comments (`@cms(image, bucket=images)`, `@cms(readonly)`, `@cms(label=…)`, `@cms(singleton)` …), editable in SQL or Studio.
- Change history per record from a generic audit log, with the person's e-mail and the OAuth client.
- English and German UI, light and dark theme.

**Rights**
- People are mapped to Postgres group roles (e.g. `cms_admin`, `agency_nordwind`). A Custom Access Token Hook puts that role into the access token; PostgREST and Storage switch into it.
- Column grants decide which fields are editable, RLS decides which rows are visible, storage policies decide which files.
- An agency can work for several brands through one role that is a member of the brand roles.
- Admin area: invite people, assign roles, see the effective rights of each role, MFA (TOTP).

**MCP server for AI agents**
- Remote MCP server (Streamable HTTP) at `/cms/mcp`. Supabase Auth is the OAuth 2.1 authorization server, with dynamic client registration and a consent page in the UI.
- The server checks the person's token and passes **the same token** to PostgREST and the Storage API. It has no service key, no database access and no signing key.
- Tools: `whoami`, `list_tables`, `select_rows`, `insert_rows`, `update_rows`, `delete_rows`, `call_function` (e.g. vector search), `list_files`, `upload_file`, `download_file`, `create_signed_url`.
- Refusals are explained: *"Role `agency_nordwind` may not change column `price` in `nordwind.products`. Allowed to update: `name`."*
- Rate limit per person and an access log without data values or tokens.

## How it works

```
Person / AI agent ──▶ Supabase Auth (login or OAuth 2.1) ──▶ access token { role: agency_nordwind, email, … }
        │
        ├─ SupaPIM UI (/cms) ─────────┐
        └─ MCP server (/cms/mcp) ─────┴─▶ PostgREST / Storage API with the SAME token
                                              └─▶ SET ROLE agency_nordwind
                                                    → GRANT, column GRANT and RLS decide
                                                    → audit trigger records the e-mail and client
```

SupaPIM ships as one container image (UI, MCP server and consent page; the admin API runs from the same image as a separate service, the only one with the secret key) and one idempotent SQL migration (schemas `cms`, `cms_api`, `audit`). It plugs into an existing Supabase stack without changing Supabase's own files.

## Requirements

- Supabase self-hosted (`self-hosted/v0.8.x`, Envoy or Kong gateway) or Supabase Cloud (prepared, see the Cloud guide)
- Postgres 15 or 17
- Supabase Auth with the OAuth 2.1 server enabled, ES256 signing keys

Details: [compatibility](docs/compatibility.md).

## Install

| | Guide |
|---|---|
| Self-hosted Supabase | [docs/install-selfhosted.md](docs/install-selfhosted.md): unpack the package into your Supabase `docker/` directory and run `cms/install.sh all <admin-email>` |
| Supabase Cloud | [docs/install-cloud.md](docs/install-cloud.md): run the container on any Docker host next to your Cloud project |
| Add a brand | [docs/brand-bootstrap.md](docs/brand-bootstrap.md): `install.sh brand acme --label "Acme Outdoor"` |
| Upgrade / uninstall | [docs/upgrade.md](docs/upgrade.md) |
| Image storage on S3 | [docs/storage-s3.md](docs/storage-s3.md) |

The image is published as `ghcr.io/hammerschmied-group/supapim`.

## Connect an AI client

Add `https://<your-supabase-host>/cms/mcp` as a remote MCP server:

- **Claude Code:** `claude mcp add --transport http supapim https://<your-supabase-host>/cms/mcp`, then `/mcp` → Authenticate.
- **claude.ai / Claude Desktop:** Settings → Connectors → Add custom connector.
- **ChatGPT:** Settings → Connectors → Create (developer mode).

The client registers itself, you sign in with your Supabase account and approve it on the consent page. From then on the agent works with your role.

Configuration of the MCP server (container environment):

| Variable | Meaning | Default |
|---|---|---|
| `SUPABASE_URL` | where the server reaches Supabase (gateway; Cloud: `https://<ref>.supabase.co`) | `SUPABASE_PUBLIC_URL` |
| `SUPABASE_PUBLIC_URL` | what browsers and clients see | – |
| `PUBLIC_BASE_URL` | host under which `/cms/mcp` is public (base of the protected resource metadata) | `SUPABASE_PUBLIC_URL` |
| `AUTH_ISSUER` | expected `iss` | `<SUPABASE_PUBLIC_URL>/auth/v1` |
| `SUPABASE_ANON_KEY` | public key for the gateway | – |
| `MCP_RATE_BURST`, `MCP_RATE_PER_MINUTE` | rate limit per person | 60, 120 |
| `MCP_MAX_UPLOAD_BYTES` | upload limit | 5 MiB |

## Local development

Requirements: Docker Desktop, Node ≥ 22, `git`, `openssl`.

```bash
scripts/start.sh            # first run: fetch the upstream stack, create .env with fresh local secrets, start, seed the demo
scripts/test.sh             # SQL, server, MCP chain, storage, security and UI (unit + Playwright) tests against the running stack
scripts/test-sql.sh         # the SQL migration in throwaway containers, Postgres 17 and 15 (no stack needed)
scripts/brand-bootstrap.sh <schema>              # set up a brand (repeatable)
scripts/agency.sh <name> --brand a --brand b     # one agency for several brands
scripts/reset.sh            # demo back to its seed state (~10 s); --wipe rebuilds everything
scripts/stop.sh             # stop, keep data
```

| Service | URL |
|---|---|
| SupaPIM UI | http://localhost:55321/cms/ (dev server: `npm run dev` in `apps/ui`, http://localhost:55390/cms/) |
| MCP server | http://localhost:55321/cms/mcp |
| Supabase gateway and Studio | http://localhost:55321 |
| Mailpit (invitations, magic links) | http://localhost:55326 |

Demo users (password: `TEST_USER_PASSWORD` in your local `.env`):

| E-mail | Role | May |
|---|---|---|
| `admin@example.com` | `cms_admin` | edit both demo brands and the documents, manage people |
| `agentur.nordwind@example.com` | `agency_nordwind` | read Nordwind, change product names and image texts |
| `agentur.suedwind@example.com` | `agency_suedwind` | the same for Südwind |
| `hr@example.com` | `hr_editor` | read HR documents, manage the `hr-files` bucket |
| `ohne.rolle@example.com` | – | nothing |

The demo also has the agency role `agency_northstar` for both brands.

## Project layout

```
packages/sql/install.sql      the migration (schemas cms, cms_api, audit); idempotent and versioned, run as postgres
packages/sql/uninstall.sql    uninstaller (optionally keeps the audit log)
apps/server/                  Express: MCP server (src/mcp), admin API (src/admin, admin.mjs), UI delivery (src/ui)
apps/ui/                      the UI: react-admin + Vite, generated from describe(); see apps/ui/ARCHITECTURE.md
deploy/selfhosted/            the self-hosted package: compose files, Envoy/Kong gateway wrappers, install.sh
deploy/cloud/                 the Cloud variant: container (+ optional Caddy), check.sh, first-admin.sql
scripts/                      local stack, demo, brand and agency tools, tests, image and package builds
demo/                         demo brands, roles, data and files
docs/                         install, upgrade, compatibility, brands, storage, security
```

## Security

The security model, the findings of the security review and an operator checklist are in [docs/security/](docs/security/threat-model.md). Please report vulnerabilities privately via [automatethis.pro](https://automatethis.pro), not as a public issue.

## Licence

SupaPIM is **free to use** and **source-available** under the [Business Source License 1.1](LICENSE) with an additional use grant: you may use and self-host it in production for your own organisation and brands, free of charge. Offering it as a hosted service to others, reselling or white-labelling it, and removing the "Made by AutomateThis!" notice need a separate agreement. Each version becomes Apache-2.0 four years after its release. Plain-English summary: [LICENSING.md](LICENSING.md).

Need help with installation, custom fields or a full PIM/CMS setup? [AutomateThis!](https://automatethis.pro) builds it for you.
