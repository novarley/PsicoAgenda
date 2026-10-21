-- Pruebas de integración de las migraciones 0001–0003 (agenda, bonos, RLS).
-- Uso: supabase/tests/plain-postgres/run.sh   (todos los datos son sintéticos)
\set ON_ERROR_STOP 1
\set QUIET 1

-- ---------------------------------------------------------------- datos base
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@demo.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'recepcion@demo.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'psico1@demo.test'),
  ('00000000-0000-0000-0000-0000000000a4', 'psico2@demo.test');

insert into public.organizations (id, name, timezone) values
  ('11111111-1111-1111-1111-111111111111', 'Clínica Demo', 'America/Bogota');

insert into public.memberships (org_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-0000000000a1', 'admin'),
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-0000000000a2', 'receptionist'),
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-0000000000a3', 'professional'),
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-0000000000a4', 'professional');

insert into public.professionals (id, org_id, user_id, full_name, specialty) values
  ('22222222-2222-2222-2222-222222222201', '11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-0000000000a3', 'Psicóloga Uno', 'psychology'),
  ('22222222-2222-2222-2222-222222222202', '11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-0000000000a4', 'Psicólogo Dos', 'psychology');

insert into public.sites (id, org_id, name) values
  ('33333333-3333-3333-3333-333333333301', '11111111-1111-1111-1111-111111111111', 'Sede Centro');

insert into public.services (id, org_id, name, specialty, duration_minutes, price_cents, deposit_percent) values
  ('44444444-4444-4444-4444-444444444401', '11111111-1111-1111-1111-111111111111', 'Psicoterapia individual', 'psychology', 50, 10000000, 50);

-- Lunes a domingo, 08:00–12:00 hora de Bogotá, huecos de 60 min
insert into public.availability_rules (org_id, professional_id, site_id, weekday, start_time, end_time, slot_minutes)
select '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222201',
       '33333333-3333-3333-3333-333333333301', wd, '08:00', '12:00', 60
from generate_series(1, 7) wd;

insert into public.patients (id, org_id, doc_type, doc_number, full_name, phone_e164) values
  ('55555555-5555-5555-5555-555555555501', '11111111-1111-1111-1111-111111111111', 'CC', '1000000001', 'Paciente Uno', '+573000000001'),
  ('55555555-5555-5555-5555-555555555502', '11111111-1111-1111-1111-111111111111', 'CC', '1000000002', 'Paciente Dos', '+573000000002');

set request.jwt.claims = '{"role":"service_role"}';

-- ------------------------------------------- 1. huecos en hora local → UTC
do $$
declare
  d date := (now() at time zone 'America/Bogota')::date + 3;
  n int; first_slot timestamptz;
begin
  select count(*), min(starts_at) into n, first_slot
  from public.available_slots('11111111-1111-1111-1111-111111111111',
       '22222222-2222-2222-2222-222222222201', null, d, 1);
  assert n = 4, format('esperaba 4 huecos, hubo %s', n);
  -- 08:00 en Bogotá (UTC-5, sin horario de verano) = 13:00 UTC
  assert first_slot = (d + time '13:00') at time zone 'UTC', format('primer hueco inesperado: %s', first_slot);
  raise notice 'OK 1 · available_slots convierte hora local a UTC';
end $$;

-- ------------------------- 2. reserva con anticipo + doble reserva rechazada
do $$
declare
  d date := (now() at time zone 'America/Bogota')::date + 3;
  r jsonb;
begin
  r := public.book_appointment('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555501',
       '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301',
       '44444444-4444-4444-4444-444444444401', (d + time '13:00') at time zone 'UTC');
  assert r ->> 'status' = 'pending_payment', format('estado %s', r ->> 'status');
  assert (r ->> 'deposit_cents')::bigint = 5000000, 'anticipo del 50 % incorrecto';
  assert (r ->> 'ends_at')::timestamptz = ((d + time '13:50') at time zone 'UTC'), 'la duración del servicio (50 min) no se aplicó';

  begin
    perform public.book_appointment('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555502',
       '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301',
       '44444444-4444-4444-4444-444444444401', (d + time '13:00') at time zone 'UTC');
    raise exception 'la doble reserva debió fallar';
  exception when sqlstate 'PA001' then null;
  end;

  begin
    perform public.book_appointment('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555502',
       '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301',
       '44444444-4444-4444-4444-444444444401', (d + time '22:00') at time zone 'UTC');  -- 17:00 local, fuera de horario
    raise exception 'la reserva fuera de horario debió fallar';
  exception when sqlstate 'PA001' then null;
  end;
  raise notice 'OK 2 · anticipo 50 %%, sin doble reserva, sin reservas fuera de horario';
end $$;

-- --------------------------- 3. bono: consumo, recordatorios y devolución
insert into public.bono_plans (id, org_id, service_id, name, sessions_total, price_cents) values
  ('66666666-6666-6666-6666-666666666601', '11111111-1111-1111-1111-111111111111',
   '44444444-4444-4444-4444-444444444401', 'Bono 5 sesiones', 5, 45000000);
insert into public.bonos (id, org_id, plan_id, patient_id, sessions_total, status, expires_at) values
  ('77777777-7777-7777-7777-777777777701', '11111111-1111-1111-1111-111111111111',
   '66666666-6666-6666-6666-666666666601', '55555555-5555-5555-5555-555555555501', 5, 'active', now() + interval '180 days');
insert into public.waitlist_entries (org_id, patient_id, professional_id) values
  ('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555502', '22222222-2222-2222-2222-222222222201');

do $$
declare
  d date := (now() at time zone 'America/Bogota')::date + 3;
  r jsonb; appt uuid; n int; used int;
begin
  r := public.book_appointment('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555501',
       '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301',
       '44444444-4444-4444-4444-444444444401', (d + time '14:00') at time zone 'UTC');
  appt := (r ->> 'appointment_id')::uuid;
  assert r ->> 'status' = 'scheduled', 'con bono no debe pedir anticipo';
  assert (r ->> 'bono_sessions_remaining')::int = 4, format('quedan %s sesiones', r ->> 'bono_sessions_remaining');

  select count(*) into n from public.scheduled_notifications where appointment_id = appt and status = 'pending';
  assert n = 3, format('esperaba 3 notificaciones (48h, 2h, aftercare), hubo %s', n);

  update public.appointments set status = 'cancelled', cancelled_at = now() where id = appt;

  select sessions_used into used from public.bonos where id = '77777777-7777-7777-7777-777777777701';
  assert used = 0, 'la cancelación con >24 h debe devolver la sesión';
  select count(*) into n from public.scheduled_notifications where appointment_id = appt and status = 'skipped';
  assert n = 3, 'los recordatorios de una cita cancelada deben quedar skipped';
  select count(*) into n from public.waitlist_entries where status = 'offered';
  assert n = 1, 'el hueco liberado debe ofrecerse a la lista de espera';
  select count(*) into n from public.scheduled_notifications where kind = 'waitlist_offer';
  assert n = 1, 'falta la notificación waitlist_offer';
  raise notice 'OK 3 · bono descuenta y devuelve, recordatorios, lista de espera';
end $$;

-- ------------------------------------- 4. solapamiento imposible a nivel BD
do $$
declare d date := (now() at time zone 'America/Bogota')::date + 4;
begin
  insert into public.appointments (org_id, patient_id, professional_id, site_id, service_id, starts_at, ends_at, channel)
  values ('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555501',
          '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301',
          '44444444-4444-4444-4444-444444444401', (d + time '15:00') at time zone 'UTC', (d + time '16:00') at time zone 'UTC', 'dashboard');
  begin
    insert into public.appointments (org_id, patient_id, professional_id, site_id, service_id, starts_at, ends_at, channel)
    values ('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555502',
            '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301',
            '44444444-4444-4444-4444-444444444401', (d + time '15:30') at time zone 'UTC', (d + time '16:30') at time zone 'UTC', 'dashboard');
    raise exception 'el solapamiento debió fallar';
  exception when exclusion_violation then null;
  end;
  raise notice 'OK 4 · constraint de exclusión impide solapes';
end $$;

-- -------------------------------------- 5. zona horaria inválida rechazada
do $$
begin
  insert into public.organizations (name, timezone) values ('Mal', 'Marte/Olimpo');
  raise exception 'una zona horaria inválida debió fallar';
exception when sqlstate '22023' then
  raise notice 'OK 5 · zona horaria IANA validada';
end $$;

-- --------------------------- 6. reservas sin pagar se liberan + cola de envío
do $$
declare n int;
begin
  update public.appointments set hold_expires_at = now() - interval '1 minute' where status = 'pending_payment';
  n := app.release_expired_holds();
  assert n = 1, format('esperaba liberar 1 reserva, liberó %s', n);

  update public.scheduled_notifications set send_at = now() - interval '1 minute' where kind = 'waitlist_offer';
  select count(*) into n from public.claim_due_notifications(10);
  assert n = 1, format('esperaba reclamar 1 notificación, reclamó %s', n);
  select count(*) into n from public.claim_due_notifications(10);
  assert n = 0, 'una notificación no puede reclamarse dos veces';
  raise notice 'OK 6 · holds expirados liberados; cola exactly-once';
end $$;

-- ---------------------------------------------------- 7. RLS por rol
insert into public.clinical_notes (org_id, patient_id, author_id, is_private, content_ciphertext) values
  ('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555501',
   '22222222-2222-2222-2222-222222222201', true, 'cifrado-de-prueba');

set role authenticated;

set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000a3"}';
do $$ declare n int; begin
  select count(*) into n from public.clinical_notes;  assert n = 1, 'la autora debe ver su nota privada';
  select count(*) into n from public.patients;        assert n = 1, 'la profesional solo ve a sus pacientes';
end $$;

set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000a4"}';
do $$ declare n int; begin
  select count(*) into n from public.clinical_notes;  assert n = 0, 'otro profesional NO ve la nota';
  select count(*) into n from public.patients;        assert n = 0, 'otro profesional NO ve pacientes ajenos';
  begin
    perform public.book_appointment('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555501',
       '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301',
       '44444444-4444-4444-4444-444444444401', now() + interval '5 days');
    raise exception 'un profesional no puede reservar en la agenda de otro';
  exception when sqlstate 'PA002' then null;
  end;
end $$;

set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000a2"}';
do $$ declare n int; begin
  select count(*) into n from public.clinical_notes;  assert n = 0, 'recepción NO ve notas clínicas';
  select count(*) into n from public.patients;        assert n = 2, 'recepción ve todos los pacientes';
  begin
    perform public.claim_due_notifications(10);
    raise exception 'recepción no puede reclamar la cola de envíos';
  exception when insufficient_privilege then null;
  end;
end $$;

set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000a1"}';
do $$ declare n int; begin
  select count(*) into n from public.clinical_notes;   assert n = 0, 'admin NO ve notas clínicas';
  select count(*) into n from public.audit_log;        assert n >= 1, 'admin ve la auditoría';
  select count(*) into n from public.organizations;    assert n = 1, 'admin ve solo su organización';
end $$;

reset role;
\echo 'OK 7 · RLS: notas privadas, pacientes por tratante, finanzas y auditoría por rol'
\echo 'TODAS LAS PRUEBAS SQL PASARON'
