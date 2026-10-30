-- Catalog snapshot: one sorted line per object outside the system schemas, with owner, ACL and a
-- hash of its definition. scripts/test-sql.sh diffs two snapshots to prove that install.sql is
-- idempotent and that uninstall.sql leaves nothing behind. Run as supabase_admin with psql -At.
set search_path = '';
with nsp as (
  select oid, nspname from pg_namespace
   where nspname not in ('pg_catalog', 'information_schema', 'pg_toast') and nspname not like 'pg\_temp\_%'
     and nspname not like 'pg\_toast\_temp\_%'
)
select line from (
  select format('schema %s owner=%s acl=%s comment=%s', n.nspname, n.nspowner::regrole, coalesce(n.nspacl::text, '-'),
                coalesce(obj_description(n.oid, 'pg_namespace'), '-')) as line
    from pg_namespace n join nsp using (oid)
  union all
  select format('role %s login=%s super=%s bypassrls=%s inherit=%s', rolname, rolcanlogin, rolsuper, rolbypassrls, rolinherit)
    from pg_roles where rolname not like 'pg\_%'
  union all
  select format('member %s in %s admin=%s', m.member::regrole, m.roleid::regrole, m.admin_option) from pg_auth_members m
  union all
  select format('rel %s kind=%s owner=%s acl=%s rls=%s/%s comment=%s', c.oid::regclass, c.relkind, c.relowner::regrole,
                coalesce(c.relacl::text, '-'), c.relrowsecurity, c.relforcerowsecurity, coalesce(obj_description(c.oid, 'pg_class'), '-'))
    from pg_class c join nsp on nsp.oid = c.relnamespace
  union all
  select format('col %s.%s %s notnull=%s default=%s acl=%s', a.attrelid::regclass, a.attname, format_type(a.atttypid, a.atttypmod),
                a.attnotnull, coalesce(pg_get_expr(d.adbin, d.adrelid), '-'), coalesce(a.attacl::text, '-'))
    from pg_attribute a join pg_class c on c.oid = a.attrelid join nsp on nsp.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attnum > 0 and not a.attisdropped
  union all
  select format('con %s %s %s', coalesce(con.conrelid::regclass::text, con.contypid::regtype::text), con.conname, pg_get_constraintdef(con.oid))
    from pg_constraint con join nsp on nsp.oid = con.connamespace
  union all
  select format('fn %s owner=%s acl=%s secdef=%s def=%s', p.oid::regprocedure, p.proowner::regrole, coalesce(p.proacl::text, '-'),
                p.prosecdef, case when p.prokind = 'a' then '-' else md5(pg_get_functiondef(p.oid)) end)
    from pg_proc p join nsp on nsp.oid = p.pronamespace
  union all
  select format('type %s owner=%s acl=%s', t.oid::regtype, t.typowner::regrole, coalesce(t.typacl::text, '-'))
    from pg_type t join nsp on nsp.oid = t.typnamespace where t.typtype in ('e', 'd')
  union all
  select format('trigger %s', pg_get_triggerdef(g.oid)) from pg_trigger g where not g.tgisinternal
  union all
  select format('evttrigger %s %s %s', e.evtname, e.evtevent, e.evtfoid::regproc) from pg_event_trigger e
  union all
  select format('policy %s %s cmd=%s permissive=%s roles=%s using=%s check=%s', p.polrelid::regclass, p.polname, p.polcmd, p.polpermissive,
                (select string_agg(case when r = 0 then 'public' else r::regrole::text end, ',' order by 1) from unnest(p.polroles) r),
                coalesce(pg_get_expr(p.polqual, p.polrelid), '-'), coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '-'))
    from pg_policy p
  union all
  select format('defacl %s %s %s %s', d.defaclrole::regrole, coalesce(nullif(d.defaclnamespace, 0)::regnamespace::text, '(global)'),
                d.defaclobjtype, d.defaclacl::text) from pg_default_acl d
  union all
  select format('extension %s %s schema=%s', x.extname, x.extversion, x.extnamespace::regnamespace) from pg_extension x
  union all
  select format('dbacl %s', coalesce(datacl::text, '-')) from pg_database where datname = current_database()
) s
order by 1;
