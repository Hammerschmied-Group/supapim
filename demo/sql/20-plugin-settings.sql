-- Demo configuration of the plugin — what an admin does once with SQL after install.sql.
-- Run as supabase_admin (self-hosted) so fix_public_defaults() also covers supabase_admin's
-- default privileges; on Supabase Cloud, postgres runs the same and that part is skipped.

begin;

-- cms_admin may see everyone's effective rights; both brand schemas are audited (brands added with
-- scripts/brand-bootstrap.sh stay in the list, so a re-seed keeps auditing them).
update cms.settings
   set admin_roles   = '{cms_admin}',
       audit_schemas = (select array_agg(distinct s order by s) from unnest(audit_schemas || '{nordwind,suedwind}'::text[]) s),
       updated_at    = now();
select * from cms.sync_audit();

-- Close Supabase's stock grants to anon/authenticated in schema public (what AVIA did with
-- 05-public-defaults.sql). Opt-in: check first with  select * from cms.check_public_defaults();
select * from cms.fix_public_defaults(dry_run => false);

-- Who may read the change log is a plain GRANT, like every other right.
grant usage on schema audit to cms_admin;
grant select on audit.change_log to cms_admin;

commit;
