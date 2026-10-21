-- Stub mínimo de lo que Supabase provee (roles, auth.users, auth.uid()) para
-- probar las migraciones 0001–0003 en un Postgres vanilla, sin la pila completa.
-- La 0004 (pg_cron, Vault, Storage) solo se prueba con `supabase start`.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create table auth.users (id uuid primary key, email text);

create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid;
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to authenticated, service_role;
alter default privileges in schema public grant all on sequences to authenticated, service_role;
