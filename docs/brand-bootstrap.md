# Add a new brand (brand bootstrap)

In SupaPIM, a brand is its own Postgres schema, for example `nordwind`, `suedwind` or `acme`.

A schema you only create in Studio **does not show up in the CMS.** That is not a bug. SupaPIM has no permission model of its own: the CMS shows a person only what their Postgres role may do through GRANT and RLS, and only schemas that PostgREST serves. A new schema has neither yet.

The script `scripts/brand-bootstrap.sh` does all of it in one step. It is **reusable and idempotent**: use it for every new brand, and run it again for the same brand as often as you like, for example after you add more tables in Studio. It never deletes anything.

## With the self-hosted package

If you installed SupaPIM from the package ([`install-selfhosted.md`](install-selfhosted.md)), you do not need the repo. In the Supabase `docker/` directory, this does the same:

```bash
cms/install.sh brand acme --label "Acme Outdoor"
cms/install.sh brand mybrand --no-tables
```

It takes the same options (`--no-agency`, `--bucket`, `--no-bucket`, `--no-settings`). It runs `cms/sql/brand-bootstrap.sql`, adds the schema to `PGRST_DB_SCHEMAS`, recreates `rest` and `studio`, restarts the gateway (it would otherwise keep using the old address of the recreated container for up to 25 seconds) and checks that PostgREST serves the schema. The rest of this page applies unchanged.

## Quick start (local stack in the repo)

**New brand with the default tables** (`products`, `product_images`, `faq`):

```bash
scripts/brand-bootstrap.sh acme --label "Acme Outdoor"
```

**Brand with your own tables**, for example created in Studio:

```bash
scripts/brand-bootstrap.sh mybrand --no-tables
```

Then **sign in again** in the CMS (http://localhost:55380/cms/). The menu is built from `cms_api.describe()` at login.

## What the script does

| Step | Result |
|---|---|
| 1. Schema | Created if missing (owner `postgres`); `--label` becomes the schema comment. Also the type `currency_code` (ISO 4217 codes, a dropdown in the CMS). |
| 1b. Settings | Only without `--no-settings`: table `settings` with exactly one row (see below), the first menu item of the brand in the CMS. |
| 2. Default tables | Only without `--no-tables`: `products`, `product_images` (image column with alt text and title) and `faq`, all with RLS. Missing tables are added, existing ones stay unchanged. Exception: `products.currency` as `text` is converted to `currency_code` (the values must be codes of that type), and without a value the default currency from the settings applies. |
| 3. Admin roles | Every role in `cms.settings.admin_roles` (demo: `cms_admin`) may read and write all tables, but no DDL. An RLS policy is added too. This also covers tables you add later in Studio. |
| 4. Agency role | Only without `--no-agency`: `agency_<schema>` may read everything, but change **only** `products.name` and `product_images.alt_text` and `title_attr`, as far as those columns exist. It may read the brand's own image folder `<schema>/` in the bucket. PostgREST may switch to this role. |
| 5. Audit | The schema is added to `cms.settings.audit_schemas`. Every table gets the audit trigger, so every change lands in `audit.change_log` together with the person's email. |
| 6. Exposure | The schema is added to `PGRST_DB_SCHEMAS` in `.env`; `rest` and `studio` restart. Before that, the script creates a backup `.env.bak.brand-<time>`. |
| 7. Check | PostgREST serves the schema (HTTP 200), and the admin role sees the tables in `describe()`. |

Options:

| Option | Effect |
|---|---|
| `--label "…"` | Display name, stored as the schema comment |
| `--no-tables` | Does not create default tables; permissions, audit and exposure apply to all existing tables |
| `--no-agency` | Does not create an agency role |
| `--bucket <name>` / `--no-bucket` | Bucket for the image column, logo and agency folder (default: `images`) |
| `--no-settings` | Does not create settings; `products.currency` then has the fixed default `EUR` |

## Brand settings

`<schema>.settings` has exactly one row (`id = 1`, enforced by a check). The CMS recognizes the table by the comment `@cms(singleton)`: the "Settings" menu item opens this row directly, with no list and no delete.

| Column | Content |
|---|---|
| `display_name` | Brand name as customers see it (initial value: `--label`) |
| `website_url` | Shop URL, must start with `http://` or `https://` |
| `contact_email` | Address for customer questions |
| `default_currency` | Currency for new products without an explicit value (default `EUR`) |
| `default_locale` | Language and region of the content (dropdown, type `<schema>.locale_code`: `de-DE`, `de-AT`, `de-CH`, `en-GB`, `en-US`, `fr-FR` …) |
| `seo_title_suffix`, `seo_description` | SEO defaults for pages without their own values |
| `logo_path`, `logo_alt` | Logo in the bucket (folder `<schema>/`) with alt text |

- `products.currency` defaults to `<schema>.default_currency()`: if you pick no currency when creating a product ("Default (if empty)"), it gets the one from the settings. The function runs as its owner so that roles without read access to the settings can use it; it only returns the currency code.
- Permissions work as for any table: admin roles read and change, the agency only reads. A GRANT allows more, e.g. `grant update (seo_description) on acme.settings to agency_acme;`.
- **Another currency or locale:** `alter type acme.currency_code add value 'JPY';` or `alter type acme.locale_code add value 'pt-PT';`, then sign in again in the CMS.
- Custom fields: add a column in Studio and it appears on the settings page. You can get your own singleton table with `comment on table … is '@cms(singleton)'` and a single-column primary key.

## Next steps

- **Assign people:** CMS → Admin → People. Invite them there and assign the role `agency_<schema>` or `cms_admin`. The new role applies from the next login or the next token.
- **Images:** put them in the bucket `images` under the folder `<schema>/`. The agency sees only that folder. The bucket `images` is public: anyone who knows the path can fetch any image. Internal files belong in a private bucket.
- **More tables:** create them in Studio and run the script again. The admin roles already have access to new tables through default privileges, but the RLS policy, the agency's read access and audit only arrive with the next run.
- **Let the agency change more columns:** this is a normal GRANT, for example:

  ```sql
  grant update (description) on acme.products to agency_acme;
  ```

  The CMS then shows the field as editable, and the MCP server allows the change. The RLS policy for UPDATE already exists.

## One agency for several brands

An access token carries exactly one Postgres role. An agency that works for several brands therefore gets **its own role `agency_<name>`, which is a member of the agency roles of its brands** (`agency_nordwind`, `agency_suedwind` …). Postgres passes on their privileges: table and column privileges, RLS policies and read access to the image folders. In each brand the agency may do exactly what that brand's agency role may do, and nothing else. There is no separate permission model for this.

```bash
scripts/agency.sh northstar --label "Northstar Agency" --brand nordwind --brand suedwind
scripts/agency.sh northstar --brand acme                         # add a brand later
scripts/agency.sh northstar --remove-brand suedwind              # take a brand away
```

In the self-hosted package: `cms/install.sh agency northstar --label "Northstar Agency" --brand nordwind --brand suedwind`. Without the script (Cloud, Studio): run [`scripts/sql/agency.sql`](../scripts/sql/agency.sql) with the four placeholders `:'name'`, `:'label'`, `:'brands'` (comma-separated), `:'remove'`.

- Each brand needs its agency role from the brand bootstrap first (that is, without `--no-agency`).
- The name must not be a brand's name: `agency_nordwind` is already the role of the brand Nordwind.
- **Assign people:** Admin → People → role `agency_northstar`. In the CMS, all of the agency's brands then appear as separate groups in the menu, and the MCP server works with all of them too. Added or removed brands take effect from the person's next token.
- **More permissions in one brand** go to that brand's role, as before (`grant update (description) on nordwind.products to agency_nordwind;`). This then applies to every agency that has this brand. If only one agency should get more, give the GRANT to its own role (`… to agency_northstar`); if the table has no RLS policy for UPDATE for the brand's agency role yet, it needs one.
- **Remove:** assign people a different role, then `drop role agency_northstar;`.
- The demo has the agency `agency_northstar` for Nordwind and Südwind.

## Supabase Cloud or without the script

The SQL is in [`scripts/sql/brand-bootstrap.sql`](../scripts/sql/brand-bootstrap.sql) and also runs in Studio's SQL editor:

1. At the top of the file, replace the six placeholders `:'schema'`, `:'label'`, `:'tables'`, `:'agency'`, `:'bucket'`, `:'settings'` with values, for example `'acme'`, `'Acme Outdoor'`, `'template'`, `'yes'`, `'images'`, `'yes'`.
2. Run the whole file (Cloud: as `postgres`, which is the default in the SQL editor).
3. Expose the schema: **Settings → API → Exposed schemas**. Self-hosted, that is `PGRST_DB_SCHEMAS`; restart the container `rest` afterwards.

## Removing a brand

This works only in SQL and only on purpose, because it deletes the brand's data:

```sql
begin;
update cms.settings set audit_schemas = array_remove(audit_schemas, 'acme'), updated_at = now();
drop schema acme cascade;          -- tables, policies, triggers, default privileges
-- Agency role (remove assignments first; storage policies depend on the role):
delete from cms.user_roles where db_role = 'agency_acme';
drop policy if exists "rbac: agency_acme select" on storage.objects;
drop policy if exists "rbac: agency_acme select" on storage.buckets;
revoke all on storage.objects, storage.buckets from agency_acme;
revoke usage on schema storage from agency_acme;
drop role agency_acme;
commit;
```

Afterwards, remove the schema from `PGRST_DB_SCHEMAS` or "Exposed schemas" and restart `rest`. Entries in `audit.change_log` are kept.

## When a brand does not show up in the CMS

| Check | SQL / command | Fix |
|---|---|---|
| Does the schema have tables? | `select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where nspname = '<schema>';` | Create tables or run the script without `--no-tables` |
| Does the role have privileges? | `select has_schema_privilege('cms_admin', '<schema>', 'USAGE');` | Run the script |
| RLS on, but no policy? | `select * from pg_policies where schemaname = '<schema>';` | Run the script (Studio enables RLS on new tables, and without a policy nobody sees a row) |
| Does PostgREST serve the schema? | `grep PGRST_DB_SCHEMAS .env` | Run the script, or "Exposed schemas" |
| Still the old session? | – | Sign out of the CMS and back in |

## Notes on the local demo stack

- `scripts/reset.sh` resets only Nordwind, Südwind and the test users. A brand created with the script keeps its data, privileges and audit trail.
- `scripts/reset.sh --wipe` deletes the whole database. Afterwards, run the script again for each of your own brands. The entry in `.env` stays; PostgREST only starts once the schema exists, so `scripts/start.sh` creates empty schemas for all entries.
