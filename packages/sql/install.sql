-- SupaPIM — plugin migration (install and upgrade). One file, one transaction, idempotent:
-- running it again changes nothing (scripts/test-sql.sh diffs the catalog to prove it).
--
-- Run as `postgres` (Supabase Cloud: SQL editor or psql; self-hosted: postgres or supabase_admin).
-- The plugin brings NO permission model of its own. Rights stay Postgres GRANTs (incl. column
-- grants) and RLS; the plugin maps Supabase Auth users to group roles, records changes and makes
-- the effective rights visible. It never changes a GRANT on your tables (fix_public_defaults()
-- is opt-in and only touches schema public).
--
-- What it creates:
--   cms      internal, NOT exposed through PostgREST: settings, user → role mapping, access token
--            hook, audit helpers, hardening check, effective_rights() for admins
--   cms_api  exposed through PostgREST (add it to PGRST_DB_SCHEMAS / "Exposed schemas"); functions
--            only, thin security-invoker wrappers: describe(), whoami(), effective_rights(role_name),
--            and (step 2) list_users(), list_assignable_roles(), assign_role(), revoke_role(),
--            record_history(), (step 3) unreferenced_files(), (step 4) confirm_mfa_client(). The checks
--            and the privileged work live in security-definer functions in cms.
--   audit    change_log + trigger function
--
-- After installing (not SQL, Auth configuration):
--   Custom Access Token Hook → pg-functions://postgres/cms/custom_access_token_hook
--   (self-hosted: GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED=true + …_URI; Cloud: Auth → Hooks)
--
-- Versioned steps: every step below is written so it can run again; the last statement of a
-- step records it in cms.schema_version. A later step that cannot be written idempotently is
-- wrapped in "if not exists (select from cms.schema_version where version = N)".

begin;
set local client_min_messages = warning;

-- ── preflight ───────────────────────────────────────────────────────────────────────────────
do $$
declare r text;
begin
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'SupaPIM needs Postgres 15 or newer (found %)', current_setting('server_version');
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role', 'authenticator', 'supabase_auth_admin'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      raise exception 'SupaPIM: role % missing — this does not look like a Supabase database', r;
    end if;
  end loop;
  if to_regclass('auth.users') is null then
    raise exception 'SupaPIM: auth.users missing — this does not look like a Supabase database';
  end if;
  -- "audit" is a common schema name. Adopt it only if it is ours (or empty).
  if exists (select 1 from pg_namespace where nspname = 'audit')
     and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'audit' and c.relname not in ('change_log', 'change_log_id_seq',
                        'change_log_pkey', 'change_log_table_at', 'change_log_at')) then
    raise exception 'SupaPIM: schema audit already exists and holds other objects — not installing over it';
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Step 1 — schemas, settings, user → role mapping, token hook, audit, hardening check,
--          effective rights (describe / whoami / effective_rights)
-- ════════════════════════════════════════════════════════════════════════════════════════════

create schema if not exists cms;
create schema if not exists cms_api;
create schema if not exists audit;
comment on schema cms is 'SupaPIM plugin, internal (never expose through PostgREST).';
comment on schema cms_api is 'SupaPIM plugin API (exposed through PostgREST). Functions only, security-invoker wrappers.';
comment on schema audit is 'SupaPIM change log.';

-- cms: usage for everyone so cms_api.describe() (security invoker) can reach its helper.
-- Nothing in cms is readable or executable unless granted below; PostgREST never sees cms.
-- (Only grants here: a revoke-then-grant would reorder the ACL on every run.)
grant usage on schema cms to public;
grant usage on schema cms_api to public;
-- Functions created later in these schemas are not executable by everyone by default.
alter default privileges in schema cms     revoke execute on functions from public;
alter default privileges in schema cms_api revoke execute on functions from public;
alter default privileges in schema audit   revoke execute on functions from public;

-- ── version log ─────────────────────────────────────────────────────────────────────────────
create table if not exists cms.schema_version (
  version      int primary key,
  description  text not null,
  installed_at timestamptz not null default now(),
  installed_by text not null default current_user
);
comment on table cms.schema_version is 'Applied plugin migration steps (install.sql).';
revoke all on cms.schema_version from public;
grant select on cms.schema_version to public;

-- ── settings (one row) ──────────────────────────────────────────────────────────────────────
create table if not exists cms.settings (
  id                   boolean primary key default true check (id),
  admin_roles          name[] not null default '{}',          -- may see everyone's rights (effective_rights)
  audit_schemas        name[] not null default '{}',          -- every table in these schemas is logged …
  audit_tables         text[] not null default '{}',          -- … plus these tables ("schema.table") …
  audit_exclude        text[] not null default '{}',          -- … except these tables
  audit_ignore_columns name[] not null default '{updated_at}',-- UPDATEs touching only these are not logged
  updated_at           timestamptz not null default now()
);
comment on table cms.settings is 'Plugin settings (single row). Change with SQL, then select cms.sync_audit().';
insert into cms.settings default values on conflict (id) do nothing;
revoke all on cms.settings from public;

-- ── user → role mapping + token hook ────────────────────────────────────────────────────────
-- A role may be assigned when it is a plain NOLOGIN group that the API may switch into.
-- This excludes anon/authenticated/service_role, superusers, BYPASSRLS roles and login roles, roles that may
-- create roles or databases, and roles that inherit the rights of a superuser, a BYPASSRLS role, service_role
-- or one of Postgres' predefined pg_* roles (pg_read_all_data …): their rights would not be what Studio shows.
create or replace function cms.is_assignable_role(r name) returns boolean
language sql stable set search_path = pg_catalog as $$
  select exists (
    select 1 from pg_roles g
     where g.rolname = r
       and not g.rolcanlogin and not g.rolsuper and not g.rolbypassrls
       and not g.rolcreaterole and not g.rolcreatedb and not g.rolreplication
       and g.rolname not in ('anon', 'authenticated', 'service_role')
       and g.rolname not like 'pg\_%' and g.rolname not like 'supabase%'
       and pg_has_role('authenticator', g.oid, 'MEMBER')
       and not exists (select 1 from pg_roles m
                        where m.oid <> g.oid and pg_has_role(g.oid, m.oid, 'USAGE')
                          and (m.rolsuper or m.rolbypassrls or m.rolname like 'pg\_%'
                               or m.rolname in ('service_role', 'postgres', 'authenticator') or m.rolname like 'supabase%')))
$$;

create table if not exists cms.user_roles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  db_role    name not null check (cms.is_assignable_role(db_role)),
  granted_at timestamptz not null default now(),
  granted_by text not null default current_user
);
comment on table cms.user_roles is 'Supabase Auth user → Postgres group role (the role claim in their access tokens).';
revoke all on cms.user_roles from public;
alter table cms.user_roles enable row level security;

-- Second factor (step 4): who has a verified MFA factor gets the role only with a token that
-- proves it — aal2, or an OAuth token of a client the person confirmed with an aal2 session
-- (cms.mfa_client_confirmations). OAuth tokens are always aal1 in Supabase Auth, and its consent
-- endpoint accepts an aal1 session, so without this a password alone opened the data at the API.
create table if not exists cms.mfa_client_confirmations (
  user_id      uuid not null references auth.users (id) on delete cascade,
  client_id    uuid not null,                 -- auth.oauth_clients.id
  confirmed_at timestamptz not null default now(),
  primary key (user_id, client_id)
);
comment on table cms.mfa_client_confirmations is 'OAuth clients a person with MFA approved with the second factor (cms_api.confirm_mfa_client).';
revoke all on cms.mfa_client_confirmations from public;
alter table cms.mfa_client_confirmations enable row level security;

-- The role claim takes effect with the user's next access token (refresh), not immediately.
-- Without a mapping, or without the second factor where one is required, the claim stays as Auth set it
-- (authenticated): the same rights as a person without a CMS role.
create or replace function cms.custom_access_token_hook(event jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog as $$
declare
  uid uuid := (event ->> 'user_id')::uuid;
  c jsonb := event -> 'claims';
  r name;
  client uuid;
begin
  select u.db_role into r from cms.user_roles u where u.user_id = uid;
  if r is null or not cms.is_assignable_role(r) then
    return event;
  end if;
  if coalesce(c ->> 'aal', '') <> 'aal2'
     and exists (select 1 from auth.mfa_factors f where f.user_id = uid and f.status::text = 'verified') then
    client := coalesce(nullif(c ->> 'client_id', ''),
                       (select s.oauth_client_id::text from auth.sessions s where s.id = nullif(c ->> 'session_id', '')::uuid))::uuid;
    if client is null or not exists (select 1 from cms.mfa_client_confirmations m where m.user_id = uid and m.client_id = client) then
      return event;
    end if;
  end if;
  return jsonb_set(event, '{claims,role}', to_jsonb(r::text));
end $$;

-- Only the Auth server may run the hook and read the mapping.
revoke all on function cms.is_assignable_role(name) from public;
revoke all on function cms.custom_access_token_hook(jsonb) from public;
grant usage on schema cms to supabase_auth_admin;
grant execute on function cms.is_assignable_role(name) to supabase_auth_admin;
grant execute on function cms.custom_access_token_hook(jsonb) to supabase_auth_admin;
grant select on cms.user_roles to supabase_auth_admin;
drop policy if exists "auth server reads mapping" on cms.user_roles;
create policy "auth server reads mapping" on cms.user_roles for select to supabase_auth_admin using (true);
grant select on cms.mfa_client_confirmations to supabase_auth_admin;
drop policy if exists "auth server reads confirmations" on cms.mfa_client_confirmations;
create policy "auth server reads confirmations" on cms.mfa_client_confirmations for select to supabase_auth_admin using (true);

-- Is r (or a role r belongs to) one of the admin roles? Security definer: callers cannot read
-- cms.settings themselves.
create or replace function cms.is_admin(r name) returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select exists (
    select 1 from cms.settings s, unnest(s.admin_roles) a
     where exists (select 1 from pg_roles where rolname = a)
       and exists (select 1 from pg_roles where rolname = r)
       and pg_has_role(r, a, 'MEMBER'))
$$;
revoke all on function cms.is_admin(name) from public;
grant execute on function cms.is_admin(name) to public;

-- ── audit ───────────────────────────────────────────────────────────────────────────────────
create table if not exists audit.change_log (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  db_role       text not null,        -- effective role (SET ROLE / PostgREST JWT role), else login role
  login_role    text not null,        -- session_user: authenticator (API), postgres, a person login …
  jwt_sub       text,                 -- Supabase Auth user id when the change came through the API
  jwt_email     text,
  jwt_client_id text,                 -- OAuth client (e.g. the MCP client) that obtained the token
  table_name    text not null,        -- schema.table
  op            text not null,        -- INSERT / UPDATE / DELETE
  row_key       jsonb,                -- primary key columns of the row: {"id": …} or {"a": …, "b": …}
  changes       jsonb not null        -- INSERT: new row, DELETE: old row, UPDATE: {col: {old, new}}
);
alter table audit.change_log add column if not exists jwt_client_id text;
create index if not exists change_log_table_at on audit.change_log (table_name, at desc);
create index if not exists change_log_at on audit.change_log (at desc);
comment on table audit.change_log is 'Row-level change log written by audit.log_change(). Grant select to the roles that may read it.';
revoke all on audit.change_log from public;

-- Generic row trigger. Never blocks the data change: any failure becomes a WARNING.
create or replace function audit.log_change() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  o jsonb; n jsonb; r jsonb; diff jsonb; pk jsonb; claims jsonb; ign text[];
begin
  begin
    o := case when tg_op <> 'INSERT' then to_jsonb(old) end;
    n := case when tg_op <> 'DELETE' then to_jsonb(new) end;
    r := coalesce(n, o);
    select s.audit_ignore_columns::text[] into ign from cms.settings s;
    ign := coalesce(ign, '{}');
    if tg_op = 'UPDATE' then
      select coalesce(jsonb_object_agg(k, jsonb_build_object('old', o -> k, 'new', n -> k)), '{}')
        into diff
        from jsonb_object_keys(n) k
       where (o -> k) is distinct from (n -> k)
         and k <> all (ign);
      if diff = '{}' then return null; end if;
    else
      diff := r;
    end if;
    -- row key = primary key columns (any name, composite keys too); null when there is no PK
    select jsonb_object_agg(a.attname, r -> a.attname::text) into pk
      from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
     where i.indrelid = tg_relid and i.indisprimary;
    claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    insert into audit.change_log (db_role, login_role, jwt_sub, jwt_email, jwt_client_id, table_name, op, row_key, changes)
    values (coalesce(nullif(current_setting('role', true), 'none'), session_user::text),
            session_user::text,
            claims ->> 'sub', claims ->> 'email', nullif(claims ->> 'client_id', ''),
            tg_table_schema || '.' || tg_table_name, tg_op, pk, diff);
  exception when others then
    raise warning 'audit.log_change failed on %.%: %', tg_table_schema, tg_table_name, sqlerrm;
  end;
  return null;
end $$;
revoke all on function audit.log_change() from public;

-- Bring the audit triggers in line with cms.settings: add the trigger to every target table,
-- remove it from tables that are no longer targets. Returns what it did. Run as the table owner
-- (postgres) after changing the settings or creating tables in an audited schema.
create or replace function cms.sync_audit()
returns table (action text, table_name text)
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare s cms.settings; t record;
begin
  select * into s from cms.settings;
  for t in
    select c.oid::regclass as tbl, format('%I.%I', n.nspname, c.relname) as qname,
           exists (select 1 from pg_trigger g where g.tgrelid = c.oid and g.tgname = 'zz_audit_log_change') as has_trigger,
           ((n.nspname = any (s.audit_schemas) or format('%I.%I', n.nspname, c.relname) = any (s.audit_tables))
            and format('%I.%I', n.nspname, c.relname) <> all (s.audit_exclude)
            and n.nspname not in ('cms', 'cms_api', 'audit', 'information_schema')
            and n.nspname not like 'pg\_%') as wanted
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p') and not c.relispartition
     order by 2
  loop
    if t.wanted and not t.has_trigger then
      execute format('create trigger zz_audit_log_change after insert or update or delete on %s
                      for each row execute function audit.log_change()', t.tbl);
      action := 'enabled'; table_name := t.qname; return next;
    elsif t.has_trigger and not t.wanted then
      execute format('drop trigger zz_audit_log_change on %s', t.tbl);
      action := 'disabled'; table_name := t.qname; return next;
    end if;
  end loop;
end $$;
revoke all on function cms.sync_audit() from public;

create or replace function cms.enable_audit(tbl regclass) returns void
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare q text := (select format('%I.%I', n.nspname, c.relname) from pg_class c
                     join pg_namespace n on n.oid = c.relnamespace where c.oid = tbl);
begin
  update cms.settings
     set audit_tables  = (select array_agg(distinct x order by x) from unnest(audit_tables || q) x),
         audit_exclude = array_remove(audit_exclude, q),
         updated_at    = now();
  perform cms.sync_audit();
end $$;

create or replace function cms.disable_audit(tbl regclass) returns void
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare q text; nsp name;
begin
  select format('%I.%I', n.nspname, c.relname), n.nspname into q, nsp
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = tbl;
  update cms.settings
     set audit_tables  = array_remove(audit_tables, q),
         audit_exclude = case when nsp = any (audit_schemas) and q <> all (audit_exclude)
                              then audit_exclude || q else audit_exclude end,
         updated_at    = now();
  perform cms.sync_audit();
end $$;
revoke all on function cms.enable_audit(regclass) from public;
revoke all on function cms.disable_audit(regclass) from public;

-- ── hardening check for Supabase's stock grants in schema public ────────────────────────────
-- Supabase grants anon + authenticated ALL on every new table/sequence/function in public, so
-- only RLS stands between the public anon key and the data. This lists what is open.
create or replace function cms.check_public_defaults()
returns table (severity text, object text, finding text, fix text)
language sql stable set search_path = pg_catalog as $$
  -- default privileges: what NEW objects in public will get
  select 'warning',
         format('default privileges of %s in schema public', d.defaclrole::regrole),
         format('new %s get %s for %s',
                case d.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences' when 'f' then 'functions' else d.defaclobjtype::text end,
                string_agg(distinct a.privilege_type, ', '),
                string_agg(distinct a.grantee::regrole::text, ', ')),
         'select * from cms.fix_public_defaults(dry_run => false)'
    from pg_default_acl d, aclexplode(d.defaclacl) a
   where d.defaclnamespace = 'public'::regnamespace
     and a.grantee in ('anon'::regrole, 'authenticated'::regrole)
   group by d.defaclrole, d.defaclobjtype
  union all
  -- existing tables and views in public granted to anon/authenticated
  select case when c.relkind in ('r', 'p') and not c.relrowsecurity then 'critical' else 'warning' end,
         c.oid::regclass::text,
         format('%s granted %s%s', string_agg(distinct a.grantee::regrole::text, ', '),
                string_agg(distinct a.privilege_type, ', '),
                case when c.relkind in ('r', 'p') and not c.relrowsecurity then ' and RLS is OFF'
                     when c.relkind in ('r', 'p') then ' (only RLS protects it)'
                     else ' (view: runs with the owner''s rights unless security_invoker)' end),
         format('revoke all on %s from anon, authenticated;', c.oid::regclass)
    from pg_class c, aclexplode(c.relacl) a
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and a.grantee in ('anon'::regrole, 'authenticated'::regrole)
     and not exists (select 1 from pg_depend e where e.classid = 'pg_class'::regclass and e.objid = c.oid and e.deptype = 'e')
   group by c.oid, c.relkind, c.relrowsecurity
  union all
  -- functions in public that anon may execute (match_* = vector search over the whole store)
  select case when p.prosecdef then 'critical' when p.proname like 'match\_%' then 'warning' else 'info' end,
         p.oid::regprocedure::text,
         'executable by anon' || case when p.prosecdef then ' and SECURITY DEFINER (bypasses the caller''s rights)'
                                      when p.proname like 'match\_%' then ' (vector search)' else '' end,
         format('revoke execute on function %s from anon, authenticated, public;', p.oid::regprocedure)
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and has_function_privilege('anon', p.oid, 'EXECUTE')
     and not exists (select 1 from pg_depend e where e.classid = 'pg_proc'::regclass and e.objid = p.oid and e.deptype = 'e')
  order by 1, 2
$$;
revoke all on function cms.check_public_defaults() from public;

-- Optional fix (opt-in): the logic of the AVIA template 05-public-defaults.sql.
--   dry_run => true (default) only returns the statements.
--   include_public_execute => also remove PUBLIC's EXECUTE on functions created later — in ALL schemas (Postgres has no
--   per-schema switch for it). Without it, a function created in public later is callable by anon again.
--   include_existing => also revoke anon/authenticated on existing public tables, sequences and
--   functions (careful: an app that reads public tables with the anon key stops working).
-- service_role keeps EXECUTE on the functions it could run before. Statements the caller is not
-- allowed to run (e.g. default privileges of supabase_admin on Supabase Cloud) are skipped.
drop function if exists cms.fix_public_defaults(boolean, boolean);   -- before v6: without include_public_execute
create or replace function cms.fix_public_defaults(dry_run boolean default true, include_existing boolean default true,
                                                   include_public_execute boolean default false)
returns setof text
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare stmt text; stmts text[] := '{}'; r text; f record;
begin
  foreach r in array array['postgres', 'supabase_admin'] loop
    continue when not exists (select 1 from pg_roles where rolname = r);
    stmts := stmts || array[
      format('alter default privileges for role %I in schema public revoke all on tables from anon, authenticated', r),
      format('alter default privileges for role %I in schema public revoke all on sequences from anon, authenticated', r),
      format('alter default privileges for role %I in schema public revoke all on functions from anon, authenticated', r)];
    -- Postgres gives EXECUTE on every new function to PUBLIC. That default can only be removed for all schemas at once
    -- (not per schema): after this, new functions anywhere need an explicit GRANT EXECUTE to be callable through the API.
    if include_public_execute then
      stmts := stmts || format('alter default privileges for role %I revoke execute on functions from public', r);
    end if;
  end loop;
  if include_existing then
    for f in select c.oid::regclass as obj, c.relkind from pg_class c
              where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
                and exists (select 1 from aclexplode(c.relacl) a where a.grantee in ('anon'::regrole, 'authenticated'::regrole))
                and not exists (select 1 from pg_depend e where e.classid = 'pg_class'::regclass and e.objid = c.oid and e.deptype = 'e')
              order by 1 loop
      stmts := stmts || format('revoke all on %s %s from anon, authenticated',
                               case when f.relkind = 'S' then 'sequence' else 'table' end, f.obj);
    end loop;
    for f in select p.oid::regprocedure as fn, has_function_privilege('service_role', p.oid, 'EXECUTE') as svc
               from pg_proc p
              where p.pronamespace = 'public'::regnamespace
                and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
                and not exists (select 1 from pg_depend e where e.classid = 'pg_proc'::regclass and e.objid = p.oid and e.deptype = 'e')
              order by 1 loop
      if f.svc then stmts := stmts || format('grant execute on function %s to service_role', f.fn); end if;
      stmts := stmts || format('revoke execute on function %s from anon, authenticated, public', f.fn);
    end loop;
  end if;
  foreach stmt in array stmts loop
    if dry_run then
      return next stmt || ';';
    else
      begin
        execute stmt;
        return next stmt || ';';
      exception when insufficient_privilege then
        return next '-- skipped (' || sqlerrm || '): ' || stmt || ';';
      end;
    end if;
  end loop;
end $$;
revoke all on function cms.fix_public_defaults(boolean, boolean, boolean) from public;

-- ── effective rights: the one description UI and MCP build on ───────────────────────────────
-- Everything role r can reach: schemas, tables/views and columns (type, nullable, default, enum
-- values, column privileges select/insert/update), primary and foreign keys, table privilege
-- delete, RLS state and the policies that apply to r, functions r may execute, storage buckets
-- with the storage policies that apply to r.
-- Computed from the catalog with has_*_privilege(r, …), i.e. by Postgres itself.
-- live = true (only when r is the caller, from cms_api.describe()): buckets = the rows of
-- storage.buckets the caller actually sees under RLS. live = false (effective_rights): buckets
-- are those named in a storage policy that applies to r (or all, for an unconditional policy).
create or replace function cms.describe_role(r name, live boolean default false) returns jsonb
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  rid oid;
  hidden name[] := array['information_schema', 'auth', 'storage', 'realtime', '_realtime', 'extensions',
                         'graphql', 'graphql_public', 'vault', 'pgsodium', 'pgsodium_masks', 'net', 'cron',
                         'pgbouncer', 'supabase_functions', 'supabase_migrations', '_analytics', 'pgtle',
                         'cms', 'cms_api', 'audit'];
  schemas jsonb; storage jsonb := null; buckets jsonb; bucket_rows jsonb;
begin
  select oid into rid from pg_roles where rolname = r;
  if rid is null then
    raise exception 'role % does not exist', r using errcode = '42704';
  end if;

  with
  pol as (   -- policies that apply to r (directly, through membership, or to PUBLIC)
    select p.polrelid, jsonb_build_object(
             'name', p.polname,
             'command', case p.polcmd when 'r' then 'select' when 'a' then 'insert' when 'w' then 'update'
                                      when 'd' then 'delete' else 'all' end,
             'permissive', p.polpermissive,
             'using', pg_get_expr(p.polqual, p.polrelid),
             'check', pg_get_expr(p.polwithcheck, p.polrelid)) as j
      from pg_policy p
     where 0 = any (p.polroles) or exists (select 1 from unnest(p.polroles) x where pg_has_role(rid, x, 'MEMBER'))
  ),
  nsp as (
    select n.oid, n.nspname from pg_namespace n
     where n.nspname <> all (hidden) and n.nspname not like 'pg\_%'
       and not exists (select 1 from pg_depend e where e.classid = 'pg_namespace'::regclass and e.objid = n.oid and e.deptype = 'e')
       and has_schema_privilege(rid, n.oid, 'USAGE')
  ),
  rel as (
    select c.oid, c.relnamespace, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c join nsp on nsp.oid = c.relnamespace
     where c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition
       and (has_any_column_privilege(rid, c.oid, 'SELECT, INSERT, UPDATE') or has_table_privilege(rid, c.oid, 'DELETE'))
  ),
  tbl as (
    select rel.relnamespace, rel.relname, jsonb_build_object(
      'name', rel.relname,
      'kind', case rel.relkind when 'r' then 'table' when 'p' then 'table' when 'v' then 'view'
                               when 'm' then 'materialized_view' else 'foreign_table' end,
      'comment', obj_description(rel.oid, 'pg_class'),
      'privileges', jsonb_build_object(
          'select', has_any_column_privilege(rid, rel.oid, 'SELECT'),
          'insert', has_any_column_privilege(rid, rel.oid, 'INSERT'),
          'update', has_any_column_privilege(rid, rel.oid, 'UPDATE'),
          'delete', has_table_privilege(rid, rel.oid, 'DELETE')),
      'rls', jsonb_build_object('enabled', rel.relrowsecurity, 'forced', rel.relforcerowsecurity,
          'policies', coalesce((select jsonb_agg(pol.j order by pol.j ->> 'name') from pol where pol.polrelid = rel.oid), '[]')),
      'primary_key', (select jsonb_agg(a.attname order by k.ord)
                        from pg_index i, unnest(i.indkey::int2[]) with ordinality k(attnum, ord), pg_attribute a
                       where i.indrelid = rel.oid and i.indisprimary and a.attrelid = rel.oid and a.attnum = k.attnum),
      'unique', coalesce((select jsonb_agg(u.cols order by u.cols::text) from (
                    select jsonb_agg(a.attname order by k.ord) as cols
                      from pg_index i, unnest(i.indkey::int2[]) with ordinality k(attnum, ord), pg_attribute a
                     where i.indrelid = rel.oid and i.indisunique and not i.indisprimary and i.indpred is null
                       and a.attrelid = rel.oid and a.attnum = k.attnum
                     group by i.indexrelid) u), '[]'),
      'foreign_keys', coalesce((select jsonb_agg(jsonb_build_object(
            'name', con.conname,
            'columns', (select jsonb_agg(a.attname order by k.ord) from unnest(con.conkey) with ordinality k(attnum, ord)
                          join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum),
            'references', jsonb_build_object(
                'schema', fn.nspname, 'table', fc.relname,
                'columns', (select jsonb_agg(a.attname order by k.ord) from unnest(con.confkey) with ordinality k(attnum, ord)
                              join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum),
                'readable', has_any_column_privilege(rid, con.confrelid, 'SELECT')),
            'on_update', case con.confupdtype when 'c' then 'cascade' when 'n' then 'set null' when 'd' then 'set default'
                                              when 'r' then 'restrict' else 'no action' end,
            'on_delete', case con.confdeltype when 'c' then 'cascade' when 'n' then 'set null' when 'd' then 'set default'
                                              when 'r' then 'restrict' else 'no action' end) order by con.conname)
          from pg_constraint con join pg_class fc on fc.oid = con.confrelid join pg_namespace fn on fn.oid = fc.relnamespace
         where con.conrelid = rel.oid and con.contype = 'f'), '[]'),
      'columns', coalesce((select jsonb_agg(jsonb_build_object(
            'name', a.attname,
            'type', format_type(a.atttypid, a.atttypmod),
            'udt', case when tn.nspname = 'pg_catalog' then t.typname::text else format('%I.%I', tn.nspname, t.typname) end,
            'category', case coalesce(et.typtype, t.typtype) when 'e' then 'enum' else
                          case t.typcategory when 'S' then 'string' when 'N' then 'number' when 'B' then 'boolean'
                                             when 'D' then 'datetime' when 'A' then 'array' when 'U' then 'user'
                                             when 'T' then 'timespan' else t.typcategory::text end end,
            'is_array', t.typcategory = 'A',
            'nullable', not a.attnotnull,
            'default', pg_get_expr(d.adbin, d.adrelid),
            'identity', nullif(a.attidentity, ''),
            'generated', nullif(a.attgenerated, ''),
            'enum', (select jsonb_agg(e.enumlabel order by e.enumsortorder) from pg_enum e
                      where e.enumtypid = coalesce(et.oid, t.oid)),
            'comment', col_description(rel.oid, a.attnum),
            'privileges', jsonb_build_object(
                'select', has_column_privilege(rid, rel.oid, a.attnum, 'SELECT'),
                'insert', has_column_privilege(rid, rel.oid, a.attnum, 'INSERT'),
                'update', has_column_privilege(rid, rel.oid, a.attnum, 'UPDATE'))) order by a.attnum)
          from pg_attribute a
          join pg_type t on t.oid = a.atttypid
          join pg_namespace tn on tn.oid = t.typnamespace
          left join pg_type et on et.oid = t.typelem and t.typcategory = 'A' and et.typtype = 'e'
          left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
         where a.attrelid = rel.oid and a.attnum > 0 and not a.attisdropped
           and has_column_privilege(rid, rel.oid, a.attnum, 'SELECT, INSERT, UPDATE')), '[]')
    ) as j
    from rel
  ),
  fun as (
    select p.pronamespace, jsonb_build_object(
      'name', p.proname,
      'arguments', pg_get_function_arguments(p.oid),
      'returns', pg_get_function_result(p.oid),
      'returns_set', p.proretset,
      'volatility', case p.provolatile when 'i' then 'immutable' when 's' then 'stable' else 'volatile' end,
      'security_definer', p.prosecdef,
      'comment', obj_description(p.oid, 'pg_proc')) as j
      from pg_proc p join nsp on nsp.oid = p.pronamespace
     where p.prokind = 'f'
       and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
       and not exists (select 1 from pg_depend e where e.classid = 'pg_proc'::regclass and e.objid = p.oid and e.deptype = 'e')
       and has_function_privilege(rid, p.oid, 'EXECUTE')
  )
  select coalesce(jsonb_agg(s.j order by s.j ->> 'name'), '[]') into schemas
    from (select jsonb_build_object(
                   'name', nsp.nspname,
                   'comment', obj_description(nsp.oid, 'pg_namespace'),
                   'tables', coalesce((select jsonb_agg(tbl.j order by tbl.relname) from tbl where tbl.relnamespace = nsp.oid), '[]'),
                   'functions', coalesce((select jsonb_agg(fun.j order by fun.j ->> 'name', fun.j ->> 'arguments')
                                            from fun where fun.pronamespace = nsp.oid), '[]')) as j
            from nsp) s
   where jsonb_array_length(s.j -> 'tables') > 0 or jsonb_array_length(s.j -> 'functions') > 0;

  -- storage (Supabase Storage API: buckets + objects, both under RLS)
  if to_regclass('storage.buckets') is not null and to_regclass('storage.objects') is not null
     and has_schema_privilege(rid, 'storage', 'USAGE') then
    if live then
      if has_table_privilege(rid, 'storage.buckets', 'SELECT') then
        execute 'select coalesce(jsonb_agg(to_jsonb(b) order by b.id), ''[]'') from storage.buckets b' into bucket_rows;
      end if;
    else
      execute 'select coalesce(jsonb_agg(to_jsonb(b) order by b.id), ''[]'') from storage.buckets b' into bucket_rows;
    end if;
    with pol as (
      select p.polrelid, pg_get_expr(p.polqual, p.polrelid) as q, pg_get_expr(p.polwithcheck, p.polrelid) as c,
             jsonb_build_object(
               'name', p.polname,
               'command', case p.polcmd when 'r' then 'select' when 'a' then 'insert' when 'w' then 'update'
                                        when 'd' then 'delete' else 'all' end,
               'using', pg_get_expr(p.polqual, p.polrelid),
               'check', pg_get_expr(p.polwithcheck, p.polrelid)) as j
        from pg_policy p
       where p.polrelid in ('storage.buckets'::regclass, 'storage.objects'::regclass)
         and (0 = any (p.polroles) or exists (select 1 from unnest(p.polroles) x where pg_has_role(rid, x, 'MEMBER')))
    ),
    b as (select x as row from jsonb_array_elements(coalesce(bucket_rows, '[]')) x)
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', b.row ->> 'id', 'name', b.row ->> 'name', 'public', (b.row ->> 'public')::boolean,
             'object_policies', coalesce((select jsonb_agg(pol.j order by pol.j ->> 'name') from pol
                                           where pol.polrelid = 'storage.objects'::regclass
                                             and (concat(pol.q, ' ', pol.c) like '%' || quote_literal(b.row ->> 'id') || '%'
                                                  or concat(pol.q, ' ', pol.c) not like '%bucket_id%')), '[]'))
             order by b.row ->> 'id'), '[]')
      into buckets
      from b
     where live
        or exists (select 1 from pol
                    where concat(pol.q, ' ', pol.c) like '%' || quote_literal(b.row ->> 'id') || '%'
                       or (pol.polrelid = 'storage.buckets'::regclass and coalesce(pol.q, 'true') = 'true'));
    storage := jsonb_build_object(
      'object_privileges', jsonb_build_object(
          'select', has_table_privilege(rid, 'storage.objects', 'SELECT'),
          'insert', has_table_privilege(rid, 'storage.objects', 'INSERT'),
          'update', has_table_privilege(rid, 'storage.objects', 'UPDATE'),
          'delete', has_table_privilege(rid, 'storage.objects', 'DELETE')),
      'buckets', buckets);
  end if;

  return jsonb_build_object(
    'role', r,
    'is_admin', cms.is_admin(r),
    'plugin_version', (select max(version) from cms.schema_version),
    'schemas', schemas,
    'storage', coalesce(storage, jsonb_build_object('object_privileges', null, 'buckets', '[]'::jsonb)));
end $$;
revoke all on function cms.describe_role(name, boolean) from public;
grant execute on function cms.describe_role(name, boolean) to public;

-- Admins only: the effective rights of any role (same shape as cms_api.describe()).
-- The caller is the role the session is acting as (PostgREST's JWT role), not the function owner.
create or replace function cms.effective_rights(r name) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare caller name := coalesce(nullif(current_setting('role', true), 'none'), session_user)::name;
begin
  if not (cms.is_admin(caller)
          or exists (select 1 from pg_roles where rolname = caller and (rolsuper or rolbypassrls))) then
    raise exception 'permission denied: % is not a CMS admin (cms.settings.admin_roles)', caller
      using errcode = '42501';
  end if;
  return cms.describe_role(r, false);
end $$;
revoke all on function cms.effective_rights(name) from public;
grant execute on function cms.effective_rights(name) to public;   -- checked inside

-- ── cms_api: the PostgREST surface (POST /rest/v1/rpc/<fn>, header Content-Profile: cms_api) ─
create or replace function cms_api.describe() returns jsonb
language plpgsql stable security invoker set search_path = pg_catalog, pg_temp as $$
begin
  if current_user = 'anon' then
    raise exception 'permission denied: sign in first' using errcode = '42501';
  end if;
  return cms.describe_role(current_user, true);
end $$;
comment on function cms_api.describe() is 'What the signed-in role can see and change: schemas, tables, columns, keys, rights, RLS, functions, buckets.';

create or replace function cms_api.whoami() returns jsonb
language sql stable security invoker set search_path = pg_catalog as $$
  select jsonb_build_object(
           'role', current_user,
           'login_role', session_user,
           'user_id', c ->> 'sub',
           'email', c ->> 'email',
           'client_id', c ->> 'client_id',
           'is_admin', cms.is_admin(current_user),
           'claims', c)
    from (select nullif(current_setting('request.jwt.claims', true), '')::jsonb as c) s
$$;
comment on function cms_api.whoami() is 'The signed-in role and the claims of its token.';

create or replace function cms_api.effective_rights(role_name name) returns jsonb
language sql stable security invoker set search_path = pg_catalog as $$
  select cms.effective_rights(role_name)
$$;
comment on function cms_api.effective_rights(name) is 'Admins only: the rights of any role, same shape as describe().';

revoke all on function cms_api.describe() from public;
revoke all on function cms_api.whoami() from public;
revoke all on function cms_api.effective_rights(name) from public;
grant execute on function cms_api.describe() to public;
grant execute on function cms_api.whoami() to public;
grant execute on function cms_api.effective_rights(name) to public;

insert into cms.schema_version (version, description)
values (1, 'settings, user roles + token hook, generic audit, hardening check, describe/whoami/effective_rights')
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Step 2 — admin area: list users, assign/revoke roles, record history
--
-- All four are for the CMS UI (Task 5c). Same pattern as cms.effective_rights(): the privileged
-- work is a security-definer function in cms that first checks the CALLER — the role PostgREST
-- switched into (GUC "role"), not the function owner. cms_api holds invoker wrappers. Nothing
-- here touches a GRANT; inviting or blocking people needs the Auth admin API, not SQL.
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- The role the session acts as, and who is behind it (JWT e-mail, else the role name).
create or replace function cms.caller_role() returns name
language sql stable set search_path = pg_catalog as $$
  select coalesce(nullif(current_setting('role', true), 'none'), session_user)::name
$$;

-- Raises 42501 unless the caller is a CMS admin (cms.settings.admin_roles), a superuser or a
-- BYPASSRLS role such as service_role (the same rule as cms.effective_rights).
create or replace function cms.require_admin() returns void
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare caller name := cms.caller_role();
begin
  if not (cms.is_admin(caller)
          or exists (select 1 from pg_roles where rolname = caller and (rolsuper or rolbypassrls))) then
    raise exception 'permission denied: % is not a CMS admin (cms.settings.admin_roles)', caller
      using errcode = '42501';
  end if;
end $$;

-- Writes a change-log row by hand: cms.user_roles lives in schema cms, which the generic
-- triggers never cover. Same columns and shape as audit.log_change().
create or replace function cms.log_role_change(op text, uid uuid, changes jsonb) returns void
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
begin
  insert into audit.change_log (db_role, login_role, jwt_sub, jwt_email, jwt_client_id, table_name, op, row_key, changes)
  values (cms.caller_role()::text, session_user::text, claims ->> 'sub', claims ->> 'email',
          nullif(claims ->> 'client_id', ''), 'cms.user_roles', op, jsonb_build_object('user_id', uid), changes);
end $$;

create or replace function cms.list_users()
returns table (user_id uuid, email text, db_role name, granted_at timestamptz, granted_by text,
               created_at timestamptz, invited_at timestamptz, confirmed_at timestamptz,
               last_sign_in_at timestamptz, banned_until timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform cms.require_admin();
  return query
    -- banned_until / deleted_at / is_anonymous come from Auth's own migrations; to_jsonb keeps this
    -- working on a database where an older Auth version has not added them yet
    select u.id, u.email::text, r.db_role, r.granted_at, r.granted_by, u.created_at, u.invited_at,
           u.confirmed_at, u.last_sign_in_at, (to_jsonb(u) ->> 'banned_until')::timestamptz
      from auth.users u left join cms.user_roles r on r.user_id = u.id
     where (to_jsonb(u) ->> 'deleted_at') is null and coalesce((to_jsonb(u) ->> 'is_anonymous')::boolean, false) = false
     order by u.email, u.created_at;
end $$;

create or replace function cms.assign_role(p_user_id uuid, p_role name) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  mail text; old_role name;
begin
  perform cms.require_admin();
  if p_user_id is null or p_role is null then
    raise exception 'user_id and role are required' using errcode = '22004';
  end if;
  if claims ->> 'sub' = p_user_id::text then
    raise exception 'you cannot change your own role' using errcode = '42501';
  end if;
  if not cms.is_assignable_role(p_role) then
    raise exception 'role % cannot be assigned (must be a NOLOGIN group the API may switch into)', p_role
      using errcode = '22023';
  end if;
  select u.email into mail from auth.users u where u.id = p_user_id and (to_jsonb(u) ->> 'deleted_at') is null;
  if not found then
    raise exception 'user % does not exist', p_user_id using errcode = 'P0002';
  end if;
  select db_role into old_role from cms.user_roles where user_id = p_user_id;
  if old_role is distinct from p_role then
    insert into cms.user_roles (user_id, db_role, granted_by)
    values (p_user_id, p_role, coalesce(claims ->> 'email', cms.caller_role()::text))
    on conflict (user_id) do update
      set db_role = excluded.db_role, granted_at = now(), granted_by = excluded.granted_by;
    perform cms.log_role_change(
      case when old_role is null then 'INSERT' else 'UPDATE' end, p_user_id,
      case when old_role is null then jsonb_build_object('user_id', p_user_id, 'email', mail, 'db_role', p_role)
           else jsonb_build_object('db_role', jsonb_build_object('old', old_role, 'new', p_role), 'email', mail) end);
  end if;
  return jsonb_build_object('user_id', p_user_id, 'email', mail, 'db_role', p_role, 'previous_role', old_role,
                            'changed', old_role is distinct from p_role);
end $$;

create or replace function cms.revoke_role(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  mail text; old_role name;
begin
  perform cms.require_admin();
  if claims ->> 'sub' = p_user_id::text then
    raise exception 'you cannot change your own role' using errcode = '42501';
  end if;
  delete from cms.user_roles where user_id = p_user_id returning db_role into old_role;
  if old_role is not null then
    select u.email into mail from auth.users u where u.id = p_user_id;
    perform cms.log_role_change('DELETE', p_user_id,
      jsonb_build_object('user_id', p_user_id, 'email', mail, 'db_role', old_role));
  end if;
  return jsonb_build_object('user_id', p_user_id, 'previous_role', old_role, 'changed', old_role is not null);
end $$;

-- The change log of one record. p_table = "schema.table"; p_key = its primary key as JSON,
-- e.g. {"id": "…"} (values are compared as text, so 5 and "5" match; all key columns must match).
-- Allowed: roles with SELECT on audit.change_log, or an admin role that may itself read the table
-- (cms.user_roles — the role assignments — needs the admin right alone).
create or replace function cms.record_history(p_table text, p_key jsonb, p_limit int default 50)
returns table (id bigint, at timestamptz, db_role text, jwt_sub text, jwt_email text, jwt_client_id text,
               op text, changes jsonb)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  caller name := cms.caller_role();
  tbl regclass;
  only_readable boolean := false;
begin
  if not has_table_privilege(caller, 'audit.change_log', 'SELECT') then
    perform cms.require_admin();
    only_readable := p_table <> 'cms.user_roles';
    if p_table <> 'cms.user_roles' then
      tbl := to_regclass(p_table);
      if tbl is null or not coalesce(has_any_column_privilege(caller, tbl, 'SELECT'), false) then
        raise exception 'permission denied for table %', p_table using errcode = '42501';
      end if;
    end if;
  end if;
  if p_key is null or jsonb_typeof(p_key) <> 'object' or p_key = '{}' then
    raise exception 'key must be a JSON object with the primary key columns' using errcode = '22023';
  end if;
  -- An admin who reads the history through the table right sees only the columns that right covers
  -- (the log holds every column of the row, also those a column grant hides from this role).
  return query
    select l.id, l.at, l.db_role, l.jwt_sub, l.jwt_email, l.jwt_client_id, l.op,
           case when not only_readable then l.changes else
             (select coalesce(jsonb_object_agg(e.key, e.value), '{}') from jsonb_each(l.changes) e
               where exists (select 1 from pg_attribute a where a.attrelid = tbl and a.attname = e.key and a.attnum > 0
                               and not a.attisdropped and has_column_privilege(caller, tbl, a.attnum, 'SELECT'))) end
      from audit.change_log l
     where l.table_name = p_table
       and l.row_key is not null
       and (select count(*) from jsonb_object_keys(l.row_key)) = (select count(*) from jsonb_object_keys(p_key))
       and not exists (select 1 from jsonb_each_text(p_key) k where l.row_key ->> k.key is distinct from k.value)
     order by l.at desc, l.id desc
     limit least(greatest(coalesce(p_limit, 50), 1), 500);
end $$;

revoke all on function cms.caller_role() from public;
revoke all on function cms.require_admin() from public;
revoke all on function cms.log_role_change(text, uuid, jsonb) from public;
revoke all on function cms.list_users() from public;
revoke all on function cms.assign_role(uuid, name) from public;
revoke all on function cms.revoke_role(uuid) from public;
revoke all on function cms.record_history(text, jsonb, int) from public;
grant execute on function cms.caller_role() to public;          -- harmless: names the caller's own role
grant execute on function cms.require_admin() to public;        -- checks, changes nothing
grant execute on function cms.list_users() to public;           -- checked inside
grant execute on function cms.assign_role(uuid, name) to public;
grant execute on function cms.revoke_role(uuid) to public;
grant execute on function cms.record_history(text, jsonb, int) to public;

create or replace function cms_api.list_users()
returns table (user_id uuid, email text, db_role name, granted_at timestamptz, granted_by text,
               created_at timestamptz, invited_at timestamptz, confirmed_at timestamptz,
               last_sign_in_at timestamptz, banned_until timestamptz)
language sql stable security invoker set search_path = pg_catalog as $$
  select * from cms.list_users()
$$;
comment on function cms_api.list_users() is 'Admins only: every user with e-mail, assigned role and sign-in state.';

create or replace function cms_api.assign_role(user_id uuid, role_name name) returns jsonb
language sql volatile security invoker set search_path = pg_catalog as $$
  select cms.assign_role(user_id, role_name)
$$;
comment on function cms_api.assign_role(uuid, name) is 'Admins only: map a user to a group role (takes effect with their next token). Logged in audit.change_log.';

create or replace function cms_api.revoke_role(user_id uuid) returns jsonb
language sql volatile security invoker set search_path = pg_catalog as $$
  select cms.revoke_role(user_id)
$$;
comment on function cms_api.revoke_role(uuid) is 'Admins only: remove a user''s role mapping (takes effect with their next token). Logged in audit.change_log.';

-- Invoker wrapper. An admin who reads the history through the table right (no SELECT on audit.change_log) gets it only
-- for a row they can see now: the lookup below runs with their rights, so RLS and column grants apply (step 6).
create or replace function cms_api.record_history(table_name text, row_key jsonb, max_rows int default 50)
returns table (id bigint, at timestamptz, db_role text, jwt_sub text, jwt_email text, jwt_client_id text,
               op text, changes jsonb)
language plpgsql stable security invoker set search_path = pg_catalog, pg_temp as $$
declare tbl regclass; cond text; visible boolean := false;
begin
  if record_history.table_name <> 'cms.user_roles'
     and not coalesce((select has_table_privilege(c.oid, 'SELECT') from pg_class c join pg_namespace n on n.oid = c.relnamespace
                        where n.nspname = 'audit' and c.relname = 'change_log'), false)
     and jsonb_typeof(record_history.row_key) = 'object' and record_history.row_key <> '{}' then
    begin
      tbl := to_regclass(record_history.table_name);
      select string_agg(format('%I = %L', e.key, e.value), ' and ') into cond from jsonb_each_text(record_history.row_key) e;
      if tbl is not null then
        execute format('select exists (select 1 from %s where %s)', tbl, cond) into visible;
      end if;
    exception when others then
      visible := false;
    end;
    if not visible then
      raise exception 'permission denied: % has no visible row % in %', current_user, record_history.row_key, record_history.table_name
        using errcode = '42501';
    end if;
  end if;
  return query select * from cms.record_history(record_history.table_name, record_history.row_key, record_history.max_rows);
end $$;
comment on function cms_api.record_history(text, jsonb, int) is 'Change log of one record (newest first): roles with SELECT on audit.change_log, or admins who may read the table.';

revoke all on function cms_api.list_users() from public;
revoke all on function cms_api.assign_role(uuid, name) from public;
revoke all on function cms_api.revoke_role(uuid) from public;
revoke all on function cms_api.record_history(text, jsonb, int) from public;
grant execute on function cms_api.list_users() to public;
grant execute on function cms_api.assign_role(uuid, name) to public;
grant execute on function cms_api.revoke_role(uuid) to public;
grant execute on function cms_api.record_history(text, jsonb, int) to public;

-- Which roles can an admin hand out? The ones cms.is_assignable_role() accepts, with their comment
-- and how many people have each.
create or replace function cms.list_assignable_roles()
returns table (role_name name, description text, members bigint)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform cms.require_admin();
  return query
    select g.rolname, shobj_description(g.oid, 'pg_authid'),
           (select count(*) from cms.user_roles u where u.db_role = g.rolname)
      from pg_roles g
     where cms.is_assignable_role(g.rolname)
     order by g.rolname;
end $$;
revoke all on function cms.list_assignable_roles() from public;
grant execute on function cms.list_assignable_roles() to public;      -- checked inside

create or replace function cms_api.list_assignable_roles()
returns table (role_name name, description text, members bigint)
language sql stable security invoker set search_path = pg_catalog as $$
  select * from cms.list_assignable_roles()
$$;
comment on function cms_api.list_assignable_roles() is 'Admins only: the group roles that assign_role() accepts.';
revoke all on function cms_api.list_assignable_roles() from public;
grant execute on function cms_api.list_assignable_roles() to public;

-- whoami() + can_read_audit: may this role read the change log (SELECT on audit.change_log, or an admin
-- role)? The UI shows the per-record history only then. Looked up by catalog, not by name, so a role
-- without USAGE on schema audit gets false instead of an error.
create or replace function cms_api.whoami() returns jsonb
language sql stable security invoker set search_path = pg_catalog as $$
  select jsonb_build_object(
           'role', current_user,
           'login_role', session_user,
           'user_id', c ->> 'sub',
           'email', c ->> 'email',
           'client_id', c ->> 'client_id',
           'is_admin', cms.is_admin(current_user),
           'can_read_audit', cms.is_admin(current_user) or exists (
              select 1 from pg_class t join pg_namespace n on n.oid = t.relnamespace
               where n.nspname = 'audit' and t.relname = 'change_log' and has_table_privilege(current_user, t.oid, 'SELECT')),
           'claims', c)
    from (select nullif(current_setting('request.jwt.claims', true), '')::jsonb as c) s
$$;
comment on function cms_api.whoami() is 'The signed-in role, the claims of its token, is_admin and can_read_audit.';

insert into cms.schema_version (version, description)
values (2, 'admin area: list_users, list_assignable_roles, assign_role, revoke_role, record_history, whoami().can_read_audit')
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Step 3 — files that no row references (image / file columns, hint @cms(image|file, bucket=…))
--
-- An upload can outlive its row: a form that was left without saving, a save that failed, a file
-- an MCP client uploaded and never linked. unreferenced_files() lists the objects in the buckets
-- of image / file columns that no such column points to, so an admin can link or delete them.
-- Admins only: it compares against the rows the CALLER can see (security invoker), and a row the
-- caller cannot see must never make its file look unused.
-- ════════════════════════════════════════════════════════════════════════════════════════════

create or replace function cms_api.unreferenced_files(bucket text default null)
returns table (bucket_id text, name text, size bigint, mimetype text, created_at timestamptz)
language plpgsql stable security invoker set search_path = pg_catalog, pg_temp as $$
declare
  col record;
  part text[];
  refs text[] := '{}';
  buckets text[] := '{}';
begin
  perform cms.require_admin();
  for col in
    select n.nspname as s, c.relname as t, a.attname as cname,
           substring(d.description from '@cms\([^)]*bucket\s*=\s*([A-Za-z0-9_.-]+)') as b
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_description d on d.classoid = 'pg_class'::regclass and d.objoid = c.oid and d.objsubid = a.attnum
     where c.relkind in ('r', 'p', 'v', 'm') and a.attnum > 0 and not a.attisdropped
       and d.description ~ '@cms\([^)]*\m(image|file)\M'
       and n.nspname not in ('cms', 'cms_api', 'audit', 'storage')
       and has_schema_privilege(n.oid, 'USAGE')
       and has_column_privilege(c.oid, a.attnum, 'SELECT')
  loop
    continue when col.b is null or (unreferenced_files.bucket is not null and col.b <> unreferenced_files.bucket);
    buckets := buckets || col.b;
    execute format('select array_agg(distinct %1$I::text) from %2$I.%3$I where %1$I is not null', col.cname, col.s, col.t)
      into part;
    refs := refs || coalesce(part, '{}');
  end loop;

  return query
    select o.bucket_id, o.name, (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype', o.created_at
      from storage.objects o
     where o.bucket_id = any (buckets)
       and o.name <> all (refs)
       and o.name not like '%.emptyFolderPlaceholder'
     order by o.created_at desc, o.name;
end $$;
comment on function cms_api.unreferenced_files(text) is
  'Admins: objects in the buckets of image/file columns (@cms(image|file, bucket=…)) that no visible row references.';
revoke all on function cms_api.unreferenced_files(text) from public;
grant execute on function cms_api.unreferenced_files(text) to public;

insert into cms.schema_version (version, description)
values (3, 'unreferenced_files(): uploads no image/file column points to')
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Step 4 — the second factor also guards the data, not only the UI (security review, Task 7)
--
-- The token hook (step 1) withholds the role from a person with a verified MFA factor unless the
-- token is aal2 or comes from an OAuth client the person confirmed here. The consent page calls
-- confirm_mfa_client() with its aal2 session before it approves (or follows an earlier approval).
-- Someone who only knows the password cannot: their session is aal1.
-- ════════════════════════════════════════════════════════════════════════════════════════════

create or replace function cms.confirm_mfa_client(p_authorization_id text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  uid uuid := nullif(claims ->> 'sub', '')::uuid;
  client uuid;
begin
  if uid is null or coalesce(claims ->> 'aal', '') <> 'aal2' or claims ->> 'role' is distinct from cms.caller_role()::text then
    raise exception 'confirming a program needs a session signed in with the second factor (aal2)' using errcode = '42501';
  end if;
  -- Auth binds the authorization to the person when they load it on the consent page
  select a.client_id into client from auth.oauth_authorizations a
   where a.authorization_id = p_authorization_id and a.user_id = uid and a.expires_at > now();
  if client is null then
    raise exception 'authorization % not found for this person (expired?)', p_authorization_id using errcode = 'P0002';
  end if;
  insert into cms.mfa_client_confirmations (user_id, client_id) values (uid, client)
  on conflict (user_id, client_id) do update set confirmed_at = now();
  return jsonb_build_object('client_id', client, 'confirmed', true);
end $$;
revoke all on function cms.confirm_mfa_client(text) from public;
grant execute on function cms.confirm_mfa_client(text) to public;      -- checked inside

create or replace function cms_api.confirm_mfa_client(authorization_id text) returns jsonb
language sql volatile security invoker set search_path = pg_catalog as $$
  select cms.confirm_mfa_client(authorization_id)
$$;
comment on function cms_api.confirm_mfa_client(text) is
  'Consent page, aal2 sessions only: let this OAuth client''s tokens carry the person''s role although they are aal1.';
revoke all on function cms_api.confirm_mfa_client(text) from public;
grant execute on function cms_api.confirm_mfa_client(text) to public;

insert into cms.schema_version (version, description)
values (4, 'MFA guards the data: token hook needs aal2 or a confirmed OAuth client; record_history shows readable columns only')
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Step 5 — renaming a file: which rows point at it
--
-- Renaming (moving) an object in Storage breaks every row whose image / file column still holds the
-- old path. Before the UI renames, file_references() tells it which rows to update along — the rows
-- the caller can see, with their primary key — and how many rows reference the path in total. If
-- some of them are invisible to the caller, the UI refuses: it could not update them.
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- The image / file columns (@cms(image|file, bucket=…)) of one bucket, whoever may read them. Carries the
-- relation oid and attnum so privilege checks never look a column up by name in the wrong table.
drop function if exists cms.file_columns(text);
create function cms.file_columns(p_bucket text)
returns table (schema_name name, table_name name, column_name name, relid oid, attnum smallint)
language sql stable set search_path = pg_catalog as $$
  select n.nspname, c.relname, a.attname, c.oid, a.attnum
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_description d on d.classoid = 'pg_class'::regclass and d.objoid = c.oid and d.objsubid = a.attnum
   where c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
     and d.description ~ '@cms\([^)]*\m(image|file)\M'
     and substring(d.description from '@cms\([^)]*bucket\s*=\s*([A-Za-z0-9_.-]+)') = p_bucket
     and n.nspname not in ('cms', 'cms_api', 'audit', 'storage')
$$;

-- How many rows reference a path, counted as the plugin owner (RLS and grants do not hide rows).
-- Returns only a number, never row contents.
create or replace function cms.count_file_references(p_bucket text, p_path text) returns bigint
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare col record; n bigint; total bigint := 0;
begin
  for col in select * from cms.file_columns(p_bucket) loop
    execute format('select count(*) from %I.%I where %I = $1', col.schema_name, col.table_name, col.column_name)
      into n using p_path;
    total := total + n;
  end loop;
  return total;
end $$;
revoke all on function cms.count_file_references(text, text) from public;
grant execute on function cms.count_file_references(text, text) to public;

create or replace function cms_api.file_references(bucket text, path text) returns jsonb
language plpgsql stable security invoker set search_path = pg_catalog, pg_temp as $$
declare
  col record;
  pk text[];
  refs jsonb := '[]';
  found jsonb;
begin
  for col in
    select f.* from cms.file_columns(file_references.bucket) f
     where has_schema_privilege(f.schema_name, 'USAGE')
       and has_column_privilege(f.relid, f.attnum, 'SELECT')
  loop
    select array_agg(a.attname::text order by k.ord) into pk
      from pg_index i
      cross join lateral unnest(i.indkey) with ordinality k(attnum, ord)
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
     where i.indrelid = col.relid and i.indisprimary;
    continue when pk is null or exists (select 1 from unnest(pk) p where not has_column_privilege(col.relid, p, 'SELECT'));
    execute format(
      'select coalesce(jsonb_agg(jsonb_build_object(''resource'', %L, ''column'', %L, ''key'', to_jsonb(r) - %L)), ''[]'')
         from (select %s, %I from %I.%I where %I = $1) r',
      col.schema_name || '.' || col.table_name, col.column_name, col.column_name::text,
      (select string_agg(quote_ident(p), ', ') from unnest(pk) p),
      col.column_name, col.schema_name, col.table_name, col.column_name)
      into found using file_references.path;
    refs := refs || found;
  end loop;
  return jsonb_build_object('refs', refs, 'visible', jsonb_array_length(refs),
                            'total', cms.count_file_references(file_references.bucket, file_references.path));
end $$;
comment on function cms_api.file_references(text, text) is
  'Rows (resource, column, primary key) whose image/file column holds this path and that the caller can see, plus the total count.';
revoke all on function cms_api.file_references(text, text) from public;
grant execute on function cms_api.file_references(text, text) to public;

insert into cms.schema_version (version, description)
values (5, 'file_references(): rows that point at a file, for renaming it')
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Step 6 — more hardening checks (security review, Task 7)
--   check_storage()   buckets that are public (reading bypasses every policy) or accept any file type (an SVG or HTML
--                     file opened from its storage URL runs script on that origin)
--   check_roles()     people whose mapped role is no longer assignable (their tokens fall back to authenticated), and
--                     assignable roles nobody may hand out any more under the stricter rule of step 1
-- Both only read; the fix column holds the SQL to run. record_history: see cms_api.record_history above.
-- ════════════════════════════════════════════════════════════════════════════════════════════

create or replace function cms.check_storage()
returns table (severity text, object text, finding text, fix text)
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare b record;
begin
  if to_regclass('storage.buckets') is null then return; end if;
  for b in execute 'select to_jsonb(x) as j from storage.buckets x order by x.id' loop
    if (b.j ->> 'public')::boolean then
      severity := 'warning'; object := format('storage bucket %s', b.j ->> 'id');
      finding := 'public: every file is readable without sign-in; storage policies only govern listing, upload, change and delete';
      fix := format('update storage.buckets set public = false where id = %L;', b.j ->> 'id');
      return next;
    end if;
    if b.j -> 'allowed_mime_types' is null or jsonb_typeof(b.j -> 'allowed_mime_types') = 'null'
       or exists (select 1 from jsonb_array_elements_text(b.j -> 'allowed_mime_types') t where t ~* '(svg|html|xml|javascript|\*)') then
      severity := 'info'; object := format('storage bucket %s', b.j ->> 'id');
      finding := 'accepts SVG/HTML: opened from its storage URL such a file runs script on that origin';
      fix := format('update storage.buckets set allowed_mime_types = array[''image/png'', ''image/jpeg'', ''image/webp'', ''application/pdf''] where id = %L;', b.j ->> 'id');
      return next;
    end if;
  end loop;
end $$;
revoke all on function cms.check_storage() from public;

create or replace function cms.check_roles()
returns table (severity text, object text, finding text, fix text)
language sql stable set search_path = pg_catalog, pg_temp as $$
  select 'warning', format('user %s', u.user_id), format('mapped to %s, which is not assignable (any more): their tokens carry no group role', u.db_role),
         format('select cms_api.revoke_role(%L);  -- or make %s a plain NOLOGIN group without inherited admin rights', u.user_id, u.db_role)
    from cms.user_roles u
   where not cms.is_assignable_role(u.db_role)
  order by 2
$$;
revoke all on function cms.check_roles() from public;

insert into cms.schema_version (version, description)
values (6, 'stricter assignable roles, check_storage(), check_roles(), fix_public_defaults(include_public_execute), record_history only for visible rows')
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Always last: re-apply the audit triggers from cms.settings (no-op when in sync).
select count(*) as audit_trigger_changes from cms.sync_audit();

commit;
