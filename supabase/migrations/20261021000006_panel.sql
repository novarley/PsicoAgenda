-- =============================================================================
-- PsicoAgenda · Soporte del panel: personal, métricas y pagos manuales
-- =============================================================================

-- Correo visible en la lista de personal (auth.users no se expone al navegador)
alter table public.profiles add column email text;

-- Personal de la organización con sus roles
create or replace view public.v_staff
with (security_invoker = true) as
select
  m.org_id,
  m.user_id,
  p.full_name,
  p.email,
  array_agg(m.role order by m.role) as roles,
  min(m.created_at)                 as since,
  (select pr.id from public.professionals pr
   where pr.org_id = m.org_id and pr.user_id = m.user_id) as professional_id
from public.memberships m
left join public.profiles p on p.id = m.user_id
group by m.org_id, m.user_id, p.full_name, p.email;

-- Una clínica nunca se queda sin administrador (ni por error ni por un clic)
create or replace function app.keep_one_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'admin'
     and (tg_op = 'DELETE' or new.role <> 'admin')
     and exists (select 1 from public.organizations o where o.id = old.org_id)   -- no al borrar la organización entera
     and not exists (
       select 1 from public.memberships m
       where m.org_id = old.org_id and m.role = 'admin' and m.user_id <> old.user_id
     ) then
    raise exception 'LAST_ADMIN' using errcode = 'PA004',
      hint = 'Asigna otro administrador antes de quitar este rol.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create trigger memberships_keep_one_admin
  before update or delete on public.memberships
  for each row execute function app.keep_one_admin();

-- -----------------------------------------------------------------------------
-- Ocupación por profesional en un rango de fechas (hora local de la clínica)
-- disponible = minutos del horario publicado · reservado = minutos de citas activas
-- -----------------------------------------------------------------------------
create or replace function public.org_occupancy(p_org uuid, p_from date, p_to date)
returns table (
  professional_id    uuid,
  full_name          text,
  available_minutes  integer,
  booked_minutes     integer,
  attended           integer,
  no_shows           integer,
  cancelled          integer,
  occupancy_pct      numeric
)
language sql stable security definer set search_path = '' as $$
  with guard as (
    select 1 as ok where app.is_service_role() or app.has_role(p_org, array['admin']::app.member_role[])
  ),
  org as (select o.timezone as tz from public.organizations o where o.id = p_org),
  days as (
    select d::date as day
    from generate_series(p_from::timestamp, least(p_to, p_from + 92)::timestamp, interval '1 day') d
  ),
  -- distinct: un mismo bloque publicado en dos sedes es UNA sola franja del profesional
  blocks as (
    select distinct r.professional_id, days.day, r.start_time, r.end_time
    from public.availability_rules r
    join days on extract(isodow from days.day) = r.weekday
    where r.org_id = p_org
      and (r.valid_from  is null or days.day >= r.valid_from)
      and (r.valid_until is null or days.day <= r.valid_until)
  ),
  avail as (
    select b.professional_id, sum(extract(epoch from (b.end_time - b.start_time)) / 60)::int as mins
    from blocks b group by 1
  ),
  appts as (
    select a.professional_id,
      coalesce(sum(extract(epoch from (a.ends_at - a.starts_at)) / 60)
        filter (where a.status in ('pending_payment', 'scheduled', 'confirmed', 'completed', 'no_show')), 0)::int as booked,
      count(*) filter (where a.status = 'completed')::int as attended,
      count(*) filter (where a.status = 'no_show')::int   as no_shows,
      count(*) filter (where a.status = 'cancelled')::int as cancelled
    from public.appointments a cross join org
    where a.org_id = p_org
      and (a.starts_at at time zone org.tz)::date between p_from and p_to
    group by 1
  )
  select p.id, p.full_name,
         coalesce(av.mins, 0), coalesce(ap.booked, 0),
         coalesce(ap.attended, 0), coalesce(ap.no_shows, 0), coalesce(ap.cancelled, 0),
         round(100.0 * coalesce(ap.booked, 0) / nullif(av.mins, 0), 1)
  from public.professionals p
  cross join guard
  left join avail av on av.professional_id = p.id
  left join appts ap on ap.professional_id = p.id
  where p.org_id = p_org and p.active
  order by p.full_name;
$$;

revoke all on function public.org_occupancy(uuid, date, date) from public, anon;
grant execute on function public.org_occupancy(uuid, date, date) to authenticated, service_role;

-- Ingresos aprobados por mes (hora local), tipo de pago y moneda
create or replace view public.v_revenue_monthly
with (security_invoker = true) as
select
  pay.org_id,
  date_trunc('month', coalesce(pay.paid_at, pay.created_at) at time zone o.timezone)::date as month,
  pay.currency,
  pay.kind,
  sum(pay.amount_cents)::bigint as total_cents,
  count(*)::int                 as payments
from public.payments pay
join public.organizations o on o.id = pay.org_id
where pay.status = 'approved'
group by 1, 2, 3, 4;

-- -----------------------------------------------------------------------------
-- Pago manual (efectivo / transferencia) registrado por recepción o admin.
-- Si la cita esperaba anticipo, queda reservada en firme.
-- -----------------------------------------------------------------------------
create or replace function public.record_manual_payment(
  p_org          uuid,
  p_patient      uuid,
  p_amount_cents bigint,
  p_provider     app.payment_provider,
  p_kind         app.payment_kind default 'full',
  p_appointment  uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not (app.is_service_role() or app.is_staff(p_org)) then
    raise exception 'FORBIDDEN' using errcode = 'PA002';
  end if;
  if p_provider not in ('cash', 'transfer') then
    raise exception 'Solo efectivo o transferencia se registran a mano' using errcode = '22023';
  end if;

  insert into public.payments (org_id, patient_id, appointment_id, provider, kind, reference,
                               amount_cents, currency, status, paid_at)
  values (p_org, p_patient, p_appointment, p_provider, p_kind, 'MAN-' || gen_random_uuid(),
          p_amount_cents, (select currency from public.organizations where id = p_org), 'approved', now())
  returning id into v_id;

  if p_appointment is not null then
    update public.appointments
       set status = 'scheduled', hold_expires_at = null
     where id = p_appointment and org_id = p_org and status = 'pending_payment';
  end if;
  return v_id;
end $$;

revoke all on function public.record_manual_payment(uuid, uuid, bigint, app.payment_provider, app.payment_kind, uuid) from public, anon;
grant execute on function public.record_manual_payment(uuid, uuid, bigint, app.payment_provider, app.payment_kind, uuid) to authenticated, service_role;
