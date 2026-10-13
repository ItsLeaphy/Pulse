-- ============================================================
-- SHIM MÍNIMO DO SUPABASE — SÓ PARA TESTES EM POSTGRESQL PURO
-- Cria o que o schema do Pulse espera encontrar num projeto Supabase:
-- roles anon/authenticated, auth.users e auth.uid() (lê o claim "sub"
-- como o PostgREST faz). NÃO é o Supabase: não há GoTrue, PostgREST,
-- JWT real nem as demais extensões. Nunca rode em um projeto real.
-- ============================================================
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $f$;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
