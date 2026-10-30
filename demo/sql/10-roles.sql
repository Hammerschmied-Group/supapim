-- Group roles with table/column rights and RLS for the demo. Idempotent; run as supabase_admin.
-- Purely additive: existing roles (anon, authenticated, service_role, postgres) are untouched.
--
-- Roles (NOLOGIN groups; Supabase Auth users get one via cms.user_roles + the access token hook):
--   cms_admin        business admins: DML on both brand schemas + public.documents + bucket images. No DDL.
--   agency_<brand>   agency per brand: reads its brand schema, may change only product names and
--                    image alt/title texts (column grants), reads its own folder in bucket images.
--   hr_editor        HR: reads the HR rows of the vector store, manages files in bucket hr-files.

begin;

do $$
declare r text;
begin
  foreach r in array array['cms_admin', 'hr_editor', 'agency_nordwind', 'agency_suedwind'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end $$;

comment on role cms_admin       is 'Group: business admins. DML on brand schemas + public.documents, no DDL.';
comment on role hr_editor       is 'Group: HR. HR rows of public.documents + storage bucket hr-files.';
comment on role agency_nordwind is 'Group: Nordwind agency. Read schema nordwind, update product names + image alt/title.';
comment on role agency_suedwind is 'Group: Südwind agency. Read schema suedwind, update product names + image alt/title.';

-- Helper: (re)create one permissive policy for one role on one table.
create or replace function pg_temp.rbac_policy(tbl regclass, rol text, cmd text, expr text default 'true')
returns void language plpgsql as $$
declare pname text := format('rbac: %s %s', rol, lower(cmd));
begin
  execute format('drop policy if exists %I on %s', pname, tbl);
  if cmd = 'SELECT' or cmd = 'DELETE' then
    execute format('create policy %I on %s for %s to %I using (%s)', pname, tbl, cmd, rol, expr);
  elsif cmd = 'INSERT' then
    execute format('create policy %I on %s for %s to %I with check (%s)', pname, tbl, cmd, rol, expr);
  else
    execute format('create policy %I on %s for %s to %I using (%s) with check (%s)', pname, tbl, cmd, rol, expr, expr);
  end if;
end $$;

-- ── cms_admin ──────────────────────────────────────────────────────────────────────────────
do $$
declare s text; t record;
begin
  foreach s in array array['nordwind', 'suedwind'] loop
    execute format('grant usage on schema %I to cms_admin', s);
    execute format('grant select, insert, update, delete on all tables in schema %I to cms_admin', s);
    execute format('grant usage, select on all sequences in schema %I to cms_admin', s);
    execute format('alter default privileges for role postgres in schema %I grant select, insert, update, delete on tables to cms_admin', s);
    execute format('alter default privileges for role postgres in schema %I grant usage, select on sequences to cms_admin', s);
    for t in select c.oid::regclass as tbl from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = s and c.relkind in ('r', 'p') and c.relrowsecurity loop
      perform pg_temp.rbac_policy(t.tbl, 'cms_admin', 'ALL');
    end loop;
  end loop;
end $$;

grant usage on schema public to cms_admin;
grant select, insert, update, delete on public.documents to cms_admin;
grant execute on function public.match_documents(extensions.vector, int, jsonb) to cms_admin;
grant usage on schema extensions to cms_admin;
select pg_temp.rbac_policy('public.documents', 'cms_admin', 'ALL');

-- ── agency_<brand> ─────────────────────────────────────────────────────────────────────────
do $$
declare b text; rol text; t record;
begin
  foreach b in array array['nordwind', 'suedwind'] loop
    rol := 'agency_' || b;
    execute format('grant usage on schema %I to %I', b, rol);
    execute format('grant select on all tables in schema %I to %I', b, rol);
    execute format('alter default privileges for role postgres in schema %I grant select on tables to %I', b, rol);
    for t in select c.oid::regclass as tbl from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = b and c.relkind in ('r', 'p') and c.relrowsecurity loop
      perform pg_temp.rbac_policy(t.tbl, rol, 'SELECT');
    end loop;
  end loop;
end $$;

-- Editable columns. Everything not listed here is read-only for agencies.
create temp table rbac_agency_columns (rol text, tbl regclass, cols text[]) on commit drop;
insert into rbac_agency_columns values
  ('agency_nordwind', 'nordwind.products',       array['name']),
  ('agency_nordwind', 'nordwind.product_images', array['alt_text', 'title_attr']),
  ('agency_suedwind', 'suedwind.products',       array['name']),
  ('agency_suedwind', 'suedwind.product_images', array['alt_text', 'title_attr']);

do $$
declare a record;
begin
  for a in select * from rbac_agency_columns loop
    execute format('grant update (%s) on %s to %I',
                   (select string_agg(quote_ident(c), ', ') from unnest(a.cols) c), a.tbl, a.rol);
    perform pg_temp.rbac_policy(a.tbl, a.rol, 'UPDATE');
  end loop;
end $$;

-- ── hr_editor ──────────────────────────────────────────────────────────────────────────────
grant usage on schema public to hr_editor;
grant select on public.documents to hr_editor;
select pg_temp.rbac_policy('public.documents', 'hr_editor', 'SELECT', $q$brand = 'hr'$q$);

-- ── storage (effective through the Storage API once a JWT carries the role) ────────────────
grant usage on schema storage to cms_admin, hr_editor, agency_nordwind, agency_suedwind;
grant select on storage.buckets to cms_admin, hr_editor, agency_nordwind, agency_suedwind;
grant select, insert, update, delete on storage.objects to cms_admin, hr_editor;
grant select on storage.objects to agency_nordwind, agency_suedwind;

select pg_temp.rbac_policy('storage.buckets', 'cms_admin', 'SELECT', $q$id = 'images'$q$);
select pg_temp.rbac_policy('storage.objects', 'cms_admin', 'ALL',    $q$bucket_id = 'images'$q$);
select pg_temp.rbac_policy('storage.buckets', 'hr_editor', 'SELECT', $q$id = 'hr-files'$q$);
select pg_temp.rbac_policy('storage.objects', 'hr_editor', 'ALL',    $q$bucket_id = 'hr-files'$q$);
select pg_temp.rbac_policy('storage.buckets', 'agency_nordwind', 'SELECT', $q$id = 'images'$q$);
select pg_temp.rbac_policy('storage.objects', 'agency_nordwind', 'SELECT', $q$bucket_id = 'images' and name like 'nordwind/%'$q$);
select pg_temp.rbac_policy('storage.buckets', 'agency_suedwind', 'SELECT', $q$id = 'images'$q$);
select pg_temp.rbac_policy('storage.objects', 'agency_suedwind', 'SELECT', $q$bucket_id = 'images' and name like 'suedwind/%'$q$);

commit;
