-- SupaPIM — uninstall. One transaction, idempotent (safe to run twice or on a half install).
--
-- BEFORE running it: switch off the Custom Access Token Hook in the Auth configuration
-- (self-hosted: GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED=false; Cloud: Auth → Hooks). A hook that
-- points at the removed cms.custom_access_token_hook makes every sign-in fail. The file refuses to run until you
-- confirm it in the same session:   set cms.hook_disabled = on;
--
-- Removes: schemas cms and cms_api (settings, user → role mapping, hook, all plugin functions and
-- their grants to supabase_auth_admin), every audit trigger, every policy whose name starts with
-- "rbac: ", and schema audit with the change log.
-- Keeps the change log when asked to — run this first, in the same session:
--     set cms.keep_audit_log = on;
-- then only audit.change_log (and its grants) stays; the trigger function goes.
--
-- Not touched: your tables, roles and GRANTs, and the hardening from cms.fix_public_defaults()
-- (re-opening schema public to anon on uninstall would be a security regression).
-- Run as the role that installed it (postgres).

begin;

-- Guard: the hook must be off first, or every sign-in fails once cms.custom_access_token_hook is gone.
do $$
begin
  if to_regprocedure('cms.custom_access_token_hook(jsonb)') is not null
     and coalesce(nullif(current_setting('cms.hook_disabled', true), ''), 'off') <> 'on' then
    raise exception 'SupaPIM: switch off the Custom Access Token Hook first (self-hosted: GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED=false; Cloud: Auth → Hooks), then run  set cms.hook_disabled = on;  and this file again in the same session';
  end if;
end $$;

do $$
declare
  keep boolean := coalesce(nullif(current_setting('cms.keep_audit_log', true), ''), 'off')::boolean;
  t record;
begin
  -- audit triggers (partition clones go with their parent)
  for t in
    select g.tgrelid::regclass as tbl, g.tgname
      from pg_trigger g
     where (g.tgname = 'zz_audit_log_change' or g.tgfoid = coalesce(to_regprocedure('audit.log_change()'), 0))
       and g.tgparentid = 0
  loop
    execute format('drop trigger if exists %I on %s', t.tgname, t.tbl);
  end loop;

  -- policies managed by the plugin's naming convention
  for t in select schemaname, tablename, policyname from pg_policies where policyname like 'rbac: %' loop
    execute format('drop policy if exists %I on %I.%I', t.policyname, t.schemaname, t.tablename);
  end loop;

  drop schema if exists cms_api cascade;
  drop schema if exists cms cascade;

  if keep then
    drop function if exists audit.log_change();
    raise notice 'SupaPIM removed; audit.change_log kept';
  else
    drop schema if exists audit cascade;
    raise notice 'SupaPIM removed';
  end if;
end $$;

commit;
