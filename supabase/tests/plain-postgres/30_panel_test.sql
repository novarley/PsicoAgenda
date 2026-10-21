-- Pruebas del soporte del panel (migración 0006). Se ejecuta tras 10_ y 20_,
-- reutilizando su organización, usuarios, profesionales y citas sintéticos.
\set ON_ERROR_STOP 1
reset role;
set request.jwt.claims = '{"role":"service_role"}';

insert into public.profiles (id, full_name, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'Admin Demo', 'admin@demo.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'Recepción Demo', 'recepcion@demo.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'Psicóloga Uno', 'psico1@demo.test'),
  ('00000000-0000-0000-0000-0000000000a4', 'Psicólogo Dos', 'psico2@demo.test');

-- Cita con anticipo pendiente para probar el pago manual
do $$
declare d date := (now() at time zone 'America/Bogota')::date + 5;
begin
  perform public.book_appointment('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555502',
    '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301',
    '44444444-4444-4444-4444-444444444401', (d + time '13:00') at time zone 'UTC', 'in_person', null, 'dashboard', false);
end $$;

set role authenticated;

-- ---------------------------------------------------------------- admin
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000a1"}';
do $$
declare
  n int; r record;
  d date := (now() at time zone 'America/Bogota')::date + 4;
begin
  select count(*) into n from public.v_staff;
  assert n = 4, format('admin debía ver 4 personas, vio %s', n);
  select * into r from public.v_staff where user_id = '00000000-0000-0000-0000-0000000000a3';
  assert r.roles = array['professional']::app.member_role[], 'roles de la psicóloga';
  assert r.professional_id = '22222222-2222-2222-2222-222222222201', 'debe enlazar su ficha de profesional';

  -- Único admin: no puede quitarse el rol
  begin
    delete from public.memberships where user_id = '00000000-0000-0000-0000-0000000000a1' and role = 'admin';
    raise exception 'debió impedir quitar al último admin';
  exception when sqlstate 'PA004' then null;
  end;

  -- Ocupación: la psicóloga 1 publica 08:00–12:00 (240 min) y tiene 1 cita de 60 min ese día
  select * into r from public.org_occupancy('11111111-1111-1111-1111-111111111111', d, d)
  where professional_id = '22222222-2222-2222-2222-222222222201';
  assert r.available_minutes = 240, format('disponible %s', r.available_minutes);
  assert r.booked_minutes = 60, format('reservado %s', r.booked_minutes);
  assert r.occupancy_pct = 25.0, format('ocupación %s', r.occupancy_pct);
  select * into r from public.org_occupancy('11111111-1111-1111-1111-111111111111', d, d)
  where professional_id = '22222222-2222-2222-2222-222222222202';
  assert r.available_minutes = 0 and r.occupancy_pct is null, 'sin horario publicado no hay ocupación';
end $$;

-- --------------------------------------------------------- recepción
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000a2"}';
do $$
declare n int; appt uuid; pay uuid;
begin
  select count(*) into n from public.org_occupancy('11111111-1111-1111-1111-111111111111', current_date, current_date + 7);
  assert n = 0, 'las métricas de ocupación son solo para admin';

  select id into appt from public.appointments where status = 'pending_payment' limit 1;
  assert appt is not null, 'falta la cita con anticipo pendiente';
  pay := public.record_manual_payment('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555502',
    5000000, 'cash', 'deposit', appt);
  assert pay is not null, 'debe devolver el id del pago';
  select count(*) into n from public.appointments where id = appt and status = 'scheduled' and hold_expires_at is null;
  assert n = 1, 'el pago del anticipo confirma la reserva';

  begin
    perform public.record_manual_payment('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555502',
      1000, 'wompi', 'full', null);
    raise exception 'un pago de pasarela no se registra a mano';
  exception when sqlstate '22023' then null;
  end;
end $$;

-- --------------------------------------------------------- profesional
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000a3"}';
do $$
declare n int;
begin
  begin
    perform public.record_manual_payment('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555501',
      1000, 'cash', 'full', null);
    raise exception 'un profesional no registra pagos';
  exception when sqlstate 'PA002' then null;
  end;
  select count(*) into n from public.v_revenue_monthly;
  assert n = 0, 'un profesional no ve los ingresos';
end $$;

-- ------------------------------------------------- admin ve los ingresos
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000a1"}';
do $$
declare total bigint;
begin
  select sum(total_cents) into total from public.v_revenue_monthly where kind = 'deposit';
  assert total = 5000000, format('ingresos por anticipos: %s', total);
end $$;

reset role;
\echo 'OK 9 · panel: personal, último admin protegido, ocupación, pagos manuales e ingresos por rol'
