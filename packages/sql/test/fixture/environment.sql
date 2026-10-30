-- Test fixture for the bare supabase/postgres image (scripts/test-sql.sh), applied BEFORE the
-- "before install" catalog snapshot. A real Supabase project gets these from its services:
--   storage.buckets / storage.objects  ← Storage API migrations (only the columns the tests use)
--   auth.users rows                    ← GoTrue (the demo's test users, fixed ids)
--   auth.mfa_factors / sessions / oauth_* ← GoTrue (empty; only the columns the token hook and the tests use)
-- Never run this against a real project.

begin;

create table if not exists storage.buckets (
  id         text primary key,
  name       text not null unique,
  owner      uuid,
  public     boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create table if not exists storage.objects (
  id               uuid primary key default gen_random_uuid(),
  bucket_id        text references storage.buckets (id),
  name             text,
  owner            uuid,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  last_accessed_at timestamptz default now(),
  metadata         jsonb
);
alter table storage.buckets owner to supabase_storage_admin;
alter table storage.objects owner to supabase_storage_admin;
alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.buckets, storage.objects to postgres with grant option;
grant select, insert, update, delete on storage.buckets, storage.objects to anon, authenticated;
grant all on storage.buckets, storage.objects to service_role;

-- what the token hook and cms.confirm_mfa_client() read from Auth (GoTrue migrations; only the columns used)
create table if not exists auth.mfa_factors (
  id uuid primary key, user_id uuid not null, factor_type text not null, status text not null,
  created_at timestamptz not null, updated_at timestamptz not null);
create table if not exists auth.sessions (id uuid primary key, user_id uuid not null);
alter table auth.sessions add column if not exists oauth_client_id uuid;
create table if not exists auth.oauth_clients (
  id uuid primary key, registration_type text not null, redirect_uris text not null, grant_types text not null,
  token_endpoint_auth_method text not null);
create table if not exists auth.oauth_authorizations (
  id uuid primary key, authorization_id text not null, client_id uuid not null references auth.oauth_clients (id),
  user_id uuid, redirect_uri text not null, scope text not null,
  expires_at timestamptz not null default now() + interval '10 minutes');
grant select on auth.mfa_factors, auth.sessions, auth.oauth_clients, auth.oauth_authorizations to postgres, supabase_auth_admin;

insert into auth.users (id, aud, role, email)
select format('00000000-0000-4000-8000-%s', lpad(i::text, 12, '0'))::uuid, 'authenticated', 'authenticated', e
  from unnest(array['admin@example.com', 'agentur.nordwind@example.com', 'agentur.suedwind@example.com',
                    'hr@example.com', 'ohne.rolle@example.com']) with ordinality u(e, i)
on conflict (id) do nothing;

commit;
