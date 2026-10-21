-- =============================================================================
-- PsicoAgenda · Lógica de agenda, bonos y notificaciones dentro de Postgres
-- Vive en la BD para que sea atómica y gratuita (sin servidor propio):
-- el bot y el panel llaman a estas funciones vía supabase.rpc().
-- =============================================================================

-- ¿Quién llama? service_role (Edge Functions) o un miembro con rol permitido.
-- OJO: se basa SOLO en el claim del JWT. No usar current_user: dentro de una
-- función security definer vale el dueño (postgres) y daría true a cualquiera.
create or replace function app.is_service_role()
returns boolean language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role';
$$;

-- -----------------------------------------------------------------------------
-- Huecos disponibles: horario semanal (hora local) → instantes UTC
-- -----------------------------------------------------------------------------
create or replace function public.available_slots(
  p_org           uuid,
  p_professional  uuid,
  p_site          uuid,
  p_from          date,
  p_days          integer default 7,
  p_min_lead      interval default interval '2 hours'
) returns table (starts_at timestamptz, ends_at timestamptz, site_id uuid)
language sql stable security definer set search_path = '' as $$
  with org as (
    select o.timezone as tz from public.organizations o
    where o.id = p_org and (app.is_service_role() or app.is_member(p_org))
  ),
  days as (
    select d::date as day
    from generate_series(p_from::timestamp, (p_from + (least(p_days, 31) - 1))::timestamp, interval '1 day') d
  ),
  rules as (
    select r.*, days.day
    from public.availability_rules r
    join days on extract(isodow from days.day) = r.weekday
    where r.org_id = p_org
      and r.professional_id = p_professional
      and (p_site is null or r.site_id = p_site)
      and (r.valid_from  is null or days.day >= r.valid_from)
      and (r.valid_until is null or days.day <= r.valid_until)
  ),
  local_slots as (
    select gs as local_start,
           gs + make_interval(mins => r.slot_minutes) as local_end,
           r.site_id
    from rules r,
         generate_series(
           r.day + r.start_time,
           r.day + r.end_time - make_interval(mins => r.slot_minutes),
           make_interval(mins => r.slot_minutes)
         ) gs
  ),
  utc_slots as (
    -- timestamp sin zona AT TIME ZONE tz → timestamptz (gestiona horario de verano)
    select (s.local_start at time zone org.tz) as starts_at,
           (s.local_end   at time zone org.tz) as ends_at,
           s.site_id
    from local_slots s cross join org
  )
  select u.starts_at, u.ends_at, u.site_id
  from utc_slots u
  where u.starts_at >= now() + p_min_lead
    and not exists (
      select 1 from public.appointments a
      where a.professional_id = p_professional
        and a.status in ('pending_payment', 'scheduled', 'confirmed', 'completed')
        and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(u.starts_at, u.ends_at, '[)')
    )
    and not exists (
      select 1 from public.time_off t
      where t.professional_id = p_professional
        and tstzrange(t.starts_at, t.ends_at, '[)') && tstzrange(u.starts_at, u.ends_at, '[)')
    )
  order by u.starts_at;
$$;

-- -----------------------------------------------------------------------------
-- Reserva atómica: valida hueco, consume bono o exige anticipo
-- Errores de negocio con SQLSTATE propio para que el bot los traduzca:
--   PA001 SLOT_NOT_AVAILABLE · PA002 FORBIDDEN · PA003 NOT_FOUND
-- -----------------------------------------------------------------------------
create or replace function public.book_appointment(
  p_org           uuid,
  p_patient       uuid,
  p_professional  uuid,
  p_site          uuid,
  p_service       uuid,
  p_starts_at     timestamptz,
  p_modality      app.modality default 'in_person',
  p_insurer       uuid default null,
  p_channel       app.booking_channel default 'whatsapp',
  p_use_bono      boolean default true
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_service   public.services%rowtype;
  v_bono      public.bonos%rowtype;
  v_ends_at   timestamptz;
  v_status    app.appointment_status;
  v_hold      timestamptz;
  v_appt_id   uuid;
  v_deposit   bigint := 0;
  v_remaining integer;
begin
  if not (app.is_service_role() or app.is_staff(p_org)
          or p_professional = app.my_professional_id(p_org)) then
    raise exception 'FORBIDDEN' using errcode = 'PA002';
  end if;

  select * into v_service from public.services
  where id = p_service and org_id = p_org and active;
  if not found then
    raise exception 'SERVICE_NOT_FOUND' using errcode = 'PA003';
  end if;

  -- El hueco debe existir en el horario publicado (evita reservar a deshoras)
  select s.ends_at into v_ends_at
  from public.available_slots(p_org, p_professional, p_site,
                              (p_starts_at at time zone 'UTC')::date - 1, 3, interval '0') s
  where s.starts_at = p_starts_at
  limit 1;
  if v_ends_at is null then
    raise exception 'SLOT_NOT_AVAILABLE' using errcode = 'PA001';
  end if;
  -- La duración del servicio manda si es menor que el hueco
  v_ends_at := least(v_ends_at, p_starts_at + make_interval(mins => v_service.duration_minutes));

  -- ¿Tiene bono activo para este servicio? (bloquea la fila: sin doble consumo)
  if p_use_bono then
    select b.* into v_bono
    from public.bonos b
    join public.bono_plans bp on bp.id = b.plan_id
    where b.org_id = p_org and b.patient_id = p_patient and b.status = 'active'
      and bp.service_id = p_service
      and b.sessions_used < b.sessions_total
      and (b.expires_at is null or b.expires_at > p_starts_at)
    order by b.expires_at nulls last
    limit 1
    for update of b;
  end if;

  if v_bono.id is not null then
    v_status := 'scheduled';
  elsif v_service.deposit_percent > 0 and v_service.price_cents > 0 then
    v_status  := 'pending_payment';
    v_hold    := now() + interval '30 minutes';
    v_deposit := v_service.price_cents * v_service.deposit_percent / 100;
  else
    v_status := 'scheduled';
  end if;

  begin
    insert into public.appointments (
      org_id, patient_id, professional_id, site_id, service_id, insurer_id, bono_id,
      starts_at, ends_at, modality, status, channel, hold_expires_at
    ) values (
      p_org, p_patient, p_professional, p_site, p_service, p_insurer, v_bono.id,
      p_starts_at, v_ends_at, p_modality, v_status, p_channel, v_hold
    ) returning id into v_appt_id;
  exception when exclusion_violation then
    -- Otra reserva ganó la carrera por el mismo hueco
    raise exception 'SLOT_NOT_AVAILABLE' using errcode = 'PA001';
  end;

  if v_bono.id is not null then
    update public.bonos
       set sessions_used = sessions_used + 1,
           status = case when sessions_used + 1 >= sessions_total
                         then 'exhausted'::app.bono_status else status end
     where id = v_bono.id
    returning sessions_total - sessions_used into v_remaining;
    insert into public.bono_movements (org_id, bono_id, appointment_id, delta, reason)
    values (p_org, v_bono.id, v_appt_id, 1, 'booking');
  end if;

  -- Continuidad terapéutica: recordar el último profesional
  update public.patients set last_professional_id = p_professional
  where id = p_patient and org_id = p_org;

  return jsonb_build_object(
    'appointment_id', v_appt_id,
    'status', v_status,
    'starts_at', p_starts_at,
    'ends_at', v_ends_at,
    'deposit_cents', v_deposit,
    'currency', (select currency from public.organizations where id = p_org),
    'bono_id', v_bono.id,
    'bono_sessions_remaining', v_remaining,
    'hold_expires_at', v_hold
  );
end $$;

-- -----------------------------------------------------------------------------
-- Ciclo de vida de la cita → notificaciones, devolución de bono, lista de espera
-- -----------------------------------------------------------------------------
create or replace function app.on_appointment_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_late_hours integer;
  v_wait       public.waitlist_entries%rowtype;
begin
  if new.status in ('scheduled', 'confirmed') then
    insert into public.scheduled_notifications (org_id, appointment_id, kind, send_at)
    select new.org_id, new.id, k.kind, k.send_at
    from (values
      ('reminder_48h'::app.notification_kind, new.starts_at - interval '48 hours'),
      ('reminder_2h'::app.notification_kind,  new.starts_at - interval '2 hours'),
      ('aftercare'::app.notification_kind,    new.ends_at   + interval '2 hours')
    ) as k(kind, send_at)
    where k.send_at > now()
    on conflict (appointment_id, kind) where appointment_id is not null
    do update set send_at = excluded.send_at, status = 'pending', attempts = 0
      where public.scheduled_notifications.status <> 'sent'
        and public.scheduled_notifications.send_at <> excluded.send_at;
  end if;

  if tg_op = 'UPDATE' and new.status in ('cancelled', 'no_show', 'rescheduled')
     and old.status is distinct from new.status then

    update public.scheduled_notifications
       set status = 'skipped'
     where appointment_id = new.id and status in ('pending', 'failed')
       and kind in ('reminder_48h', 'reminder_2h', 'aftercare');

    -- Devolver la sesión del bono si se cancela con antelación suficiente
    if new.status in ('cancelled', 'rescheduled') and new.bono_id is not null then
      select coalesce((settings ->> 'late_cancel_hours')::int, 24) into v_late_hours
      from public.organizations where id = new.org_id;
      if coalesce(new.cancelled_at, now()) <= new.starts_at - make_interval(hours => v_late_hours) then
        update public.bonos
           set sessions_used = sessions_used - 1,
               status = case when status = 'exhausted' then 'active'::app.bono_status else status end
         where id = new.bono_id and sessions_used > 0;
        insert into public.bono_movements (org_id, bono_id, appointment_id, delta, reason)
        values (new.org_id, new.bono_id, new.id, -1, 'cancellation_refund');
      end if;
    end if;

    -- Hueco liberado: ofrecerlo al primero de la lista de espera
    if new.status in ('cancelled', 'rescheduled') and new.starts_at > now() + interval '2 hours' then
      select * into v_wait from public.waitlist_entries w
      where w.org_id = new.org_id and w.status = 'waiting'
        and (w.professional_id is null or w.professional_id = new.professional_id)
        and (w.service_id is null or w.service_id = new.service_id)
        and (w.earliest_at is null or w.earliest_at <= new.starts_at)
        and (w.latest_at   is null or w.latest_at   >= new.starts_at)
      order by w.created_at
      limit 1
      for update skip locked;
      if found then
        update public.waitlist_entries set status = 'offered', offered_slot_at = new.starts_at
        where id = v_wait.id;
        insert into public.scheduled_notifications (org_id, waitlist_entry_id, kind, send_at)
        values (new.org_id, v_wait.id, 'waitlist_offer', now());
      end if;
    end if;
  end if;
  return null;
end $$;

create trigger appointments_lifecycle
  after insert or update of status, starts_at, ends_at on public.appointments
  for each row execute function app.on_appointment_change();

-- Libera huecos reservados cuyo anticipo no se pagó a tiempo (lo llama pg_cron)
create or replace function app.release_expired_holds() returns integer
language sql security definer set search_path = '' as $$
  with released as (
    update public.appointments
       set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'payment_timeout'
     where status = 'pending_payment' and hold_expires_at < now()
    returning 1
  )
  select count(*)::int from released;
$$;

-- -----------------------------------------------------------------------------
-- Cola de notificaciones: el dispatcher reclama lotes sin pisarse (SKIP LOCKED)
-- -----------------------------------------------------------------------------
create or replace function public.claim_due_notifications(p_limit integer default 50)
returns setof public.scheduled_notifications
language plpgsql security definer set search_path = '' as $$
begin
  if not app.is_service_role() then
    raise exception 'FORBIDDEN' using errcode = 'PA002';
  end if;

  -- Recupera envíos que quedaron colgados (función caída a mitad de lote)
  update public.scheduled_notifications
     set status = 'pending'
   where status = 'processing' and sent_at is null
     and send_at < now() - interval '15 minutes'
     and attempts < 5;

  return query
  update public.scheduled_notifications n
     set status = 'processing', attempts = n.attempts + 1
   where n.id in (
     select s.id from public.scheduled_notifications s
     where s.status = 'pending' and s.send_at <= now() and s.attempts < 5
     order by s.send_at
     limit least(p_limit, 200)
     for update skip locked
   )
  returning n.*;
end $$;

revoke all on function public.claim_due_notifications(integer) from public, anon, authenticated;
grant execute on function public.claim_due_notifications(integer) to service_role;
revoke all on function public.book_appointment(uuid, uuid, uuid, uuid, uuid, timestamptz, app.modality, uuid, app.booking_channel, boolean) from public, anon;
grant execute on function public.book_appointment(uuid, uuid, uuid, uuid, uuid, timestamptz, app.modality, uuid, app.booking_channel, boolean) to authenticated, service_role;
revoke all on function public.available_slots(uuid, uuid, uuid, date, integer, interval) from public, anon;
grant execute on function public.available_slots(uuid, uuid, uuid, date, integer, interval) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Métricas para el dashboard (respeta RLS del que consulta)
-- -----------------------------------------------------------------------------
create or replace view public.v_attendance_monthly
with (security_invoker = true) as
select
  a.org_id,
  a.professional_id,
  date_trunc('month', a.starts_at at time zone o.timezone)::date as month,
  count(*) filter (where a.status in ('completed', 'no_show', 'confirmed', 'scheduled')) as booked,
  count(*) filter (where a.status = 'completed') as attended,
  count(*) filter (where a.status = 'no_show')   as no_shows,
  count(*) filter (where a.status = 'cancelled') as cancelled,
  round(100.0 * count(*) filter (where a.status = 'no_show')
        / nullif(count(*) filter (where a.status in ('completed', 'no_show')), 0), 1) as no_show_rate_pct
from public.appointments a
join public.organizations o on o.id = a.org_id
group by 1, 2, 3;
