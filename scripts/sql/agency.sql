-- An agency that works for several brands — reusable and idempotent. Docs: docs/brand-bootstrap.md ("Agentur für
-- mehrere Marken"). Run as supabase_admin (self-hosted) or postgres (Cloud SQL editor); psql variables:
--   psql -v name=northstar -v label='Northstar Agency' -v brands=nordwind,suedwind -v remove= -f agency.sql
-- Cloud / Studio without psql: replace the four :'…' placeholders below with values.
--
-- An access token carries exactly one Postgres role. An agency for several brands is therefore its own group role
-- agency_<name> that is a member of the agency roles of its brands (agency_nordwind, agency_suedwind, created by the
-- brand bootstrap). Postgres passes their grants, column grants, RLS policies and storage policies on to it; nothing
-- else is granted here, so the agency can do in each brand exactly what that brand's agency role can.
-- People get the role in Admin → People like any other. It takes effect with their next token.
--
--   brands   brands to add (comma-separated schema names; each needs its role agency_<schema>)
--   remove   brands to take away (comma-separated); nothing else is ever revoked or dropped
select set_config('agency.name',   :'name',   false),   -- e.g. northstar → role agency_northstar
       set_config('agency.label',  :'label',  false),   -- e.g. Northstar Agency (role comment; may be empty)
       set_config('agency.brands', :'brands', false),   -- e.g. nordwind,suedwind (may be empty)
       set_config('agency.remove', :'remove', false);   -- e.g. suedwind (may be empty)

set client_min_messages = warning;
begin;

do $$
declare
  n      text := current_setting('agency.name');
  ag     text := 'agency_' || current_setting('agency.name');
  label  text := nullif(current_setting('agency.label'), '');
  add    text[] := array_remove(string_to_array(replace(current_setting('agency.brands'), ' ', ''), ','), '');
  del    text[] := array_remove(string_to_array(replace(current_setting('agency.remove'), ' ', ''), ','), '');
  b      text;
  now_in text;
begin
  if n !~ '^[a-z_][a-z0-9_]{0,55}$' then
    raise exception 'agency name must be lower-case a-z, 0-9, _ (max 56 chars): %', n;
  end if;
  if exists (select 1 from pg_namespace where nspname = n) then
    raise exception 'agency_% is the agency role of the brand %; choose another name for an agency of several brands', n, n;
  end if;
  if exists (select 1 from unnest(add) a join unnest(del) d on a = d) then
    raise exception 'a brand cannot be added and removed at once';
  end if;

  if not exists (select 1 from pg_roles where rolname = ag) then
    execute format('create role %I nologin', ag);
  end if;

  foreach b in array add loop
    if not exists (select 1 from pg_namespace where nspname = b) then
      raise exception 'brand % does not exist (no schema %)', b, b;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'agency_' || b) then
      raise exception 'brand % has no agency role agency_%: run the brand bootstrap for it without --no-agency first', b, b;
    end if;
    if ('agency_' || b) = ag then raise exception 'an agency cannot be its own brand'; end if;
    execute format('grant %I to %I', 'agency_' || b, ag);
  end loop;
  foreach b in array del loop
    if exists (select 1 from pg_auth_members m where m.roleid = to_regrole('agency_' || b) and m.member = to_regrole(ag)) then
      execute format('revoke %I from %I', 'agency_' || b, ag);
    end if;
  end loop;

  -- PostgREST / Storage may switch into the role when a token carries it
  execute format('grant %I to authenticator', ag);

  select string_agg(substr(r.rolname, 8), ', ' order by r.rolname) into now_in
    from pg_auth_members m join pg_roles r on r.oid = m.roleid
   where m.member = to_regrole(ag) and r.rolname like 'agency\_%';
  execute format('comment on role %I is %L', ag,
                 format('Agency %s: brands %s (member of their agency roles).', coalesce(label, n), coalesce(now_in, '(none)')));

  if not cms.is_assignable_role(ag::name) then
    raise exception 'agency_% cannot be assigned to people (cms.is_assignable_role): check its memberships', n;
  end if;
end $$;

commit;

-- summary (psql -At: "key value" lines)
select format('%-22s %s', 'role', 'agency_' || current_setting('agency.name'))
union all
select format('%-22s %s', 'brands', coalesce(string_agg(substr(r.rolname, 8), ', ' order by r.rolname), '(none)'))
  from pg_auth_members m join pg_roles r on r.oid = m.roleid
 where m.member = to_regrole('agency_' || current_setting('agency.name')) and r.rolname like 'agency\_%'
union all
select format('%-22s %s', 'people with the role', count(*))
  from cms.user_roles where db_role = 'agency_' || current_setting('agency.name');
