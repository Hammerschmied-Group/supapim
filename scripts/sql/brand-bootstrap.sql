-- Brand bootstrap: make one brand schema usable in the CMS and over MCP. Idempotent — run it as
-- often as you like, for a new brand or again after adding tables to an existing one.
-- Normally run by scripts/brand-bootstrap.sh (which also exposes the schema in PostgREST).
--
-- Without the script (Studio SQL editor, Supabase Cloud): replace the five values in the first
-- statement below, run the whole file as postgres (Cloud) or supabase_admin (self-hosted), then
-- add the schema to "Exposed schemas" (Cloud: Settings → API) / PGRST_DB_SCHEMAS (self-hosted).
--
-- What it does (only what is missing; nothing is dropped):
--   1. schema (+ comment); the currency type (ISO 4217 codes: the dropdown in the CMS); with settings=yes the
--      brand's settings, one row (display name, website, contact, default currency and locale, SEO defaults,
--      logo: a "Settings" page in the CMS); with tables=template the standard brand tables products (currency
--      from the settings when none is chosen), product_images (image column with alt text + title) and faq;
--      RLS on everywhere
--   2. service_role: full access (like every Supabase schema)
--   3. every role in cms.settings.admin_roles: read/write all tables (no DDL), RLS policy,
--      also for tables created later (default privileges)
--   4. with agency=yes: group role agency_<schema>: read all tables; change only products.name and
--      product_images.alt_text/title_attr (where they exist); read its own folder <schema>/ in the
--      image bucket; PostgREST may switch into it (granted to authenticator)
--   5. audit: schema added to cms.settings.audit_schemas, triggers via cms.sync_audit()
-- Rights stay plain GRANTs + RLS policies (named "rbac: <role> <cmd>"), visible in Studio and in
-- the CMS under "effective rights". Remove or tighten them with SQL like any other right.

set client_min_messages = warning;

select set_config('brand.schema', :'schema', false),   -- e.g. acme  (a-z, 0-9, _)
       set_config('brand.label',  :'label',  false),   -- e.g. Acme Outdoor (schema comment; may be empty)
       set_config('brand.tables', :'tables', false),   -- template | none
       set_config('brand.agency', :'agency', false),   -- yes | no
       set_config('brand.bucket', :'bucket', false),   -- image bucket, e.g. images (may be empty)
       set_config('brand.settings', :'settings', false); -- yes | no

begin;

create or replace function pg_temp.rbac_policy(tbl regclass, rol text, cmd text, expr text default 'true')
returns void language plpgsql as $$
declare pname text := format('rbac: %s %s', rol, lower(cmd));
begin
  execute format('drop policy if exists %I on %s', pname, tbl);
  if cmd in ('SELECT', 'DELETE') then
    execute format('create policy %I on %s for %s to %I using (%s)', pname, tbl, cmd, rol, expr);
  elsif cmd = 'INSERT' then
    execute format('create policy %I on %s for %s to %I with check (%s)', pname, tbl, cmd, rol, expr);
  else
    execute format('create policy %I on %s for %s to %I using (%s) with check (%s)', pname, tbl, cmd, rol, expr, expr);
  end if;
end $$;

do $$
declare
  b        text := current_setting('brand.schema');
  label    text := nullif(current_setting('brand.label'), '');
  tables   text := current_setting('brand.tables');
  agency   boolean := current_setting('brand.agency') = 'yes';
  bucket   text := nullif(current_setting('brand.bucket'), '');
  settings boolean := current_setting('brand.settings') = 'yes';
  cur_type text;
  ag       text := 'agency_' || b;
  admins   text[] := coalesce((select admin_roles from cms.settings), '{}');
  r        text;
  t        record;
  cols     text[];
begin
  -- ── guard rails ─────────────────────────────────────────────────────────────────────────
  if b !~ '^[a-z_][a-z0-9_]{0,55}$' then
    raise exception 'brand schema "%" must be lower-case a-z, 0-9, _ (max 56 chars, so agency_<schema> fits a role name)', b;
  end if;
  if b in ('public', 'storage', 'auth', 'cms', 'cms_api', 'audit', 'extensions', 'graphql', 'graphql_public',
           'realtime', 'vault', 'pgsodium', 'pgsodium_masks', 'supabase_functions', 'supabase_migrations',
           'net', 'cron', 'information_schema') or b like 'pg\_%' or b like '\_%' then
    raise exception 'schema "%" is reserved and cannot be a brand', b;
  end if;
  if tables not in ('template', 'none') then raise exception 'tables must be template or none, not "%"', tables; end if;
  if to_regclass('cms.settings') is null then raise exception 'plugin not installed (packages/sql/install.sql)'; end if;

  -- ── 1. schema + standard tables ─────────────────────────────────────────────────────────
  execute format('create schema if not exists %I authorization postgres', b);
  if label is not null then execute format('comment on schema %I is %L', b, label); end if;
  -- the updated_at trigger of settings and the standard tables; a fresh Supabase does not have the extension enabled
  create extension if not exists moddatetime with schema extensions;

  -- currency codes the CMS offers as a dropdown; another one: alter type <schema>.currency_code add value 'JPY';
  if to_regtype(format('%I.currency_code', b)) is null then
    execute format($f$create type %I.currency_code as enum ('EUR', 'USD', 'GBP', 'CHF', 'PLN', 'CZK', 'SEK', 'DKK', 'NOK')$f$, b);
  end if;
  -- languages / regions of the content (BCP 47), a dropdown in the settings; another one: alter type <schema>.locale_code add value 'pt-PT';
  if settings and to_regtype(format('%I.locale_code', b)) is null then
    execute format($f$create type %I.locale_code as enum ('de-DE', 'de-AT', 'de-CH', 'en-GB', 'en-US', 'fr-FR', 'fr-CH', 'it-IT',
                                                          'it-CH', 'nl-NL', 'es-ES', 'pl-PL', 'cs-CZ', 'sv-SE', 'da-DK', 'nb-NO')$f$, b);
  end if;

  if settings then
    execute format($f$
      create table if not exists %1$I.settings (
        id               smallint primary key default 1 check (id = 1),   -- one row; a number, so it works as a URL id
        display_name     text not null,
        website_url      text check (website_url is null or website_url ~ '^https?://'),
        contact_email    text check (contact_email is null or contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
        default_currency %1$I.currency_code not null default 'EUR',
        default_locale   %1$I.locale_code not null default 'de-DE',
        seo_title_suffix text,
        seo_description  text,
        logo_path        text,
        logo_alt         text,
        updated_at       timestamptz not null default now()
      );
      create or replace trigger set_updated_at before update on %1$I.settings
        for each row execute function extensions.moddatetime(updated_at);
      alter table %1$I.settings enable row level security;
      alter table %1$I.settings owner to postgres;
      comment on table %1$I.settings is '@cms(singleton) Settings of the brand: one row.';
      comment on column %1$I.settings.display_name is 'Name of the brand as customers see it.';
      comment on column %1$I.settings.website_url is '@cms(label=Website) Address of the shop, starting with https://';
      comment on column %1$I.settings.contact_email is 'Address for customer questions.';
      comment on column %1$I.settings.default_currency is 'Currency of new products when none is chosen.';
      comment on column %1$I.settings.default_locale is 'Language and region of the content.';
      comment on column %1$I.settings.seo_title_suffix is '@cms(label=SEO title suffix) Added to page titles, e.g. " | Acme Outdoor".';
      comment on column %1$I.settings.seo_description is '@cms(label=SEO description) Description for pages without their own.';
      comment on column %1$I.settings.logo_alt is '@cms(label=Logo alt text)';
      insert into %1$I.settings (display_name) values (%2$L) on conflict (id) do nothing;
      -- the brand's default currency, for the default of products.currency; security definer, so a role that may
      -- insert products but not read the settings still gets it (it reveals one currency code, nothing else)
      create or replace function %1$I.default_currency() returns %1$I.currency_code
      language sql stable security definer set search_path = '' as
      $fn$ select coalesce((select default_currency from %1$I.settings), 'EUR') $fn$;
      alter function %1$I.default_currency() owner to postgres;
    $f$, b, coalesce(label, initcap(b)));
    -- settings of a brand bootstrapped before the locale type: text → locale_code (values must be codes of the type)
    select format_type(a.atttypid, a.atttypmod) into cur_type from pg_attribute a
     where a.attrelid = format('%I.settings', b)::regclass and a.attname = 'default_locale' and not a.attisdropped;
    if cur_type in ('text', 'character varying') then
      execute format('alter table %1$I.settings drop constraint if exists settings_default_locale_check,
                      alter column default_locale drop default,
                      alter column default_locale type %1$I.locale_code using default_locale::%1$I.locale_code,
                      alter column default_locale set default ''de-DE''', b);
    end if;
    if bucket is not null then
      execute format('comment on column %I.settings.logo_path is %L', b,
                     format('Logo in the bucket "%s" (folder %s/). @cms(image, bucket=%s, alt=logo_alt, label=Logo)', bucket, b, bucket));
    end if;
  end if;

  if tables = 'template' then
    if to_regtype(format('%I.product_status', b)) is null then
      execute format($f$create type %I.product_status as enum ('draft', 'active', 'archived')$f$, b);
    end if;
    execute format($f$
      create table if not exists %1$I.products (
        id          uuid primary key default gen_random_uuid(),
        sku         text not null unique,
        name        text not null,
        description text,
        price       numeric(10,2) not null check (price >= 0),
        currency    %1$I.currency_code not null default 'EUR',
        active      boolean not null default true,
        status      %1$I.product_status not null default 'active',
        updated_at  timestamptz not null default now()
      );
      create table if not exists %1$I.product_images (
        id           uuid primary key default gen_random_uuid(),
        product_id   uuid not null references %1$I.products (id) on delete cascade,
        storage_path text not null,
        alt_text     text,
        title_attr   text,
        position     int not null default 0,
        updated_at   timestamptz not null default now()
      );
      create table if not exists %1$I.faq (
        id          uuid primary key default gen_random_uuid(),
        question    text not null,
        answer      text not null,
        position    int not null default 0,
        published   boolean not null default true,
        updated_at  timestamptz not null default now()
      );
      create index if not exists product_images_product_id_idx on %1$I.product_images (product_id);
      create or replace trigger set_updated_at before update on %1$I.products
        for each row execute function extensions.moddatetime(updated_at);
      create or replace trigger set_updated_at before update on %1$I.product_images
        for each row execute function extensions.moddatetime(updated_at);
      create or replace trigger set_updated_at before update on %1$I.faq
        for each row execute function extensions.moddatetime(updated_at);
      alter table %1$I.products       enable row level security;
      alter table %1$I.product_images enable row level security;
      alter table %1$I.faq            enable row level security;
      alter table %1$I.products       owner to postgres;
      alter table %1$I.product_images owner to postgres;
      alter table %1$I.faq            owner to postgres;
    $f$, b);
    -- products of a brand bootstrapped before the currency type: text → currency_code (values must be codes of the type)
    select format_type(a.atttypid, a.atttypmod) into cur_type from pg_attribute a
     where a.attrelid = format('%I.products', b)::regclass and a.attname = 'currency' and not a.attisdropped;
    if cur_type in ('text', 'character varying') then
      execute format('alter table %1$I.products alter column currency drop default,
                      alter column currency type %1$I.currency_code using currency::%1$I.currency_code', b);
    end if;
    -- no currency chosen → the brand's default currency from its settings
    execute format('alter table %1$I.products alter column currency set default %s', b,
                   case when settings then format('%I.default_currency()', b) else '''EUR''' end);
    execute format('comment on column %I.products.currency is %L', b,
                   case when settings then 'Leave empty for the default currency of the brand (Settings).' else 'Currency of the price.' end);
    if bucket is not null then
      execute format('comment on column %I.product_images.storage_path is %L', b,
                     format('Object path in the bucket "%s" (folder %s/). @cms(image, bucket=%s)', bucket, b, bucket));
    end if;
  end if;

  -- ── 2. service_role ─────────────────────────────────────────────────────────────────────
  execute format('grant usage on schema %I to service_role', b);
  execute format('grant all on all tables in schema %I to service_role', b);
  execute format('grant all on all sequences in schema %I to service_role', b);
  foreach r in array array['postgres', 'supabase_admin'] loop
    execute format('alter default privileges for role %I in schema %I grant all on tables to service_role', r, b);
    execute format('alter default privileges for role %I in schema %I grant all on sequences to service_role', r, b);
  end loop;

  -- ── 3. admin roles from cms.settings ────────────────────────────────────────────────────
  foreach r in array admins loop
    continue when not exists (select 1 from pg_roles where rolname = r);
    execute format('grant usage on schema %I to %I', b, r);
    execute format('grant select, insert, update, delete on all tables in schema %I to %I', b, r);
    execute format('grant usage, select on all sequences in schema %I to %I', b, r);
    execute format('alter default privileges for role postgres in schema %I grant select, insert, update, delete on tables to %I', b, r);
    execute format('alter default privileges for role postgres in schema %I grant usage, select on sequences to %I', b, r);
    execute format('alter default privileges for role supabase_admin in schema %I grant select, insert, update, delete on tables to %I', b, r);
    execute format('alter default privileges for role supabase_admin in schema %I grant usage, select on sequences to %I', b, r);
    for t in select c.oid::regclass as tbl from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = b and c.relkind in ('r', 'p') and c.relrowsecurity loop
      perform pg_temp.rbac_policy(t.tbl, r, 'ALL');
    end loop;
  end loop;

  -- ── 4. agency role ──────────────────────────────────────────────────────────────────────
  if agency then
    if not exists (select 1 from pg_roles where rolname = ag) then
      execute format('create role %I nologin', ag);
    end if;
    execute format('comment on role %I is %L', ag,
                   format('Group: %s agency. Read schema %s, update product names + image alt/title.', coalesce(label, b), b));
    execute format('grant usage on schema %I to %I', b, ag);
    execute format('grant select on all tables in schema %I to %I', b, ag);
    execute format('alter default privileges for role postgres in schema %I grant select on tables to %I', b, ag);
    execute format('alter default privileges for role supabase_admin in schema %I grant select on tables to %I', b, ag);
    for t in select c.oid::regclass as tbl from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = b and c.relkind in ('r', 'p') and c.relrowsecurity loop
      perform pg_temp.rbac_policy(t.tbl, ag, 'SELECT');
    end loop;
    -- editable columns, only where the table and the column exist
    for t in select * from (values ('products', array['name']), ('product_images', array['alt_text', 'title_attr'])) v(tbl, want) loop
      continue when to_regclass(format('%I.%I', b, t.tbl)) is null;
      select array_agg(a.attname::text order by a.attnum) into cols
        from pg_attribute a
       where a.attrelid = format('%I.%I', b, t.tbl)::regclass and a.attnum > 0 and not a.attisdropped
         and a.attname = any (t.want);
      continue when cols is null;
      execute format('grant update (%s) on %I.%I to %I', (select string_agg(quote_ident(c), ', ') from unnest(cols) c), b, t.tbl, ag);
      perform pg_temp.rbac_policy(format('%I.%I', b, t.tbl)::regclass, ag, 'UPDATE');
    end loop;
    -- PostgREST / Storage may switch into the role when a token carries it
    execute format('grant %I to authenticator', ag);
    -- read its own folder in the image bucket
    if bucket is not null and to_regclass('storage.objects') is not null then
      execute format('grant usage on schema storage to %I', ag);
      execute format('grant select on storage.buckets to %I', ag);
      execute format('grant select on storage.objects to %I', ag);
      perform pg_temp.rbac_policy('storage.buckets', ag, 'SELECT', format('id = %L', bucket));
      -- "_" is a LIKE wildcard: escape it, so agency_gold_coast does not also read a folder "goldXcoast/"
      perform pg_temp.rbac_policy('storage.objects', ag, 'SELECT', format('bucket_id = %L and name like %L', bucket, replace(b, '_', '\_') || '/%'));
    end if;
  end if;

  -- ── 5. audit ────────────────────────────────────────────────────────────────────────────
  update cms.settings
     set audit_schemas = (select array_agg(distinct s order by s) from unnest(audit_schemas || array[b]) s),
         updated_at = now()
   where not (b = any (audit_schemas));
  perform cms.sync_audit();
end $$;

commit;

-- PostgREST: pick up new tables and roles (the schema itself must also be exposed, see above).
notify pgrst, 'reload schema';

-- Summary
select format('%-22s %s', 'schema', current_setting('brand.schema'))
union all select format('%-22s %s', 'tables', coalesce(string_agg(c.relname, ', ' order by c.relname), '(none yet)'))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = current_setting('brand.schema') and c.relkind in ('r', 'p', 'v')
union all select format('%-22s %s', 'audited tables', count(*))
  from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
 where g.tgname = 'zz_audit_log_change' and n.nspname = current_setting('brand.schema')
union all select format('%-22s %s', 'roles with access', string_agg(distinct grantee, ', '))
  from information_schema.role_table_grants
 where table_schema = current_setting('brand.schema') and grantee not in ('postgres', 'supabase_admin');
