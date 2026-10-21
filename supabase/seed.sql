-- Datos de demostración SOLO para desarrollo local (`supabase db reset`).
-- Supabase no ejecuta este archivo en `supabase db push` contra producción.

insert into public.organizations (id, name, country_code, timezone, currency, wa_phone_number_id, crisis_lines, settings)
values (
  '11111111-1111-1111-1111-111111111111', 'Centro de Psicología Demo', 'CO', 'America/Bogota', 'COP',
  'REEMPLAZAR_CON_PHONE_NUMBER_ID_DE_META',
  -- VERIFICAR líneas vigentes con la Secretaría de Salud local antes de producción
  '[{"name":"Emergencias","phone":"123"},
    {"name":"Línea de salud mental Minsalud (opción 4)","phone":"192"},
    {"name":"Línea 106 (Bogotá)","phone":"106"}]'::jsonb,
  '{"late_cancel_hours": 24, "template_language": "es"}'::jsonb
);

insert into public.sites (id, org_id, name, address, is_virtual) values
  ('33333333-3333-3333-3333-333333333301', '11111111-1111-1111-1111-111111111111', 'Sede Chapinero', 'Calle 60 # 9-00', false),
  ('33333333-3333-3333-3333-333333333302', '11111111-1111-1111-1111-111111111111', 'Terapia en línea', null, true);

insert into public.insurers (org_id, name, kind) values
  ('11111111-1111-1111-1111-111111111111', 'EPS Ejemplo', 'eps'),
  ('11111111-1111-1111-1111-111111111111', 'Prepagada Ejemplo', 'prepagada');

insert into public.services (id, org_id, name, specialty, duration_minutes, price_cents, deposit_percent) values
  ('44444444-4444-4444-4444-444444444401', '11111111-1111-1111-1111-111111111111', 'Psicoterapia individual', 'psychology', 50, 12000000, 50),
  ('44444444-4444-4444-4444-444444444402', '11111111-1111-1111-1111-111111111111', 'Consulta medicina general', 'general_medicine', 20, 6000000, 0);

insert into public.professionals (id, org_id, full_name, specialty) values
  ('22222222-2222-2222-2222-222222222201', '11111111-1111-1111-1111-111111111111', 'Psic. Laura Méndez', 'psychology'),
  ('22222222-2222-2222-2222-222222222202', '11111111-1111-1111-1111-111111111111', 'Dr. Andrés Rojas', 'general_medicine');

-- Lunes a viernes 08:00–12:00 y 14:00–18:00 (hora de Bogotá)
insert into public.availability_rules (org_id, professional_id, site_id, weekday, start_time, end_time, slot_minutes)
select '11111111-1111-1111-1111-111111111111', p.id, s.id, wd, b.start_t, b.end_t, p.slot
from (values ('22222222-2222-2222-2222-222222222201'::uuid, 60), ('22222222-2222-2222-2222-222222222202'::uuid, 20)) as p(id, slot)
cross join (values ('33333333-3333-3333-3333-333333333301'::uuid), ('33333333-3333-3333-3333-333333333302'::uuid)) as s(id)
cross join generate_series(1, 5) wd
cross join (values (time '08:00', time '12:00'), (time '14:00', time '18:00')) as b(start_t, end_t)
where not (p.id = '22222222-2222-2222-2222-222222222202' and s.id = '33333333-3333-3333-3333-333333333302');

insert into public.bono_plans (org_id, service_id, name, sessions_total, price_cents, valid_days) values
  ('11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444401', 'Bono 5 sesiones', 5, 55000000, 120),
  ('11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444401', 'Bono 10 sesiones', 10, 100000000, 240);
