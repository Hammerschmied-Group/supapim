-- First admin for SupaPIM on Supabase Cloud (SQL editor, runs as postgres). Repeatable.
-- 1. Create the person first: Dashboard → Authentication → Users → Add user → Create new user
--    (e-mail + password, "Auto confirm user" on). Or invite them there.
-- 2. Put their e-mail address on the line marked  <<< EDIT  and run the whole file.
-- Afterwards they sign in at <your CMS address>/cms/ and can invite and assign everyone else under Admin → People.

do $$
declare
  v_email text := 'you@example.com';          -- <<< EDIT
  v_id    uuid;
begin
  select id into v_id from auth.users where lower(email) = lower(v_email);
  if v_id is null then
    raise exception 'no user with e-mail % — create the person under Authentication → Users first', v_email;
  end if;

  -- admin group role: no login, no DDL; rights on data come from the brand script or your own GRANTs
  if not exists (select 1 from pg_roles where rolname = 'cms_admin') then
    create role cms_admin nologin;
  end if;
  comment on role cms_admin is 'Group: CMS admins (cms.settings.admin_roles). Invite people, assign roles, read the audit log.';
  grant cms_admin to authenticator;
  update cms.settings
     set admin_roles = (select array_agg(distinct r order by r) from unnest(admin_roles || '{cms_admin}'::name[]) r),
         updated_at  = now();
  grant usage on schema audit to cms_admin;
  grant select on audit.change_log to cms_admin;

  insert into cms.user_roles (user_id, db_role) values (v_id, 'cms_admin')
    on conflict (user_id) do update set db_role = excluded.db_role;
  raise notice 'cms_admin assigned to %', v_email;
end $$;
