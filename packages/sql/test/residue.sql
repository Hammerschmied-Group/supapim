-- Plugin residue after uninstall.sql: prints one line per leftover, nothing when clean.
-- With "set cms.keep_audit_log = on" before running this, audit.change_log (+ its sequence and
-- indexes and the audit schema) is expected and not reported.
set search_path = '';
select line from (
  select 'schema ' || nspname as line from pg_namespace
   where nspname in ('cms', 'cms_api')
      or (nspname = 'audit' and not coalesce(current_setting('cms.keep_audit_log', true), 'off')::boolean)
  union all
  select 'relation ' || c.oid::regclass from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'audit' and c.relname not in ('change_log', 'change_log_id_seq', 'change_log_pkey', 'change_log_table_at', 'change_log_at')
  union all
  select 'function ' || p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('cms', 'cms_api', 'audit')
  union all
  select 'trigger ' || tgname || ' on ' || tgrelid::regclass from pg_trigger
   where tgname = 'zz_audit_log_change'
  union all
  select 'policy ' || polname || ' on ' || polrelid::regclass from pg_policy
   where polname like 'rbac: %' or polname = 'auth server reads mapping'
  union all
  select 'default acl in missing schema ' || defaclnamespace from pg_default_acl
   where defaclnamespace <> 0 and not exists (select 1 from pg_namespace n where n.oid = defaclnamespace)
  union all
  select 'supabase_auth_admin grant on ' || p.oid::regprocedure from pg_proc p
   where p.proname = 'custom_access_token_hook' and has_function_privilege('supabase_auth_admin', p.oid, 'EXECUTE')
) s order by 1;
