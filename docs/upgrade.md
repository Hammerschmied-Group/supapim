# Upgrade and uninstall

SupaPIM has two parts, each with its own version:

| Part | Where the version is | How it is updated |
|---|---|---|
| **Package and image** (container `cms`, Compose files, gateway wrapper) | `cms/VERSION`, the image tag (`ghcr.io/hammerschmied-group/supapim:<version>`), the label `org.opencontainers.image.version`, `GET /health` | Unpack the new package, load the image, `docker compose up -d` |
| **Database** (schemas `cms`, `cms_api`, `audit`) | `select max(version) from cms.schema_version` | Run `install.sql` again |

`install.sql` is **idempotent and versioned**: every step can be repeated, and a later step that cannot is guarded by the version in `cms.schema_version`. Running it twice changes nothing (the test `scripts/test-sql.sh` compares the catalog to verify this). The migration is **additive**: it does not delete or change any data or any privileges on your tables.

## Upgrade SupaPIM (self-hosted)

Order: database first, then the container. An old image keeps running with the new migration; the other way round, a new image may expect functions that are still missing.

```bash
# in the Supabase docker/ directory
cp .env .env.bak                                                 # back up your settings
tar -xzf supapim-selfhosted-<new>.tar.gz                    # replaces ./cms/ (your .env is left untouched)
docker load -i cms/image/supapim-<new>.oci.tar              # or: set CMS_IMAGE to the new registry version
sed -i.bak 's|^CMS_IMAGE=.*|CMS_IMAGE=ghcr.io/hammerschmied-group/supapim:<new>|' .env  # if CMS_IMAGE points to the old version
cms/install.sh sql                                               # migration, shows the schema version
docker compose up -d --wait                                      # only recreates services whose configuration changes
cms/install.sh check
```

Then check the package's **release notes** for new `.env` values (`cms/env.example` lists all of them).

**Rolling back:** put the old image and the old package back and run `docker compose up -d`. The database stays as it is (additive); the old version ignores what it does not know.

## Upgrade Supabase itself

For the gateway, the package replaces the **list of volumes** of `api-gw` (Envoy), or the volumes and entrypoint (Kong), so that the wrapper runs before the upstream entrypoint. If upstream changes these files or paths, you notice at startup:

1. Apply the new upstream version as described in the Supabase docs (`utils/upgrade` or a `git` update of the `docker/` directory). `.env` and `cms/` stay.
2. `docker compose config > /dev/null` must run without errors; then `docker compose up -d --wait` and `cms/install.sh check`.
3. The Kong wrapper aborts with a clear message if `kong-entrypoint.sh` no longer reads the path `/home/kong/temp.yml`; the Envoy wrapper aborts if the anchor `auth-v1-protected` or `auth-v1-oauth-server` is missing from `lds.template.yaml`. In that case, check [`compatibility.md`](compatibility.md) for a matching package version.

Approved combinations are listed in [`compatibility.md`](compatibility.md). Newer Supabase versions without an entry there are **not** tested.

## Uninstall

**Order matters: disable the hook first, then clean up the database.** On every sign-in, the Custom Access Token Hook calls `cms.custom_access_token_hook`. If the function is gone but the hook is still registered, **every** sign-in fails, including those of all other users of the project.

```bash
# 1. Remove the package from COMPOSE_FILE and drop cms_api from PGRST_DB_SCHEMAS (in .env).
#    This turns off the hook, the OAuth server, the TOTP addition and the gateway routes, and removes the container
cp .env .env.bak
#    COMPOSE_FILE=docker-compose.yml            (without the cms/… entries)
#    PGRST_DB_SCHEMAS=public,graphql_public,…   (without cms_api)
docker compose up -d --wait --remove-orphans
# 2. Only now the database (the switch `cms.hook_disabled` provides the confirmation).
#    uninstall.sql refuses to run until it is confirmed in the same session that the hook is off:
(echo "set cms.hook_disabled = on;"; cat cms/sql/uninstall.sql) | docker compose exec -T db psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d postgres
#    Keep the log:  (echo "set cms.hook_disabled = on; set cms.keep_audit_log = on;"; cat cms/sql/uninstall.sql) | …
```

This removes `cms`, `cms_api`, all audit triggers, all policies with the prefix `rbac: ` and (without `keep_audit_log`) `audit`. It does **not** touch your tables, roles and GRANTs, the brand schemas, the `fix_public_defaults()` hardening, or the roles `cms_admin` and `agency_*`. If you no longer need them, remove them with SQL ([`brand-bootstrap.md`](brand-bootstrap.md), "Removing a brand"). Reverting the hardening (anon back in `public`) would be a security regression and never happens automatically.

The ES256 key (`JWT_KEYS`) stays in `.env`. Without `GOTRUE_JWT_KEYS`, Auth signs with the legacy secret (HS256) again: existing sessions are reissued on the next refresh, and older ES256 tokens expire.

## Supabase Cloud

Update: load or pull the new image, `docker compose up -d`; run `install.sql` again in the SQL editor. Uninstall: first **disable the hook in the dashboard** (Authentication → Hooks), turn off the OAuth server (Authentication → OAuth Server), remove `cms_api` from "Exposed schemas", then run `set cms.hook_disabled = on;` and `uninstall.sql` in the same session, then stop the container. Details: [`install-cloud.md`](install-cloud.md).
