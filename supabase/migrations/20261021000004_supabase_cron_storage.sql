-- =============================================================================
-- PsicoAgenda · Piezas exclusivas de Supabase: pg_cron, pg_net, Vault, Storage
-- Sustituye a un servidor de colas / cron de pago: todo corre en el plan gratis.
--
-- ANTES de aplicar en un proyecto nuevo, crear los secretos una sola vez
-- (SQL Editor del dashboard, NO en este archivo):
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<cadena aleatoria de 32+ caracteres>', 'dispatcher_secret');
-- y el mismo dispatcher_secret como secreto de la Edge Function:
--   supabase secrets set DISPATCHER_SECRET=<la misma cadena>
-- =============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Libera reservas sin anticipo pagado (SQL puro, sin HTTP)
select cron.schedule(
  'release-expired-holds',
  '*/5 * * * *',
  $$ select app.release_expired_holds(); $$
);

-- Despierta al dispatcher de recordatorios (48 h, 2 h, aftercare, lista de espera).
-- Precisión ±5 min: suficiente para un recordatorio de 2 h.
select cron.schedule(
  'dispatch-notifications',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
               || '/functions/v1/notifications-dispatcher',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-dispatcher-secret',
                 (select decrypted_secret from vault.decrypted_secrets where name = 'dispatcher_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $$
);

-- Minimización de datos: los payloads crudos de WhatsApp no se guardan para siempre
select cron.schedule(
  'purge-wa-inbound',
  '15 8 * * *',   -- 03:15 en Bogotá (UTC-5)
  $$ delete from public.wa_inbound_messages
     where processed_at is not null and received_at < now() - interval '90 days'; $$
);

-- -----------------------------------------------------------------------------
-- Storage: bucket privado para documentos clínicos y firmas.
-- Convención de ruta: {org_id}/{patient_id}/{archivo}
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('clinical-documents', 'clinical-documents', false, 10485760)  -- 10 MB
on conflict (id) do nothing;

create policy clinical_docs_read on storage.objects for select to authenticated
  using (
    bucket_id = 'clinical-documents'
    and (app.is_staff(((storage.foldername(name))[1])::uuid)
         or app.treats_patient(((storage.foldername(name))[1])::uuid, ((storage.foldername(name))[2])::uuid))
  );

create policy clinical_docs_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'clinical-documents'
    and (app.is_staff(((storage.foldername(name))[1])::uuid)
         or app.treats_patient(((storage.foldername(name))[1])::uuid, ((storage.foldername(name))[2])::uuid))
  );
