-- =============================================================================
-- PsicoAgenda · Control de acceso (RBAC) con Row Level Security
--
-- Modelo:
--   admin         → configuración, finanzas, métricas. NO lee contenido clínico.
--   receptionist  → agenda, pacientes (datos demográficos), pagos, bandeja WhatsApp.
--   professional  → su agenda y la historia clínica de SUS pacientes.
--                   Las notas privadas solo las ve su autor.
--   service_role  → Edge Functions (bot, recordatorios). Salta RLS por diseño.
-- =============================================================================

grant usage on schema app to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Helpers (security definer: consultan memberships sin recursión de RLS)
-- -----------------------------------------------------------------------------
create or replace function app.has_role(p_org uuid, p_roles app.member_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org
      and m.user_id = (select auth.uid())
      and m.role = any (p_roles)
  );
$$;

create or replace function app.is_member(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org and m.user_id = (select auth.uid())
  );
$$;

create or replace function app.is_staff(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app.has_role(p_org, array['admin', 'receptionist']::app.member_role[]);
$$;

create or replace function app.my_professional_id(p_org uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select p.id from public.professionals p
  where p.org_id = p_org and p.user_id = (select auth.uid()) and p.active
  limit 1;
$$;

-- ¿El usuario actual es profesional tratante de este paciente?
create or replace function app.treats_patient(p_org uuid, p_patient uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app.has_role(p_org, array['professional']::app.member_role[])
     and exists (
       select 1 from public.appointments a
       where a.org_id = p_org
         and a.patient_id = p_patient
         and a.professional_id = app.my_professional_id(p_org)
     );
$$;

revoke all on function app.has_role(uuid, app.member_role[]), app.is_member(uuid), app.is_staff(uuid),
  app.my_professional_id(uuid), app.treats_patient(uuid, uuid) from public, anon;
grant execute on function app.has_role(uuid, app.member_role[]), app.is_member(uuid), app.is_staff(uuid),
  app.my_professional_id(uuid), app.treats_patient(uuid, uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Activar RLS en todas las tablas de public (sin políticas = denegado)
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Organización y personal
-- -----------------------------------------------------------------------------
create policy org_select on public.organizations for select to authenticated
  using (app.is_member(id));
create policy org_update on public.organizations for update to authenticated
  using (app.has_role(id, array['admin']::app.member_role[]))
  with check (app.has_role(id, array['admin']::app.member_role[]));

create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid())
         or exists (select 1 from public.memberships m1
                    join public.memberships m2 on m2.org_id = m1.org_id
                    where m1.user_id = (select auth.uid()) and m2.user_id = profiles.id));
create policy profiles_insert_self on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy memberships_select on public.memberships for select to authenticated
  using (app.is_member(org_id));
create policy memberships_admin on public.memberships for all to authenticated
  using (app.has_role(org_id, array['admin']::app.member_role[]))
  with check (app.has_role(org_id, array['admin']::app.member_role[]));

-- Catálogos: lectura para cualquier miembro, escritura solo admin
do $$
declare t text;
begin
  foreach t in array array['sites', 'professionals', 'insurers', 'services', 'bono_plans', 'consent_templates'] loop
    execute format($f$
      create policy %1$s_select on public.%1$I for select to authenticated
        using (app.is_member(org_id));
      create policy %1$s_admin on public.%1$I for all to authenticated
        using (app.has_role(org_id, array['admin']::app.member_role[]))
        with check (app.has_role(org_id, array['admin']::app.member_role[]));
    $f$, t);
  end loop;
end $$;

-- Horarios y ausencias: admin o el propio profesional
do $$
declare t text;
begin
  foreach t in array array['availability_rules', 'time_off'] loop
    execute format($f$
      create policy %1$s_select on public.%1$I for select to authenticated
        using (app.is_member(org_id));
      create policy %1$s_write on public.%1$I for all to authenticated
        using (app.has_role(org_id, array['admin']::app.member_role[])
               or professional_id = app.my_professional_id(org_id))
        with check (app.has_role(org_id, array['admin']::app.member_role[])
                    or professional_id = app.my_professional_id(org_id));
    $f$, t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Pacientes y citas
-- -----------------------------------------------------------------------------
create policy patients_select on public.patients for select to authenticated
  using (app.is_staff(org_id) or app.treats_patient(org_id, id));
create policy patients_insert on public.patients for insert to authenticated
  with check (app.is_staff(org_id) or app.has_role(org_id, array['professional']::app.member_role[]));
create policy patients_update on public.patients for update to authenticated
  using (app.is_staff(org_id) or app.treats_patient(org_id, id))
  with check (app.is_staff(org_id) or app.treats_patient(org_id, id));
-- Sin política DELETE: la historia clínica tiene retención legal obligatoria.

create policy appointments_select on public.appointments for select to authenticated
  using (app.is_staff(org_id) or professional_id = app.my_professional_id(org_id));
create policy appointments_insert on public.appointments for insert to authenticated
  with check (app.is_staff(org_id) or professional_id = app.my_professional_id(org_id));
create policy appointments_update on public.appointments for update to authenticated
  using (app.is_staff(org_id) or professional_id = app.my_professional_id(org_id))
  with check (app.is_staff(org_id) or professional_id = app.my_professional_id(org_id));

create policy waitlist_staff on public.waitlist_entries for all to authenticated
  using (app.is_staff(org_id)) with check (app.is_staff(org_id));

-- -----------------------------------------------------------------------------
-- Bonos, pagos, facturas: finanzas = admin + recepción
-- (los pagos los escriben solo las Edge Functions al recibir el webhook de la pasarela)
-- -----------------------------------------------------------------------------
create policy bonos_select on public.bonos for select to authenticated
  using (app.is_staff(org_id) or app.treats_patient(org_id, patient_id));
create policy bonos_staff_insert on public.bonos for insert to authenticated
  with check (app.is_staff(org_id));
create policy bonos_staff_update on public.bonos for update to authenticated
  using (app.is_staff(org_id)) with check (app.is_staff(org_id));

create policy bono_movements_select on public.bono_movements for select to authenticated
  using (app.is_staff(org_id));
create policy payments_select on public.payments for select to authenticated
  using (app.is_staff(org_id));
create policy invoices_select on public.invoices for select to authenticated
  using (app.is_staff(org_id));

-- -----------------------------------------------------------------------------
-- Historia clínica: solo profesionales tratantes (admin y recepción NO acceden)
-- -----------------------------------------------------------------------------
create policy clinical_records_rw on public.clinical_records for all to authenticated
  using (app.treats_patient(org_id, patient_id))
  with check (app.treats_patient(org_id, patient_id));

create policy diagnoses_select on public.diagnoses for select to authenticated
  using (exists (select 1 from public.clinical_records r
                 where r.id = diagnoses.record_id and app.treats_patient(r.org_id, r.patient_id)));
create policy diagnoses_write on public.diagnoses for insert to authenticated
  with check (professional_id = app.my_professional_id(org_id)
              and exists (select 1 from public.clinical_records r
                          where r.id = diagnoses.record_id and app.treats_patient(r.org_id, r.patient_id)));
create policy diagnoses_update on public.diagnoses for update to authenticated
  using (professional_id = app.my_professional_id(org_id))
  with check (professional_id = app.my_professional_id(org_id));

create policy clinical_notes_select on public.clinical_notes for select to authenticated
  using (author_id = app.my_professional_id(org_id)
         or (not is_private and app.treats_patient(org_id, patient_id)));
create policy clinical_notes_insert on public.clinical_notes for insert to authenticated
  with check (author_id = app.my_professional_id(org_id) and app.treats_patient(org_id, patient_id));
create policy clinical_notes_update on public.clinical_notes for update to authenticated
  using (author_id = app.my_professional_id(org_id))
  with check (author_id = app.my_professional_id(org_id));
-- Sin DELETE: las correcciones se hacen con una nota nueva (trazabilidad).

create policy patient_documents_select on public.patient_documents for select to authenticated
  using (app.is_staff(org_id) or app.treats_patient(org_id, patient_id));
create policy patient_documents_insert on public.patient_documents for insert to authenticated
  with check (app.is_staff(org_id) or app.treats_patient(org_id, patient_id));

create policy consent_signatures_select on public.consent_signatures for select to authenticated
  using (app.is_staff(org_id) or app.treats_patient(org_id, patient_id));

-- -----------------------------------------------------------------------------
-- WhatsApp y crisis
-- -----------------------------------------------------------------------------
create policy conversations_staff_select on public.conversations for select to authenticated
  using (app.is_staff(org_id));
-- Recepción puede tomar / devolver la conversación (human handoff)
create policy conversations_staff_update on public.conversations for update to authenticated
  using (app.is_staff(org_id)) with check (app.is_staff(org_id));

create policy wa_inbound_staff on public.wa_inbound_messages for select to authenticated
  using (app.is_staff(org_id));
create policy wa_outbound_staff on public.wa_outbound_messages for select to authenticated
  using (app.is_staff(org_id));
create policy notifications_staff on public.scheduled_notifications for select to authenticated
  using (app.is_staff(org_id));

-- Cualquier miembro del equipo ve y atiende alertas de crisis
create policy crisis_select on public.crisis_events for select to authenticated
  using (app.is_member(org_id));
create policy crisis_ack on public.crisis_events for update to authenticated
  using (app.is_member(org_id)) with check (app.is_member(org_id));

create policy audit_admin on public.audit_log for select to authenticated
  using (app.has_role(org_id, array['admin']::app.member_role[]));

-- -----------------------------------------------------------------------------
-- Auditoría automática de escrituras sobre datos clínicos
-- -----------------------------------------------------------------------------
create or replace function app.audit_clinical_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_id  uuid;
begin
  if tg_op = 'DELETE' then
    v_org := old.org_id; v_id := old.id;
  else
    v_org := new.org_id; v_id := new.id;
  end if;
  insert into public.audit_log (org_id, actor_id, action, table_name, record_id)
  values (v_org, (select auth.uid()), lower(tg_op), tg_table_name, v_id);
  return null;
end $$;

create trigger clinical_records_audit after insert or update or delete on public.clinical_records
  for each row execute function app.audit_clinical_write();
create trigger clinical_notes_audit after insert or update or delete on public.clinical_notes
  for each row execute function app.audit_clinical_write();
create trigger diagnoses_audit after insert or update or delete on public.diagnoses
  for each row execute function app.audit_clinical_write();
