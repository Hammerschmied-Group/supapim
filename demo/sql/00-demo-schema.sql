-- Demo schema: two brand schemas (PIM + FAQ), a pgvector table and the storage buckets.
-- Destructive for the demo objects only (drops and recreates them); run as supabase_admin.
-- Mirrors the shapes of the real use cases (brand schemas with products / product_images / faq,
-- a LangChain-style documents table) without any production data.

begin;

create extension if not exists vector with schema extensions;
create extension if not exists moddatetime with schema extensions;

-- The two demo brands start empty here; their tables, settings, roles and audit come from the brand
-- bootstrap (scripts/sql/brand-bootstrap.sql), exactly like any brand a customer adds. scripts/seed.sh and
-- scripts/test-sql.sh run it for nordwind and suedwind right after this file.
drop schema if exists nordwind cascade;
drop schema if exists suedwind cascade;
create schema nordwind authorization postgres;
create schema suedwind authorization postgres;

-- Vector store (LangChain / Supabase vector store shape). 1536 dims = text-embedding-3-small.
drop function if exists public.match_documents(extensions.vector, int, jsonb);
drop table if exists public.documents;
create table public.documents (
  id         bigint generated always as identity primary key,
  brand      text not null,                 -- nordwind | suedwind | hr
  content    text not null,
  metadata   jsonb not null default '{}',
  embedding  extensions.vector(1536) not null
);
alter table public.documents owner to postgres;
create index documents_embedding_hnsw on public.documents using hnsw (embedding extensions.vector_cosine_ops);
alter table public.documents enable row level security;
comment on table public.documents is 'Demo vector store. Seeded with deterministic pseudo-embeddings (no model needed).';

create function public.match_documents(query_embedding extensions.vector(1536), match_count int default 5,
                                       filter jsonb default '{}')
returns table (id bigint, brand text, content text, metadata jsonb, similarity double precision)
language sql stable security invoker set search_path = public, extensions as $$
  select d.id, d.brand, d.content, d.metadata, 1 - (d.embedding <=> query_embedding) as similarity
    from public.documents d
   where d.metadata @> filter
   order by d.embedding <=> query_embedding
   limit match_count
$$;
alter function public.match_documents(extensions.vector, int, jsonb) owner to postgres;

-- Storage buckets. "images" is public-read (product images on the website), "hr-files" private.
insert into storage.buckets (id, name, public) values ('images', 'images', true), ('hr-files', 'hr-files', false)
on conflict (id) do update set public = excluded.public;

commit;
