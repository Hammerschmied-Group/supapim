-- Plugin tests against the demo (packages/sql/install.sql + demo/sql/): permission tests, cms_api.describe() / effective_rights,
-- generic audit, hardening check. Every statement runs as the given role inside a subtransaction
-- that is always rolled back, so the data is unchanged afterwards. Run as supabase_admin:
-- scripts/test.sh (running stack) and scripts/test-sql.sh (throwaway containers, PG 15 + 17).
\set ON_ERROR_STOP 1
set client_min_messages = warning;

\o /dev/null
create temp table t_result (n serial, role text, label text, expect text, got text, ok bool, detail text);

-- p_claims simulates the JWT claims PostgREST would set (for the audit columns).
create or replace function pg_temp.t(p_role text, p_label text, p_stmt text, p_expect text,
                                     p_check text default null, p_claims text default null)
returns void language plpgsql as $$
declare got text; detail text; chk text;
begin
  begin
    if p_claims is not null then perform set_config('request.jwt.claims', p_claims, true); end if;
    execute format('set local role %I', p_role);
    execute p_stmt;
    execute 'reset role';
    if p_check is not null then execute p_check into chk; end if;
    raise exception 'T_OK:%', coalesce(chk, '');
  exception when others then
    if sqlerrm like 'T_OK:%' then got := 'allow'; detail := substr(sqlerrm, 6);
    else got := 'deny'; detail := sqlerrm; end if;
  end;
  insert into t_result (role, label, expect, got, ok, detail)
  values (p_role, p_label, p_expect, got, got = p_expect, left(detail, 140));
end $$;

\set nw_prod '''10000000-0000-4000-8000-000000000001'''
\set sw_prod '''20000000-0000-4000-8000-000000000001'''
\set agency_claims '''{"sub":"00000000-0000-4000-8000-000000000002","email":"agentur.nordwind@example.com","role":"agency_nordwind","client_id":"test-client"}'''

-- agency_nordwind
select pg_temp.t('agency_nordwind', 'read own schema',            'select count(*) from nordwind.products', 'allow');
select pg_temp.t('agency_nordwind', 'update products.name',       format('update nordwind.products set name = name || %L where id = %L', ' (t)', :nw_prod), 'allow',
  $$select 'audit_role=' || db_role || ' email=' || coalesce(jwt_email, '-') || ' client=' || coalesce(jwt_client_id, '-')
           || ' cols=' || (select string_agg(k, ',') from jsonb_object_keys(changes) k)
      from audit.change_log order by id desc limit 1$$, :agency_claims);
select pg_temp.t('agency_nordwind', 'update image alt_text',      $$update nordwind.product_images set alt_text = 'Test'$$, 'allow');
select pg_temp.t('agency_nordwind', 'update image title_attr',    $$update nordwind.product_images set title_attr = 'Test'$$, 'allow');
select pg_temp.t('agency_nordwind', 'update products.price',      format('update nordwind.products set price = 1 where id = %L', :nw_prod), 'deny');
select pg_temp.t('agency_nordwind', 'update name+price at once',  format('update nordwind.products set name = %L, price = 1 where id = %L', 'x', :nw_prod), 'deny');
select pg_temp.t('agency_nordwind', 'update faq.answer',          $$update nordwind.faq set answer = answer$$, 'deny');
select pg_temp.t('agency_nordwind', 'insert product',             $$insert into nordwind.products (sku, name, price) values ('T-1', 't', 1)$$, 'deny');
select pg_temp.t('agency_nordwind', 'delete image',               $$delete from nordwind.product_images$$, 'deny');
select pg_temp.t('agency_nordwind', 'truncate products',          'truncate nordwind.products cascade', 'deny');
select pg_temp.t('agency_nordwind', 'alter table',                'alter table nordwind.products add column t int', 'deny');
select pg_temp.t('agency_nordwind', 'read other brand',           'select count(*) from suedwind.products', 'deny');
select pg_temp.t('agency_nordwind', 'update other brand name',    $$update suedwind.products set name = 'x'$$, 'deny');
select pg_temp.t('agency_nordwind', 'read vector store',          'select count(*) from public.documents', 'deny');
select pg_temp.t('agency_nordwind', 'read audit log',             'select count(*) from audit.change_log', 'deny');
select pg_temp.t('agency_nordwind', 'read role mapping',          'select count(*) from cms.user_roles', 'deny');
select pg_temp.t('agency_nordwind', 'storage: own folder visible',  $o$do $d$ begin if (select count(*) from storage.objects where name like 'nordwind/%') = 0 then raise exception 'none visible'; end if; end $d$$o$, 'allow');
select pg_temp.t('agency_nordwind', 'storage: other brand hidden',  $o$do $d$ begin if (select count(*) from storage.objects where name not like 'nordwind/%') > 0 then raise exception 'foreign objects visible'; end if; end $d$$o$, 'allow');
select pg_temp.t('agency_nordwind', 'storage: upload image',        $$insert into storage.objects (bucket_id, name) values ('images', 'nordwind/x.png')$$, 'deny');

-- agency_suedwind
select pg_temp.t('agency_suedwind', 'update products.name',       format('update suedwind.products set name = name where id = %L', :sw_prod), 'allow');
select pg_temp.t('agency_suedwind', 'update products.price',      format('update suedwind.products set price = 1 where id = %L', :sw_prod), 'deny');
select pg_temp.t('agency_suedwind', 'update nordwind name',       $$update nordwind.products set name = 'x'$$, 'deny');

-- agency_northstar: one agency for both brands (scripts/sql/agency.sql: member of agency_nordwind + agency_suedwind)
select pg_temp.t('agency_northstar', 'multi-brand: reads both brands',      'select (select count(*) from nordwind.products) + (select count(*) from suedwind.products)', 'allow');
select pg_temp.t('agency_northstar', 'multi-brand: update name in nordwind', format('update nordwind.products set name = name || %L where id = %L', ' (t)', :nw_prod), 'allow');
select pg_temp.t('agency_northstar', 'multi-brand: update name in suedwind', format('update suedwind.products set name = name || %L where id = %L', ' (t)', :sw_prod), 'allow');
select pg_temp.t('agency_northstar', 'multi-brand: price stays read-only',  format('update suedwind.products set price = 1 where id = %L', :sw_prod), 'deny');
select pg_temp.t('agency_northstar', 'multi-brand: no insert',              $$insert into nordwind.products (sku, name, price) values ('T-KF', 'x', 1)$$, 'deny');
select pg_temp.t('agency_northstar', 'multi-brand: no HR documents',        'select count(*) from public.documents', 'deny');
select pg_temp.t('agency_northstar', 'multi-brand: storage folders of both brands, nothing else', $o$do $d$ begin
    if (select count(*) from storage.objects where name like 'nordwind/%') = 0 or (select count(*) from storage.objects where name like 'suedwind/%') = 0 then
      raise exception 'a brand folder is hidden'; end if;
    if (select count(*) from storage.objects where name not like 'nordwind/%' and name not like 'suedwind/%') > 0 then raise exception 'foreign objects visible'; end if;
  end $d$$o$, 'allow');
select pg_temp.t('supabase_admin', 'multi-brand: assignable, describe() shows both brands', $o$do $d$ begin
    if not cms.is_assignable_role('agency_northstar') then raise exception 'not assignable'; end if;
    if (select string_agg(s ->> 'name', ',' order by s ->> 'name') from jsonb_array_elements(cms.describe_role('agency_northstar') -> 'schemas') s)
       <> 'nordwind,suedwind' then raise exception 'schemas: %', cms.describe_role('agency_northstar') -> 'schemas'; end if;
  end $d$$o$, 'allow');

-- hr_editor
select pg_temp.t('hr_editor', 'read HR documents',                'select count(*) from public.documents', 'allow',
  $$select 'visible=' || count(*) || ' non_hr=' || count(*) filter (where brand <> 'hr') from public.documents$$);
select pg_temp.t('hr_editor', 'only HR rows visible',             $o$do $d$ begin if exists (select 1 from public.documents where brand <> 'hr') then raise exception 'non-HR rows visible'; end if; end $d$$o$, 'allow');
select pg_temp.t('hr_editor', 'storage: HR files visible',        $o$do $d$ begin if (select count(*) from storage.objects where bucket_id = 'hr-files') = 0 then raise exception 'none visible'; end if; end $d$$o$, 'allow');
select pg_temp.t('hr_editor', 'storage: images hidden',           $o$do $d$ begin if (select count(*) from storage.objects where bucket_id <> 'hr-files') > 0 then raise exception 'foreign objects visible'; end if; end $d$$o$, 'allow');
select pg_temp.t('hr_editor', 'storage: insert into images',      $$insert into storage.objects (bucket_id, name) values ('images', 'x.png')$$, 'deny');
select pg_temp.t('hr_editor', 'storage: insert into hr-files',    $$insert into storage.objects (bucket_id, name) values ('hr-files', 'handbuch/neu.md')$$, 'allow');
select pg_temp.t('hr_editor', 'update documents',                 $$update public.documents set content = content$$, 'deny');
select pg_temp.t('hr_editor', 'read brand schema',                'select count(*) from nordwind.products', 'deny');

-- cms_admin
select pg_temp.t('cms_admin', 'update products.price',            format('update nordwind.products set price = 99 where id = %L', :nw_prod), 'allow',
  $$select 'audit_role=' || db_role || ' cols=' || (select string_agg(k, ',') from jsonb_object_keys(changes) k) from audit.change_log order by id desc limit 1$$);
select pg_temp.t('cms_admin', 'insert + delete faq',              $$with i as (insert into suedwind.faq (question, answer) values ('q', 'a') returning id) delete from suedwind.faq where id in (select id from i)$$, 'allow');
select pg_temp.t('cms_admin', 'read audit log',                   'select count(*) from audit.change_log', 'allow');
select pg_temp.t('cms_admin', 'match_documents',                  $$select count(*) from public.match_documents((select embedding from public.documents order by id limit 1), 3)$$, 'allow');
select pg_temp.t('cms_admin', 'create table',                     'create table nordwind.t_test (id int)', 'deny');
select pg_temp.t('cms_admin', 'drop table',                       'drop table nordwind.faq', 'deny');
select pg_temp.t('cms_admin', 'grant itself a role',              $$insert into cms.user_roles values ('00000000-0000-4000-8000-000000000005', 'cms_admin')$$, 'deny');

-- token hook / role mapping guard rails
select pg_temp.t('supabase_admin', 'mapping rejects service_role', $$insert into cms.user_roles values ('00000000-0000-4000-8000-000000000005', 'service_role')$$, 'deny');
select pg_temp.t('supabase_admin', 'mapping rejects postgres',     $$insert into cms.user_roles values ('00000000-0000-4000-8000-000000000005', 'postgres')$$, 'deny');
select pg_temp.t('supabase_admin', 'mapping rejects authenticated',$$insert into cms.user_roles values ('00000000-0000-4000-8000-000000000005', 'authenticated')$$, 'deny');
select pg_temp.t('supabase_auth_admin', 'hook sets role claim',
  $o$do $d$ begin if cms.custom_access_token_hook('{"user_id":"00000000-0000-4000-8000-000000000002","claims":{"role":"authenticated"}}') #>> '{claims,role}' <> 'agency_nordwind' then raise exception 'wrong role'; end if; end $d$$o$, 'allow');
select pg_temp.t('supabase_auth_admin', 'hook leaves unmapped user',
  $o$do $d$ begin if cms.custom_access_token_hook('{"user_id":"00000000-0000-4000-8000-000000000005","claims":{"role":"authenticated"}}') #>> '{claims,role}' <> 'authenticated' then raise exception 'wrong role'; end if; end $d$$o$, 'allow');
select pg_temp.t('authenticated', 'authenticated cannot run hook',
  $$select cms.custom_access_token_hook('{"user_id":"00000000-0000-4000-8000-000000000002","claims":{}}')$$, 'deny');

-- second factor (step 4): agency_nordwind's person gets a verified TOTP factor
\set mfa_setup '$s$insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) values (gen_random_uuid(), ''00000000-0000-4000-8000-000000000002'', ''totp'', ''verified'', now(), now()); insert into auth.oauth_clients (id, registration_type, redirect_uris, grant_types, token_endpoint_auth_method) values (''c0000000-0000-4000-8000-000000000001'', ''dynamic'', ''http://localhost/cb'', ''authorization_code'', ''none''), (''c0000000-0000-4000-8000-000000000002'', ''dynamic'', ''http://localhost/cb'', ''authorization_code'', ''none'');$s$'
create or replace function pg_temp.hook_role(claims jsonb) returns text language plpgsql as $$
declare r text;
begin
  set local role supabase_auth_admin;
  r := cms.custom_access_token_hook(jsonb_build_object('user_id', '00000000-0000-4000-8000-000000000002', 'claims', claims)) #>> '{claims,role}';
  reset role;
  return r;
end $$;
select pg_temp.t('supabase_admin', 'MFA: password-only (aal1) token keeps role authenticated; aal2 gets the role',
  format($o$do $d$ begin %s
    if pg_temp.hook_role('{"role":"authenticated","aal":"aal1"}') <> 'authenticated' then raise exception 'aal1 got the role'; end if;
    if pg_temp.hook_role('{"role":"authenticated"}') <> 'authenticated' then raise exception 'no aal got the role'; end if;
    if pg_temp.hook_role('{"role":"authenticated","aal":"aal2"}') <> 'agency_nordwind' then raise exception 'aal2 without role'; end if;
  end $d$$o$, :mfa_setup), 'allow');
select pg_temp.t('supabase_admin', 'MFA: an OAuth token (always aal1) needs a confirmed client, by claim or by session',
  format($o$do $d$ declare sid uuid := gen_random_uuid(); begin %s
    insert into auth.sessions (id, user_id, oauth_client_id) values (sid, '00000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001');
    if pg_temp.hook_role('{"role":"authenticated","aal":"aal1","client_id":"c0000000-0000-4000-8000-000000000001"}') <> 'authenticated' then raise exception 'unconfirmed client got the role'; end if;
    insert into cms.mfa_client_confirmations (user_id, client_id) values ('00000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001');
    if pg_temp.hook_role('{"role":"authenticated","aal":"aal1","client_id":"c0000000-0000-4000-8000-000000000001"}') <> 'agency_nordwind' then raise exception 'confirmed client without role'; end if;
    if pg_temp.hook_role(jsonb_build_object('role', 'authenticated', 'aal', 'aal1', 'session_id', sid)) <> 'agency_nordwind' then raise exception 'session lookup failed'; end if;
    if pg_temp.hook_role('{"role":"authenticated","aal":"aal1","client_id":"c0000000-0000-4000-8000-000000000002"}') <> 'authenticated' then raise exception 'other client got the role'; end if;
  end $d$$o$, :mfa_setup), 'allow');
select pg_temp.t('supabase_admin', 'MFA: an unverified factor changes nothing',
  $o$do $d$ begin
    insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) values (gen_random_uuid(), '00000000-0000-4000-8000-000000000002', 'totp', 'unverified', now(), now());
    if pg_temp.hook_role('{"role":"authenticated","aal":"aal1"}') <> 'agency_nordwind' then raise exception 'role withheld'; end if;
  end $d$$o$, 'allow');
\set mfa_auth '$s$insert into auth.oauth_authorizations (id, authorization_id, client_id, user_id, redirect_uri, scope) values (gen_random_uuid(), ''auth-own'', ''c0000000-0000-4000-8000-000000000001'', ''00000000-0000-4000-8000-000000000002'', ''http://localhost/cb'', ''openid''), (gen_random_uuid(), ''auth-other'', ''c0000000-0000-4000-8000-000000000002'', ''00000000-0000-4000-8000-000000000003'', ''http://localhost/cb'', ''openid'');$s$'
\set aal1_claims '''{"sub":"00000000-0000-4000-8000-000000000002","role":"agency_nordwind","aal":"aal1"}'''
\set aal2_claims '''{"sub":"00000000-0000-4000-8000-000000000002","role":"agency_nordwind","aal":"aal2"}'''
create or replace function pg_temp.confirm_as(claims text, auth_id text) returns jsonb language plpgsql as $$
declare j jsonb;
begin
  perform set_config('request.jwt.claims', claims, true);
  set local role agency_nordwind;
  j := cms_api.confirm_mfa_client(auth_id);
  reset role;
  return j;
end $$;
select pg_temp.t('supabase_admin', 'confirm_mfa_client: aal2 session confirms its own authorization''s client',
  format($o$do $d$ begin %s %s
    perform pg_temp.confirm_as(%L, 'auth-own');
    if not exists (select 1 from cms.mfa_client_confirmations where user_id = '00000000-0000-4000-8000-000000000002' and client_id = 'c0000000-0000-4000-8000-000000000001') then raise exception 'not stored'; end if;
  end $d$$o$, :mfa_setup, :mfa_auth, :aal2_claims), 'allow');
select pg_temp.t('supabase_admin', 'confirm_mfa_client: password-only (aal1) session is refused',
  format($o$do $d$ begin %s %s perform pg_temp.confirm_as(%L, 'auth-own'); end $d$$o$, :mfa_setup, :mfa_auth, :aal1_claims), 'deny');
select pg_temp.t('supabase_admin', 'confirm_mfa_client: someone else''s authorization is refused',
  format($o$do $d$ begin %s %s perform pg_temp.confirm_as(%L, 'auth-other'); end $d$$o$, :mfa_setup, :mfa_auth, :aal2_claims), 'deny');
select pg_temp.t('supabase_admin', 'confirm_mfa_client: claims of another role than the session''s are refused',
  format($o$do $d$ begin %s %s perform pg_temp.confirm_as(%L, 'auth-own'); end $d$$o$, :mfa_setup, :mfa_auth,
    '{"sub":"00000000-0000-4000-8000-000000000002","role":"cms_admin","aal":"aal2"}'), 'deny');
select pg_temp.t('agency_nordwind', 'confirmations are not readable by API roles', 'select count(*) from cms.mfa_client_confirmations', 'deny');

-- stock API roles have no access to the demo
select pg_temp.t('anon',          'anon read brand schema',       'select count(*) from nordwind.products', 'deny');
select pg_temp.t('anon',          'anon read documents',          'select count(*) from public.documents', 'deny');
select pg_temp.t('anon',          'anon cannot execute match_*',  $o$do $d$ begin if exists (select 1 from pg_proc where proname = 'match_documents' and has_function_privilege('anon', oid, 'EXECUTE')) then raise exception 'anon can execute'; end if; end $d$$o$, 'allow');
select pg_temp.t('authenticated', 'unmapped user read brand',     'select count(*) from nordwind.products', 'deny');
create table public.t_new_table (id int);   -- like a new table created in Studio
select pg_temp.t('anon',          'anon on NEW public table',     'select count(*) from public.t_new_table', 'deny');
select pg_temp.t('authenticated', 'authenticated on NEW public table', 'insert into public.t_new_table values (1)', 'deny');
select pg_temp.t('service_role',  'service_role on NEW public table',  'insert into public.t_new_table values (1)', 'allow');
drop table public.t_new_table;
select pg_temp.t('service_role',  'service_role update name',     format('update nordwind.products set name = name || %L where id = %L', ' ', :nw_prod), 'allow',
  $$select 'audit_role=' || db_role || ' login=' || login_role from audit.change_log order by id desc limit 1$$);


-- ── cms_api.describe(): what each role sees — the contract UI (Task 5) and MCP (Task 4) use ──
-- pg_temp.yes(cond) → a DO block that fails unless cond is true (evaluated as the test's role).
create or replace function pg_temp.yes(cond text) returns text language sql as $f$
  select format('do $d$ begin if not coalesce((%s), false) then raise exception %L; end if; end $d$', cond, 'expected: ' || cond)
$f$;

select pg_temp.t('agency_nordwind', 'describe: products.name updatable',
  pg_temp.yes($$cms_api.describe() @? '$.schemas[*] ? (@.name == "nordwind").tables[*] ? (@.name == "products").columns[*] ? (@.name == "name" && @.privileges.select == true && @.privileges.update == true)'$$), 'allow');
select pg_temp.t('agency_nordwind', 'describe: products.price read-only',
  pg_temp.yes($$cms_api.describe() @? '$.schemas[*] ? (@.name == "nordwind").tables[*] ? (@.name == "products").columns[*] ? (@.name == "price" && @.privileges.select == true && @.privileges.update == false && @.privileges.insert == false)'$$), 'allow');
select pg_temp.t('agency_nordwind', 'describe: no insert/delete on products',
  pg_temp.yes($$cms_api.describe() @? '$.schemas[*] ? (@.name == "nordwind").tables[*] ? (@.name == "products" && @.privileges.insert == false && @.privileges.delete == false && @.privileges.update == true)'$$), 'allow');
select pg_temp.t('agency_nordwind', 'describe: PK, unique, enum, nullable, default, RLS',
  pg_temp.yes($$cms_api.describe() @? '$.schemas[*] ? (@.name == "nordwind").tables[*] ? (@.name == "products" && @.primary_key[0] == "id" && @.rls.enabled == true && @.unique[0][0] == "sku").columns[*] ? (@.name == "status" && @.category == "enum" && @.enum[2] == "archived" && @.nullable == false && @.default starts with "''active''")'$$), 'allow');
select pg_temp.t('agency_nordwind', 'describe: FK product_images → products',
  pg_temp.yes($$cms_api.describe() @? '$.schemas[*] ? (@.name == "nordwind").tables[*] ? (@.name == "product_images").foreign_keys[*] ? (@.columns[0] == "product_id" && @.references.table == "products" && @.references.columns[0] == "id" && @.on_delete == "cascade")'$$), 'allow');
select pg_temp.t('agency_nordwind', 'describe: own policies listed',
  pg_temp.yes($$cms_api.describe() @? '$.schemas[*] ? (@.name == "nordwind").tables[*] ? (@.name == "products").rls.policies[*] ? (@.name == "rbac: agency_nordwind update" && @.command == "update")'$$), 'allow');
select pg_temp.t('agency_nordwind', 'describe: other brand + vector store hidden',
  pg_temp.yes($$(select jsonb_agg(s ->> 'name') from jsonb_array_elements(cms_api.describe() -> 'schemas') s) = '["nordwind"]'$$), 'allow');
select pg_temp.t('agency_nordwind', 'describe: bucket images only, read-only',
  pg_temp.yes($$(select jsonb_agg(b ->> 'id') from jsonb_array_elements(cms_api.describe() #> '{storage,buckets}') b) = '["images"]'
                and cms_api.describe() @? '$.storage ? (@.object_privileges.select == true && @.object_privileges.insert == false)'$$), 'allow');
select pg_temp.t('agency_nordwind', 'describe: not admin',
  pg_temp.yes($$(cms_api.describe() ->> 'is_admin')::boolean = false$$), 'allow');
select pg_temp.t('agency_nordwind', 'whoami: role + claims',
  pg_temp.yes($$cms_api.whoami() @? '$ ? (@.role == "agency_nordwind" && @.email == "agentur.nordwind@example.com" && @.client_id == "test-client")'$$), 'allow',
  null, :agency_claims);
select pg_temp.t('agency_nordwind', 'effective_rights of another role',  $$select cms_api.effective_rights('cms_admin')$$, 'deny');
select pg_temp.t('agency_nordwind', 'cms.effective_rights directly',     $$select cms.effective_rights('cms_admin')$$, 'deny');
select pg_temp.t('agency_nordwind', 'read cms.settings',                 'select * from cms.settings', 'deny');

select pg_temp.t('hr_editor', 'describe: documents read-only, HR policy',
  pg_temp.yes($$cms_api.describe() @? '$.schemas[*] ? (@.name == "public").tables[*] ? (@.name == "documents" && @.privileges.select == true && @.privileges.update == false && @.privileges.delete == false && @.rls.policies[0].using like_regex "hr")'$$), 'allow');
select pg_temp.t('hr_editor', 'describe: only schema public, no match_documents',
  pg_temp.yes($$(select jsonb_agg(s ->> 'name') from jsonb_array_elements(cms_api.describe() -> 'schemas') s) = '["public"]'
                and not (cms_api.describe() @? '$.schemas[*].functions[*] ? (@.name == "match_documents")')$$), 'allow');
select pg_temp.t('hr_editor', 'describe: bucket hr-files only, writable',
  pg_temp.yes($$(select jsonb_agg(b ->> 'id') from jsonb_array_elements(cms_api.describe() #> '{storage,buckets}') b) = '["hr-files"]'
                and cms_api.describe() @? '$.storage ? (@.object_privileges.insert == true && @.object_privileges.delete == true)'$$), 'allow');

select pg_temp.t('cms_admin', 'describe: price updatable, delete allowed',
  pg_temp.yes($$cms_api.describe() @? '$.schemas[*] ? (@.name == "nordwind").tables[*] ? (@.name == "products" && @.privileges.delete == true).columns[*] ? (@.name == "price" && @.privileges.update == true)'$$), 'allow');
select pg_temp.t('cms_admin', 'describe: match_documents executable, is admin',
  pg_temp.yes($$cms_api.describe() @? '$ ? (@.is_admin == true).schemas[*] ? (@.name == "public").functions[*] ? (@.name == "match_documents" && @.security_definer == false)'$$), 'allow');
select pg_temp.t('cms_admin', 'effective_rights(agency_nordwind)',
  pg_temp.yes($$cms_api.effective_rights('agency_nordwind') @? '$.schemas[*] ? (@.name == "nordwind").tables[*] ? (@.name == "products").columns[*] ? (@.name == "price" && @.privileges.update == false)'
                and (select jsonb_agg(b ->> 'id') from jsonb_array_elements(cms_api.effective_rights('agency_nordwind') #> '{storage,buckets}') b) = '["images"]'$$), 'allow');
select pg_temp.t('cms_admin', 'effective_rights(unknown role)',     $$select cms_api.effective_rights('no_such_role')$$, 'deny');
select pg_temp.t('service_role', 'effective_rights as service_role', $$select cms_api.effective_rights('hr_editor')$$, 'allow');
select pg_temp.t('supabase_admin', 'effective_rights = the role''s own describe()',
  $o$do $d$ declare own jsonb; adm jsonb; r text;
  begin
    foreach r in array array['agency_nordwind', 'agency_suedwind', 'hr_editor', 'cms_admin'] loop
      execute format('set local role %I', r);
      own := cms_api.describe();
      reset role;
      adm := cms.effective_rights(r::name);
      if own -> 'schemas' is distinct from adm -> 'schemas'
         or (select jsonb_agg(b ->> 'id') from jsonb_array_elements(own #> '{storage,buckets}') b)
            is distinct from (select jsonb_agg(b ->> 'id') from jsonb_array_elements(adm #> '{storage,buckets}') b) then
        raise exception 'differs for %', r;
      end if;
    end loop;
  end $d$$o$, 'allow');
select pg_temp.t('authenticated', 'describe: unmapped user sees nothing',
  pg_temp.yes($$cms_api.describe() -> 'schemas' = '[]'$$), 'allow');
select pg_temp.t('anon', 'describe: anon denied',                  'select cms_api.describe()', 'deny');

-- ── admin area (step 2): list_users, assign_role, revoke_role, record_history ───────────────
\set admin_claims '''{"sub":"00000000-0000-4000-8000-000000000001","email":"admin@example.com","role":"cms_admin","client_id":"ui"}'''
\set agency_claims_2 '''{"sub":"00000000-0000-4000-8000-000000000002","email":"agentur.nordwind@example.com","role":"agency_nordwind"}'''
\set norole_user '''00000000-0000-4000-8000-000000000005'''

select pg_temp.t('cms_admin', 'list_users: e-mail + role',
  pg_temp.yes($$exists (select 1 from cms_api.list_users() where email = 'agentur.nordwind@example.com' and db_role = 'agency_nordwind')
                and exists (select 1 from cms_api.list_users() where email = 'ohne.rolle@example.com' and db_role is null)$$), 'allow');
select pg_temp.t('agency_nordwind', 'list_users denied',            'select * from cms_api.list_users()', 'deny');
select pg_temp.t('hr_editor',       'list_users denied (cms.*)',    'select * from cms.list_users()', 'deny');
select pg_temp.t('authenticated',   'list_users denied',            'select * from cms_api.list_users()', 'deny');
select pg_temp.t('anon',            'list_users denied',            'select * from cms_api.list_users()', 'deny');
select pg_temp.t('service_role',    'list_users as service_role',   'select * from cms_api.list_users()', 'allow');

select pg_temp.t('cms_admin', 'assign_role: new mapping, logged with admin e-mail',
  format($$select cms_api.assign_role(%L, 'hr_editor')$$, :norole_user), 'allow',
  $$select 'op=' || op || ' table=' || table_name || ' by=' || jwt_email || ' client=' || jwt_client_id || ' target=' || (changes ->> 'email')
           || ' role=' || (changes ->> 'db_role') || ' key=' || (row_key ->> 'user_id') ||
           ' granted_by=' || (select granted_by from cms.user_roles where user_id = '00000000-0000-4000-8000-000000000005')
      from audit.change_log order by id desc limit 1$$, :admin_claims);
select pg_temp.t('supabase_admin', 'assign_role: token hook picks it up; role change logged as UPDATE old → new; same role is a no-op',
  format($o$do $d$ declare before bigint := (select count(*) from audit.change_log where table_name = 'cms.user_roles'); begin
    perform set_config('request.jwt.claims', %2$L, true);
    set local role cms_admin;
    perform cms_api.assign_role(%1$L, 'hr_editor');
    perform cms_api.assign_role(%1$L, 'hr_editor');
    reset role;
    if cms.custom_access_token_hook(jsonb_build_object('user_id', %1$L, 'claims', jsonb_build_object('role', 'authenticated'))) #>> '{claims,role}' <> 'hr_editor'
      then raise exception 'hook did not map'; end if;
    if (select count(*) from audit.change_log where table_name = 'cms.user_roles') <> before + 1 then raise exception 'no-op was logged'; end if;
    set local role cms_admin;
    perform cms_api.assign_role(%1$L, 'agency_suedwind');
    reset role;
    if (select changes::text from audit.change_log order by id desc limit 1)
       <> '{"email": "ohne.rolle@example.com", "db_role": {"new": "agency_suedwind", "old": "hr_editor"}}' then
      raise exception 'wrong UPDATE row: %%', (select changes::text from audit.change_log order by id desc limit 1); end if;
  end $d$$o$, :norole_user, :admin_claims), 'allow');
select pg_temp.t('cms_admin', 'revoke_role: removes mapping, logged as DELETE',
  format($$select cms_api.assign_role(%1$L, 'hr_editor'), cms_api.revoke_role(%1$L)$$, :norole_user), 'allow',
  $$select 'op=' || op || ' by=' || jwt_email || ' role=' || (changes ->> 'db_role') || ' mapped=' ||
           exists (select 1 from cms.user_roles where user_id = '00000000-0000-4000-8000-000000000005')
      from audit.change_log order by id desc limit 1$$, :admin_claims);
select pg_temp.t('cms_admin', 'revoke_role: unmapped user is a no-op',
  format($$select cms_api.revoke_role(%L)$$, :norole_user), 'allow');
select pg_temp.t('cms_admin', 'assign_role: not your own role',
  $$select cms_api.assign_role('00000000-0000-4000-8000-000000000001', 'hr_editor')$$, 'deny', null, :admin_claims);
select pg_temp.t('cms_admin', 'revoke_role: not your own role',
  $$select cms_api.revoke_role('00000000-0000-4000-8000-000000000001')$$, 'deny', null, :admin_claims);
select pg_temp.t('cms_admin', 'assign_role rejects service_role',   format($$select cms_api.assign_role(%L, 'service_role')$$, :norole_user), 'deny');
select pg_temp.t('cms_admin', 'assign_role rejects authenticated',  format($$select cms_api.assign_role(%L, 'authenticated')$$, :norole_user), 'deny');
select pg_temp.t('cms_admin', 'assign_role rejects postgres',       format($$select cms_api.assign_role(%L, 'postgres')$$, :norole_user), 'deny');
select pg_temp.t('cms_admin', 'assign_role rejects unknown role',   format($$select cms_api.assign_role(%L, 'no_such_role')$$, :norole_user), 'deny');
select pg_temp.t('cms_admin', 'assign_role rejects unknown user',   $$select cms_api.assign_role('99999999-0000-4000-8000-000000000009', 'hr_editor')$$, 'deny');
select pg_temp.t('cms_admin', 'cms.user_roles still not writable directly', format($$update cms.user_roles set db_role = 'hr_editor' where user_id = %L$$, :norole_user), 'deny');
select pg_temp.t('agency_nordwind', 'assign_role denied',           format($$select cms_api.assign_role(%L, 'agency_nordwind')$$, :norole_user), 'deny');
select pg_temp.t('agency_nordwind', 'assign_role denied (cms.*)',   format($$select cms.assign_role(%L, 'agency_nordwind')$$, :norole_user), 'deny');
select pg_temp.t('hr_editor',       'revoke_role denied',           format($$select cms_api.revoke_role(%L)$$, '00000000-0000-4000-8000-000000000002'), 'deny');
select pg_temp.t('authenticated',   'assign_role denied',           format($$select cms_api.assign_role(%L, 'hr_editor')$$, :norole_user), 'deny');
select pg_temp.t('anon',            'assign_role denied',           format($$select cms_api.assign_role(%L, 'hr_editor')$$, :norole_user), 'deny');
select pg_temp.t('agency_nordwind', 'admin claims in the token do not make an admin (the role decides)',
  format($$select cms_api.assign_role(%L, 'hr_editor')$$, :norole_user), 'deny', null, :admin_claims);

select pg_temp.t('cms_admin', 'list_assignable_roles: the demo group roles, no service_role/authenticated',
  pg_temp.yes($$(select array_agg(role_name order by role_name) from cms_api.list_assignable_roles()) @> array['agency_nordwind', 'hr_editor', 'cms_admin']::name[]
                and not exists (select 1 from cms_api.list_assignable_roles() where role_name in ('service_role', 'authenticated', 'anon', 'postgres'))
                and (select members from cms_api.list_assignable_roles() where role_name = 'agency_nordwind') = 1$$), 'allow');
select pg_temp.t('agency_nordwind', 'list_assignable_roles denied', 'select * from cms_api.list_assignable_roles()', 'deny');
select pg_temp.t('anon',            'list_assignable_roles denied', 'select * from cms_api.list_assignable_roles()', 'deny');
select pg_temp.t('cms_admin', 'whoami: can_read_audit for the admin role',
  pg_temp.yes($$cms_api.whoami() @? '$ ? (@.is_admin == true && @.can_read_audit == true)'$$), 'allow');
select pg_temp.t('agency_nordwind', 'whoami: no audit for an agency (and no error without USAGE on audit)',
  pg_temp.yes($$cms_api.whoami() @? '$ ? (@.is_admin == false && @.can_read_audit == false)'$$), 'allow');
select pg_temp.t('supabase_admin', 'whoami: SELECT on the log without the admin right → can_read_audit',
  $o$do $d$ begin
    grant usage on schema audit to hr_editor; grant select on audit.change_log to hr_editor;
    set local role hr_editor;
    if not (cms_api.whoami() @? '$ ? (@.is_admin == false && @.can_read_audit == true)') then raise exception 'not readable'; end if;
  end $d$$o$, 'allow');

-- record_history
select pg_temp.t('supabase_admin', 'record_history: admin reads a record''s log (string key, newest first)',
  format($o$do $d$ declare n int; before int := (select count(*) from cms.record_history('nordwind.products', jsonb_build_object('id', %1$L))); first_mail text; first_change text; begin
    perform set_config('request.jwt.claims', %2$L, true);
    set local role agency_nordwind;
    update nordwind.products set name = name || ' A' where id = %1$L;
    update nordwind.products set name = name || ' B' where id = %1$L;
    reset role;
    set local role cms_admin;
    select count(*), (array_agg(jwt_email order by at desc, id desc))[1], (array_agg(changes -> 'name' ->> 'new' order by at desc, id desc))[1]
      into n, first_mail, first_change
      from cms_api.record_history('nordwind.products', jsonb_build_object('id', %1$L));
    reset role;
    if n - before <> 2 or first_mail <> 'agentur.nordwind@example.com' or first_change not like '%% B' then
      raise exception 'got n=%%, mail=%%, change=%%', n, first_mail, first_change; end if;
  end $d$$o$, :nw_prod, :agency_claims_2), 'allow');
select pg_temp.t('supabase_admin', 'record_history: other record / other table / extra key → empty; limit honoured',
  format($o$do $d$ begin
    set local role agency_nordwind;
    update nordwind.products set name = name || ' A' where id = %1$L;
    update nordwind.products set name = name || ' B' where id = %1$L;
    reset role;
    set local role cms_admin;
    if exists (select 1 from cms_api.record_history('nordwind.products', '{"id": "no-such-id"}')) then raise exception 'other id'; end if;
    if exists (select 1 from cms_api.record_history('suedwind.products', jsonb_build_object('id', %1$L))) then raise exception 'other table'; end if;
    if exists (select 1 from cms_api.record_history('nordwind.products', jsonb_build_object('id', %1$L, 'extra', 1))) then raise exception 'extra key matched'; end if;
    if (select count(*) from cms_api.record_history('nordwind.products', jsonb_build_object('id', %1$L), 1)) <> 1 then raise exception 'limit'; end if;
  end $d$$o$, :nw_prod), 'allow');
select pg_temp.t('cms_admin', 'record_history: key must be an object',    $$select * from cms_api.record_history('nordwind.products', '[]')$$, 'deny');
select pg_temp.t('cms_admin', 'record_history: role assignments (cms.user_roles)',
  format($$select cms_api.assign_role(%1$L, 'hr_editor'); select 1 / (select count(*) from cms_api.record_history('cms.user_roles', jsonb_build_object('user_id', %1$L)))$$, :norole_user), 'allow', null, :admin_claims);
select pg_temp.t('agency_nordwind', 'record_history denied',               format($$select * from cms_api.record_history('nordwind.products', jsonb_build_object('id', %L))$$, :nw_prod), 'deny');
select pg_temp.t('authenticated',   'record_history denied',               $$select * from cms_api.record_history('nordwind.products', '{"id": "x"}')$$, 'deny');
select pg_temp.t('anon',            'record_history denied',               $$select * from cms_api.record_history('nordwind.products', '{"id": "x"}')$$, 'deny');
select pg_temp.t('supabase_admin', 'record_history: admin role without audit grant sees only tables it may read',
  $o$do $d$ begin
    update cms.settings set admin_roles = '{cms_admin,hr_editor}';              -- hr_editor: admin, but no grant on audit.change_log
    if has_table_privilege('hr_editor', 'audit.change_log', 'SELECT') then raise exception 'hr_editor can read the log directly'; end if;
    set local role hr_editor;
    perform 1 from cms_api.record_history('public.documents',                     -- may read (its HR) documents → allowed
      jsonb_build_object('id', (select id from public.documents where brand = 'hr' order by id limit 1)));
    perform 1 from cms_api.record_history('cms.user_roles', '{"user_id": "x"}');  -- role assignments need the admin right only
    begin
      perform 1 from cms_api.record_history('nordwind.products', '{"id": "x"}');
      raise exception 'read a table it may not read';
    exception when insufficient_privilege then null; end;
    begin
      perform 1 from cms_api.record_history('no.such_table', '{"id": "x"}');
      raise exception 'unknown table';
    exception when insufficient_privilege then null; end;
  end $d$$o$, 'allow');
select pg_temp.t('supabase_admin', 'record_history: SELECT on the log is enough, without the admin right',
  $o$do $d$ begin
    grant usage on schema audit to hr_editor;
    grant select on audit.change_log to hr_editor;
    set local role hr_editor;
    perform 1 from cms_api.record_history('nordwind.products', '{"id": "x"}');
    begin perform cms_api.assign_role('00000000-0000-4000-8000-000000000005', 'hr_editor'); raise exception 'assigned';
    exception when insufficient_privilege then null; end;
  end $d$$o$, 'allow');

-- ── generic audit ───────────────────────────────────────────────────────────────────────────
select pg_temp.t('supabase_admin', 'audit: row_key = primary key',
  format($o$do $d$ begin
    set local role agency_nordwind;
    update nordwind.products set name = name || '!' where id = %1$L;
    reset role;
    if (select row_key from audit.change_log order by id desc limit 1) <> jsonb_build_object('id', %1$L) then raise exception 'wrong row_key'; end if;
  end $d$$o$, :nw_prod), 'allow');
select pg_temp.t('supabase_admin', 'audit: composite PK + new table via sync_audit',
  $o$do $d$ begin
    create table nordwind.t_pk (a int, b text, v text, primary key (a, b));
    if (select count(*) from cms.sync_audit()) <> 1 then raise exception 'trigger not added'; end if;
    insert into nordwind.t_pk values (1, 'x', 'v');
    update nordwind.t_pk set v = 'w';
    if (select row_key::text || ' ' || changes::text from audit.change_log order by id desc limit 1)
       <> '{"a": 1, "b": "x"} {"v": {"new": "w", "old": "v"}}' then raise exception 'wrong log row'; end if;
  end $d$$o$, 'allow');
select pg_temp.t('supabase_admin', 'audit: only updated_at changed → not logged',
  format($o$do $d$ declare before bigint := (select count(*) from audit.change_log); begin
    update nordwind.products set name = name where id = %L;   -- moddatetime bumps updated_at only
    if (select count(*) from audit.change_log) <> before then raise exception 'logged'; end if;
  end $d$$o$, :nw_prod), 'allow');
select pg_temp.t('supabase_admin', 'audit: ignore list from cms.settings',
  format($o$do $d$ declare before bigint := (select count(*) from audit.change_log); begin
    update cms.settings set audit_ignore_columns = '{updated_at,description}';
    update nordwind.products set description = 'ignored' where id = %L;
    if (select count(*) from audit.change_log) <> before then raise exception 'logged'; end if;
  end $d$$o$, :nw_prod), 'allow');
select pg_temp.t('supabase_admin', 'audit: failing log never blocks the write',
  format($o$do $d$ begin
    set local client_min_messages = error;
    alter table audit.change_log add constraint t_block check (false) not valid;
    set local role cms_admin;
    update nordwind.products set price = 42 where id = %1$L;
    reset role;
    if (select price from nordwind.products where id = %1$L) <> 42 then raise exception 'write blocked'; end if;
  end $d$$o$, :nw_prod), 'allow');
select pg_temp.t('supabase_admin', 'audit: disable_audit / enable_audit',
  $o$do $d$ begin
    perform cms.disable_audit('nordwind.faq');
    if exists (select 1 from pg_trigger where tgrelid = 'nordwind.faq'::regclass and tgname = 'zz_audit_log_change') then raise exception 'still on'; end if;
    if not (select 'nordwind.faq' = any (audit_exclude) from cms.settings) then raise exception 'not excluded'; end if;
    perform cms.enable_audit('nordwind.faq');
    if not exists (select 1 from pg_trigger where tgrelid = 'nordwind.faq'::regclass and tgname = 'zz_audit_log_change') then raise exception 'not back on'; end if;
  end $d$$o$, 'allow');
select pg_temp.t('supabase_admin', 'audit: triggers in sync with settings',
  -- one trigger per table in the audited schemas (6 in the demo, more once brands are bootstrapped)
  pg_temp.yes($$(select count(*) from cms.sync_audit()) = 0
    and (select count(*) from pg_trigger where tgname = 'zz_audit_log_change')
      = (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p') and not c.relispartition
            and n.nspname = any (coalesce((select audit_schemas from cms.settings), '{}')))
    and (select count(*) from pg_trigger where tgname = 'zz_audit_log_change') >= 6$$), 'allow');

-- ── unreferenced files (step 3) ────────────────────────────────────────────────────────────
select pg_temp.t('supabase_admin', 'unreferenced_files: admin sees an upload no row points to, not the linked ones',
  $o$do $d$ declare got text[]; begin
    insert into storage.objects (bucket_id, name, metadata) values ('images', 'nordwind/orphan-test.png', '{"size": 3, "mimetype": "image/png"}');
    set local role cms_admin;
    select array_agg(name order by name) into got from cms_api.unreferenced_files();
    reset role;
    -- other unlinked uploads may exist in a live stack; the test's own one must be there, linked demo files must not
    if not ('nordwind/orphan-test.png' = any (got)) or got && array['nordwind/regenjacke.png', 'nordwind/fleece.png', 'suedwind/sonnencreme.png', 'suedwind/after-sun.png']
      then raise exception 'got %', got; end if;
  end $d$$o$, 'allow');
select pg_temp.t('supabase_admin', 'unreferenced_files: bucket filter',
  $o$do $d$ declare n int; begin
    insert into storage.objects (bucket_id, name) values ('images', 'suedwind/orphan-test.png');
    set local role cms_admin;
    select count(*) into n from cms_api.unreferenced_files('hr-files');
    reset role;
    if n <> 0 then raise exception 'hr-files has no image column, got %', n; end if;
  end $d$$o$, 'allow');
select pg_temp.t('supabase_admin', 'record_history: an admin without SELECT on a column does not see it in the history',
  format($o$do $d$ declare ch jsonb; begin
    create role t_limited_admin nologin;
    grant usage on schema nordwind to t_limited_admin;
    grant select (id, name) on nordwind.products to t_limited_admin;
    create policy t_limited_admin_read on nordwind.products for select to t_limited_admin using (true);
    update cms.settings set admin_roles = admin_roles || '{t_limited_admin}'::name[];
    update nordwind.products set price = price + 1, name = name || ' (h)' where id = %1$L;
    set local role t_limited_admin;
    select changes into ch from cms_api.record_history('nordwind.products', jsonb_build_object('id', %1$L), 1);
    reset role;
    if ch ? 'price' or not ch ? 'name' then raise exception 'limited admin got %%', ch; end if;
    set local role cms_admin;   -- may read the whole log (SELECT on audit.change_log): sees every column
    select changes into ch from cms_api.record_history('nordwind.products', jsonb_build_object('id', %1$L), 1);
    reset role;
    if not ch ? 'price' then raise exception 'log reader lost a column: %%', ch; end if;
  end $d$$o$, :nw_prod), 'allow');
select pg_temp.t('supabase_admin', 'record_history: an admin who cannot see the row (RLS) gets no history of it',
  format($o$do $d$ begin
    create role t_limited_admin nologin;
    grant usage on schema nordwind to t_limited_admin;
    grant select (id, name) on nordwind.products to t_limited_admin;      -- no policy: RLS hides every row
    update cms.settings set admin_roles = admin_roles || '{t_limited_admin}'::name[];
    update nordwind.products set name = name || ' (h)' where id = %1$L;
    set local role t_limited_admin;
    perform count(*) from cms_api.record_history('nordwind.products', jsonb_build_object('id', %1$L));
  end $d$$o$, :nw_prod), 'deny');

-- ── step 5: stricter assignable roles, check_roles(), check_storage(), include_public_execute ─────────
select pg_temp.t('supabase_admin', 'assignable: not a role that inherits pg_read_all_data or may create roles',
  $o$do $d$ begin
    create role t_wide nologin; grant pg_read_all_data to t_wide; grant t_wide to authenticator;
    create role t_creator nologin createrole; grant t_creator to authenticator;
    create role t_plain nologin; grant t_plain to authenticator;
    if cms.is_assignable_role('t_wide') or cms.is_assignable_role('t_creator') then raise exception 'too wide a role is assignable'; end if;
    if not cms.is_assignable_role('t_plain') then raise exception 'plain group refused'; end if;
  end $d$$o$, 'allow');
select pg_temp.t('supabase_admin', 'check_roles: a mapping whose role became too wide is reported (and the hook drops it)',
  $o$do $d$ begin
    create role t_plain nologin; grant t_plain to authenticator;
    insert into cms.user_roles (user_id, db_role) values ('00000000-0000-4000-8000-000000000005', 't_plain');
    if exists (select 1 from cms.check_roles()) then raise exception 'reported too early'; end if;
    grant pg_read_all_data to t_plain;
    if not exists (select 1 from cms.check_roles() where finding like 'mapped to t_plain%') then raise exception 'not reported'; end if;
    set local role supabase_auth_admin;
    if cms.custom_access_token_hook('{"user_id":"00000000-0000-4000-8000-000000000005","claims":{"role":"authenticated"}}') #>> '{claims,role}' <> 'authenticated' then
      raise exception 'hook still hands out the role'; end if;
  end $d$$o$, 'allow');
select pg_temp.t('supabase_admin', 'check_storage: the public demo bucket is reported',
  pg_temp.yes($$exists (select 1 from cms.check_storage() where severity = 'warning' and object = 'storage bucket images')$$), 'allow');
select pg_temp.t('supabase_admin', 'fix_public_defaults(include_public_execute): new functions are no longer callable by anon',
  $o$do $d$ begin
    if not exists (select 1 from cms.fix_public_defaults(include_public_execute => true) s where s like '%revoke execute on functions from public%') then
      raise exception 'dry run lacks the statement'; end if;
    perform cms.fix_public_defaults(dry_run => false, include_public_execute => true);
    create function public.t_later() returns int language sql as 'select 1';
    if has_function_privilege('anon', 'public.t_later()', 'EXECUTE') then raise exception 'anon can still execute'; end if;
  end $d$$o$, 'allow');
select pg_temp.t('cms_admin', 'step 5 checks are owner-only', 'select * from cms.check_storage()', 'deny');
select pg_temp.t('agency_nordwind', 'unreferenced_files: not for agencies', 'select count(*) from cms_api.unreferenced_files()', 'deny');

-- ── file references (step 5, for renaming) ────────────────────────────────────────────────
select pg_temp.t('supabase_admin', 'file_references: admin sees every row using a file, visible = total',
  $o$do $d$ declare j jsonb; begin
    insert into suedwind.product_images (product_id, storage_path) values ('20000000-0000-4000-8000-000000000002', 'suedwind/sonnencreme.png');
    set local role cms_admin;
    j := cms_api.file_references('images', 'suedwind/sonnencreme.png');
    reset role;
    if (j ->> 'visible')::int <> 2 or (j ->> 'total')::int <> 2
       or not (j -> 'refs' @> '[{"resource": "suedwind.product_images", "column": "storage_path", "key": {"id": "21000000-0000-4000-8000-000000000001"}}]')
      then raise exception 'got %', j; end if;
  end $d$$o$, 'allow');
select pg_temp.t('supabase_admin', 'file_references: rows the caller cannot see are counted, not shown',
  $o$do $d$ declare j jsonb; begin
    set local role agency_nordwind;
    j := cms_api.file_references('images', 'suedwind/sonnencreme.png');
    reset role;
    if (j ->> 'visible')::int <> 0 or (j ->> 'total')::int <> 1 or j -> 'refs' <> '[]' then raise exception 'got %', j; end if;
  end $d$$o$, 'allow');
select pg_temp.t('supabase_admin', 'file_references: an unused file has no references',
  $o$do $d$ declare j jsonb; begin
    set local role cms_admin;
    j := cms_api.file_references('images', 'suedwind/nobody-uses-this.png');
    reset role;
    if (j ->> 'total')::int <> 0 then raise exception 'got %', j; end if;
  end $d$$o$, 'allow');

-- ── hardening check (Supabase stock grants in public) ───────────────────────────────────────
select pg_temp.t('supabase_admin', 'hardening: demo is clean after fix',
  pg_temp.yes($$not exists (select 1 from cms.check_public_defaults())$$), 'allow');
select pg_temp.t('supabase_admin', 'hardening: finds open table, match_*, defaults',
  $o$do $d$ declare got text; begin
    create table public.t_open (id int);
    grant select on public.t_open to anon;
    create function public.match_t() returns int language sql as 'select 1';
    alter default privileges for role postgres in schema public grant select on tables to anon;
    select string_agg(severity || ':' || object, ' ' order by severity, object) into got from cms.check_public_defaults();
    if got <> 'critical:public.t_open warning:default privileges of postgres in schema public warning:public.match_t()' then
      raise exception 'got %', got;
    end if;
  end $d$$o$, 'allow');
select pg_temp.t('supabase_admin', 'hardening: dry run changes nothing, fix closes it',
  $o$do $d$ begin
    create table public.t_open (id int);
    grant select on public.t_open to anon;
    create function public.match_t() returns int language sql as 'select 1';
    perform cms.fix_public_defaults();                       -- dry run
    if (select count(*) from cms.check_public_defaults()) <> 2 then raise exception 'dry run changed something'; end if;
    perform cms.fix_public_defaults(dry_run => false);
    if exists (select 1 from cms.check_public_defaults()) then raise exception 'still open'; end if;
    if not has_function_privilege('service_role', 'public.match_t()', 'EXECUTE') then raise exception 'service_role lost execute'; end if;
  end $d$$o$, 'allow');
select pg_temp.t('cms_admin', 'hardening functions are owner-only',  'select * from cms.fix_public_defaults()', 'deny');

-- brand settings (brand-bootstrap.sql, settings=yes): one row, the default currency of products
select pg_temp.t('agency_nordwind', 'settings: agency reads them',       'select display_name, default_currency from nordwind.settings', 'allow');
select pg_temp.t('agency_nordwind', 'settings: agency cannot change them', $$update nordwind.settings set display_name = 'x'$$, 'deny');
select pg_temp.t('cms_admin', 'settings: a second row is refused',     $$insert into nordwind.settings (id, display_name) values (2, 'x')$$, 'deny');
select pg_temp.t('cms_admin', 'settings: website must start with http(s)://', $$update nordwind.settings set website_url = 'nordwind.example'$$, 'deny');
select pg_temp.t('cms_admin', 'settings: locale only from the list',  $$update nordwind.settings set default_locale = 'xx-XX'$$, 'deny');
select pg_temp.t('cms_admin', 'currency: only codes of the type',      $$update nordwind.products set currency = 'XXX'$$, 'deny');
select pg_temp.t('cms_admin', 'currency: a new product without one gets the default from the settings', $s$do $d$ begin
    update nordwind.settings set default_currency = 'CHF';
    insert into nordwind.products (sku, name, price) values ('T-CUR-1', 'Test', 1);
    insert into nordwind.products (sku, name, price, currency) values ('T-CUR-2', 'Test', 1, 'GBP');
    if (select string_agg(currency::text, ',' order by sku) from nordwind.products where sku like 'T-CUR-%') <> 'CHF,GBP' then
      raise exception 'currencies: %', (select string_agg(currency::text, ',' order by sku) from nordwind.products where sku like 'T-CUR-%');
    end if;
  end $d$$s$, 'allow');

\o
\pset footer off
select n, role, label, expect, got, case when ok then 'PASS' else '** FAIL **' end as result, detail from t_result order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t_result;
-- fail the run (psql exit code ≠ 0) when any test failed
do $$ begin
  if exists (select 1 from t_result where not ok) then
    raise exception '% of % tests failed', (select count(*) from t_result where not ok), (select count(*) from t_result);
  end if;
end $$;
