-- =============================================================================
-- PsicoAgenda · Esquema núcleo
-- Multi-tenant desde el día 1: cada fila de negocio cuelga de organizations.id.
-- Todas las fechas/horas son timestamptz (se almacenan en UTC). Las horas
-- "de pared" (horarios de atención) se guardan como time + la zona horaria
-- IANA de la organización y se convierten a UTC en app.available_slots().
-- =============================================================================

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

-- Esquema no expuesto por la API REST de Supabase: helpers de seguridad,
-- funciones internas y triggers.
create schema if not exists app;

-- -----------------------------------------------------------------------------
-- Tipos
-- -----------------------------------------------------------------------------
create type app.member_role        as enum ('admin', 'professional', 'receptionist');
create type app.specialty          as enum ('psychology', 'psychiatry', 'general_medicine', 'other');
create type app.insurer_kind       as enum ('eps', 'prepagada', 'convenio', 'aseguradora', 'particular');
create type app.modality           as enum ('in_person', 'online');
create type app.appointment_status as enum (
  'pending_payment',  -- reservada, esperando anticipo (bloquea el hueco)
  'scheduled',        -- reservada y válida
  'confirmed',        -- el paciente confirmó desde el recordatorio
  'completed',
  'cancelled',
  'no_show',
  'rescheduled'       -- sustituida por otra cita (rescheduled_to_id)
);
create type app.booking_channel    as enum ('whatsapp', 'dashboard', 'web');
create type app.bono_status        as enum ('pending_payment', 'active', 'exhausted', 'expired', 'cancelled');
create type app.payment_provider   as enum ('wompi', 'mercadopago', 'stripe', 'cash', 'transfer');
create type app.payment_kind       as enum ('deposit', 'full', 'bono');
create type app.payment_status     as enum ('pending', 'approved', 'declined', 'voided', 'refunded', 'error');
create type app.notification_kind  as enum ('reminder_48h', 'reminder_2h', 'aftercare', 'pre_questionnaire', 'waitlist_offer');
create type app.notification_status as enum ('pending', 'processing', 'sent', 'failed', 'skipped');
create type app.crisis_severity    as enum ('medium', 'high');
create type app.invoice_status     as enum ('draft', 'issued', 'rejected', 'voided');

-- -----------------------------------------------------------------------------
-- Utilidad: updated_at automático
-- -----------------------------------------------------------------------------
create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- Organizaciones (clínicas / consultorios) y personal
-- -----------------------------------------------------------------------------
create table public.organizations (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  country_code          char(2) not null default 'CO',          -- ISO-3166-1
  timezone              text not null default 'America/Bogota', -- IANA
  currency              char(3) not null default 'COP',          -- ISO-4217
  -- WhatsApp Cloud API: el phone_number_id que llega en metadata del webhook
  wa_phone_number_id    text unique,
  wa_display_phone      text,
  -- Líneas de crisis mostradas por el bot: [{ "name": "...", "phone": "..." }]
  crisis_lines          jsonb not null default '[]'::jsonb,
  -- Teléfono E.164 del profesional de guardia para alertas de crisis
  on_call_phone_e164    text,
  consent_text_version  text not null default 'v1',
  settings              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create trigger organizations_touch before update on public.organizations
  for each row execute function app.touch_updated_at();

-- Rechaza zonas horarias que Postgres no conoce (evita descalces de día)
create or replace function app.assert_valid_timezone() returns trigger
language plpgsql as $$
begin
  perform now() at time zone new.timezone;
  return new;
exception when others then
  raise exception 'Zona horaria IANA inválida: %', new.timezone using errcode = '22023';
end $$;
create trigger organizations_tz_check before insert or update of timezone on public.organizations
  for each row execute function app.assert_valid_timezone();

-- Perfil 1:1 con auth.users (Supabase Auth)
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null,
  phone_e164  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger profiles_touch before update on public.profiles
  for each row execute function app.touch_updated_at();

-- RBAC: un usuario puede pertenecer a varias organizaciones con distinto rol
create table public.memberships (
  org_id      uuid not null references public.organizations(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        app.member_role not null,
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id, role)
);
create index memberships_user_idx on public.memberships(user_id);

-- Sedes (físicas o virtual)
create table public.sites (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  name        text not null,
  address     text,
  is_virtual  boolean not null default false,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (org_id, id)
);

create table public.professionals (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  user_id             uuid references auth.users(id) on delete set null,
  full_name           text not null,
  specialty           app.specialty not null,
  license_number      text,                 -- tarjeta profesional / nº colegiado
  phone_e164          text,
  google_calendar_id  text,                 -- sincronización bidireccional (fase 2)
  outlook_calendar_id text,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, user_id)
);
create trigger professionals_touch before update on public.professionals
  for each row execute function app.touch_updated_at();

-- Horario semanal recurrente, en hora local de la organización
create table public.availability_rules (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  professional_id  uuid not null,
  site_id          uuid not null,
  weekday          smallint not null check (weekday between 1 and 7), -- ISO: 1=lunes
  start_time       time not null,
  end_time         time not null,
  slot_minutes     smallint not null default 50 check (slot_minutes between 10 and 240),
  valid_from       date,
  valid_until      date,
  check (end_time > start_time),
  foreign key (org_id, professional_id) references public.professionals(org_id, id) on delete cascade,
  foreign key (org_id, site_id)         references public.sites(org_id, id) on delete cascade
);
create index availability_rules_prof_idx on public.availability_rules(professional_id, weekday);

-- Ausencias / bloqueos puntuales (vacaciones, eventos de Google Calendar)
create table public.time_off (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  professional_id   uuid not null,
  starts_at         timestamptz not null,
  ends_at           timestamptz not null,
  reason            text,
  external_event_id text,   -- id del evento externo si viene de calendario
  check (ends_at > starts_at),
  foreign key (org_id, professional_id) references public.professionals(org_id, id) on delete cascade
);
create index time_off_prof_range_idx on public.time_off using gist (professional_id, tstzrange(starts_at, ends_at));

-- EPS / prepagadas / convenios / particular
create table public.insurers (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  name        text not null,
  code        text,
  kind        app.insurer_kind not null,
  active      boolean not null default true,
  unique (org_id, id)
);

-- Servicios ofertados (primera vez, control, terapia de pareja, medicina general…)
create table public.services (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  name             text not null,
  specialty        app.specialty not null,
  duration_minutes smallint not null default 50,
  price_cents      bigint not null default 0 check (price_cents >= 0),
  deposit_percent  smallint not null default 0 check (deposit_percent in (0, 50, 100)),
  active           boolean not null default true,
  unique (org_id, id)
);

-- -----------------------------------------------------------------------------
-- Pacientes
-- -----------------------------------------------------------------------------
create table public.patients (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references public.organizations(id) on delete cascade,
  -- CC, TI, CE, PA, PPT, RC (Colombia) · DNI, NIE, PAS (España)
  doc_type              text not null check (doc_type ~ '^[A-Z]{2,4}$'),
  doc_number            text not null check (doc_number ~ '^[A-Za-z0-9-]{3,20}$'),
  full_name             text not null,
  birth_date            date,
  sex                   text check (sex in ('F', 'M', 'X')),
  phone_e164            text check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email                 text,
  address               text,
  emergency_contact     jsonb,
  insurer_id            uuid,
  last_professional_id  uuid,
  -- Habeas Data (Ley 1581/2012) / RGPD
  data_consent_at       timestamptz,
  data_consent_version  text,
  whatsapp_opt_in       boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, doc_type, doc_number),
  unique (org_id, id),
  foreign key (org_id, insurer_id)           references public.insurers(org_id, id),
  foreign key (org_id, last_professional_id) references public.professionals(org_id, id)
);
create index patients_phone_idx on public.patients(org_id, phone_e164);
create trigger patients_touch before update on public.patients
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Bonos de terapia (paquetes de N sesiones)
-- -----------------------------------------------------------------------------
create table public.bono_plans (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  service_id      uuid not null,
  name            text not null,
  sessions_total  smallint not null check (sessions_total > 0),
  price_cents     bigint not null check (price_cents >= 0),
  valid_days      smallint not null default 180,
  active          boolean not null default true,
  unique (org_id, id),
  foreign key (org_id, service_id) references public.services(org_id, id)
);

create table public.bonos (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  plan_id         uuid not null,
  patient_id      uuid not null,
  sessions_total  smallint not null check (sessions_total > 0),
  sessions_used   smallint not null default 0,
  status          app.bono_status not null default 'pending_payment',
  purchased_at    timestamptz not null default now(),
  expires_at      timestamptz,
  check (sessions_used between 0 and sessions_total),
  unique (org_id, id),
  foreign key (org_id, plan_id)    references public.bono_plans(org_id, id),
  foreign key (org_id, patient_id) references public.patients(org_id, id) on delete cascade
);
create index bonos_patient_active_idx on public.bonos(patient_id) where status = 'active';

-- -----------------------------------------------------------------------------
-- Citas
-- -----------------------------------------------------------------------------
create table public.appointments (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  patient_id          uuid not null,
  professional_id     uuid not null,
  site_id             uuid not null,
  service_id          uuid not null,
  insurer_id          uuid,
  bono_id             uuid,
  starts_at           timestamptz not null,
  ends_at             timestamptz not null,
  modality            app.modality not null default 'in_person',
  status              app.appointment_status not null default 'scheduled',
  channel             app.booking_channel not null default 'whatsapp',
  online_meeting_url  text,
  confirmed_at        timestamptz,
  cancelled_at        timestamptz,
  cancellation_reason text,
  rescheduled_to_id   uuid references public.appointments(id),
  hold_expires_at     timestamptz,   -- para pending_payment: libera el hueco si no paga
  google_event_id     text,
  created_by          uuid references auth.users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (ends_at > starts_at),
  unique (org_id, id),
  foreign key (org_id, patient_id)      references public.patients(org_id, id) on delete cascade,
  foreign key (org_id, professional_id) references public.professionals(org_id, id),
  foreign key (org_id, site_id)         references public.sites(org_id, id),
  foreign key (org_id, service_id)      references public.services(org_id, id),
  foreign key (org_id, insurer_id)      references public.insurers(org_id, id),
  foreign key (org_id, bono_id)         references public.bonos(org_id, id),
  -- Garantía a nivel de BD: un profesional nunca tiene dos citas activas solapadas,
  -- aunque lleguen dos reservas simultáneas por WhatsApp y por el panel.
  constraint appointments_no_overlap exclude using gist (
    professional_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status in ('pending_payment', 'scheduled', 'confirmed', 'completed'))
);
create index appointments_prof_start_idx    on public.appointments(professional_id, starts_at);
create index appointments_patient_start_idx on public.appointments(patient_id, starts_at desc);
create index appointments_org_start_idx     on public.appointments(org_id, starts_at);
create trigger appointments_touch before update on public.appointments
  for each row execute function app.touch_updated_at();

-- Libro mayor de consumo de bonos (auditable, permite devoluciones)
create table public.bono_movements (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  bono_id         uuid not null,
  appointment_id  uuid,
  delta           smallint not null check (delta in (-1, 1)), -- +1 consume, -1 devuelve
  reason          text not null,
  created_at      timestamptz not null default now(),
  foreign key (org_id, bono_id)        references public.bonos(org_id, id) on delete cascade,
  foreign key (org_id, appointment_id) references public.appointments(org_id, id) on delete set null (appointment_id)
);

create table public.waitlist_entries (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  patient_id       uuid not null,
  professional_id  uuid,          -- null = cualquiera
  service_id       uuid,
  earliest_at      timestamptz,
  latest_at        timestamptz,
  status           text not null default 'waiting' check (status in ('waiting', 'offered', 'booked', 'expired', 'cancelled')),
  offered_slot_at  timestamptz,
  created_at       timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, patient_id)      references public.patients(org_id, id) on delete cascade,
  foreign key (org_id, professional_id) references public.professionals(org_id, id) on delete cascade
);
create index waitlist_waiting_idx on public.waitlist_entries(org_id, professional_id, created_at) where status = 'waiting';

-- -----------------------------------------------------------------------------
-- Pagos y facturación
-- -----------------------------------------------------------------------------
create table public.payments (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  patient_id      uuid not null,
  appointment_id  uuid,
  bono_id         uuid,
  provider        app.payment_provider not null,
  kind            app.payment_kind not null,
  reference       text not null unique,       -- nuestra referencia (idempotencia)
  provider_txn_id text,
  amount_cents    bigint not null check (amount_cents > 0),
  currency        char(3) not null,
  status          app.payment_status not null default 'pending',
  checkout_url    text,
  paid_at         timestamptz,
  raw_event       jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (provider, provider_txn_id),
  foreign key (org_id, patient_id)     references public.patients(org_id, id),
  foreign key (org_id, appointment_id) references public.appointments(org_id, id),
  foreign key (org_id, bono_id)        references public.bonos(org_id, id)
);
create trigger payments_touch before update on public.payments
  for each row execute function app.touch_updated_at();

-- Preparado para facturación electrónica (DIAN en Colombia / VeriFactu en España).
-- La emisión real la hace un proveedor tecnológico; aquí guardamos el resultado.
create table public.invoices (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  patient_id        uuid not null,
  payment_id        uuid references public.payments(id),
  series            text not null,
  number            bigint not null,
  status            app.invoice_status not null default 'draft',
  regime            text not null check (regime in ('dian', 'verifactu', 'none')),
  subtotal_cents    bigint not null,
  tax_lines         jsonb not null default '[]'::jsonb,   -- IVA / retenciones / IRPF
  total_cents       bigint not null,
  currency          char(3) not null,
  fiscal_id         text,      -- CUFE (DIAN) o huella encadenada (VeriFactu)
  qr_payload        text,
  issued_at         timestamptz,
  provider_response jsonb,
  created_at        timestamptz not null default now(),
  unique (org_id, series, number),
  foreign key (org_id, patient_id) references public.patients(org_id, id)
);

-- -----------------------------------------------------------------------------
-- Historia clínica
-- El contenido clínico libre se guarda CIFRADO en la aplicación (AES-256-GCM,
-- clave fuera de la BD), además del cifrado en disco que ya aplica Supabase.
-- -----------------------------------------------------------------------------
create table public.clinical_records (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references public.organizations(id) on delete cascade,
  patient_id             uuid not null,
  opened_by              uuid not null,       -- professional_id
  anamnesis_ciphertext   text,                -- base64(iv || ciphertext+tag)
  key_version            smallint not null default 1,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (org_id, patient_id),
  unique (org_id, id),
  foreign key (org_id, patient_id) references public.patients(org_id, id) on delete cascade,
  foreign key (org_id, opened_by)  references public.professionals(org_id, id)
);
create trigger clinical_records_touch before update on public.clinical_records
  for each row execute function app.touch_updated_at();

create table public.diagnoses (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  record_id        uuid not null,
  professional_id  uuid not null,
  code_system      text not null check (code_system in ('CIE-10', 'CIE-11', 'DSM-5-TR')),
  code             text not null,
  description      text not null,
  is_primary       boolean not null default false,
  diagnosed_at     timestamptz not null default now(),
  resolved_at      timestamptz,
  foreign key (org_id, record_id)       references public.clinical_records(org_id, id) on delete cascade,
  foreign key (org_id, professional_id) references public.professionals(org_id, id)
);

-- Notas de evolución. is_private = true → solo las ve el autor.
create table public.clinical_notes (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  patient_id          uuid not null,
  appointment_id      uuid,
  author_id           uuid not null,          -- professional_id
  is_private          boolean not null default true,
  content_ciphertext  text not null,          -- base64(iv || ciphertext+tag)
  key_version         smallint not null default 1,  -- rotación de claves
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  foreign key (org_id, patient_id)     references public.patients(org_id, id) on delete cascade,
  foreign key (org_id, appointment_id) references public.appointments(org_id, id) on delete set null (appointment_id),
  foreign key (org_id, author_id)      references public.professionals(org_id, id)
);
create index clinical_notes_patient_idx on public.clinical_notes(patient_id, created_at desc);
create trigger clinical_notes_touch before update on public.clinical_notes
  for each row execute function app.touch_updated_at();

-- Documentos adjuntos (los binarios viven en Supabase Storage, bucket privado)
create table public.patient_documents (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  patient_id    uuid not null,
  storage_path  text not null unique,
  kind          text not null check (kind in ('lab_result', 'referral', 'id_document', 'consent', 'other')),
  uploaded_by   uuid references auth.users(id),
  sha256        text not null,
  created_at    timestamptz not null default now(),
  foreign key (org_id, patient_id) references public.patients(org_id, id) on delete cascade
);

-- Consentimientos informados con firma electrónica desde el móvil
create table public.consent_templates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  name        text not null,
  version     text not null,
  body_md     text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (org_id, name, version),
  unique (org_id, id)
);

create table public.consent_signatures (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  patient_id        uuid not null,
  template_id       uuid not null,
  appointment_id    uuid,
  -- Enlace de firma de un solo uso: guardamos solo el hash del token
  sign_token_hash   text unique,
  token_expires_at  timestamptz,
  signed_at         timestamptz,
  signer_ip         inet,
  signer_user_agent text,
  document_sha256   text,          -- hash del documento firmado (integridad)
  signature_path    text,          -- imagen/trazo en Storage
  created_at        timestamptz not null default now(),
  foreign key (org_id, patient_id)  references public.patients(org_id, id) on delete cascade,
  foreign key (org_id, template_id) references public.consent_templates(org_id, id)
);

-- -----------------------------------------------------------------------------
-- WhatsApp: estado conversacional (FSM) e idempotencia
-- -----------------------------------------------------------------------------
create table public.conversations (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  wa_id             text not null,                 -- teléfono del usuario tal como lo envía Meta
  patient_id        uuid,
  state             text not null default 'start',
  context           jsonb not null default '{}'::jsonb,
  -- Bloqueo optimista: cada transición hace UPDATE … WHERE version = :leída
  version           integer not null default 0,
  -- Lease: serializa mensajes simultáneos del mismo usuario entre invocaciones
  locked_until      timestamptz,
  human_handoff     boolean not null default false,
  handoff_reason    text,
  crisis_flag       boolean not null default false,
  last_inbound_at   timestamptz,                   -- abre la ventana de servicio de 24 h
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, wa_id),
  foreign key (org_id, patient_id) references public.patients(org_id, id) on delete set null (patient_id)
);
create index conversations_handoff_idx on public.conversations(org_id, updated_at desc) where human_handoff;
create trigger conversations_touch before update on public.conversations
  for each row execute function app.touch_updated_at();

-- Cada mensaje entrante se registra por su wamid: los reintentos de Meta
-- chocan con la PK y se descartan (procesamiento exactly-once).
create table public.wa_inbound_messages (
  wamid         text primary key,
  org_id        uuid not null references public.organizations(id) on delete cascade,
  wa_id         text not null,
  msg_type      text not null,
  payload       jsonb not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  error         text
);
create index wa_inbound_pending_idx on public.wa_inbound_messages(received_at) where processed_at is null;

create table public.wa_outbound_messages (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  wa_id              text not null,
  kind               text not null,                -- text | interactive | template
  template_name      text,
  payload            jsonb not null,
  provider_msg_id    text unique,
  status             text not null default 'queued', -- queued|sent|delivered|read|failed
  error              text,
  notification_id    uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger wa_outbound_touch before update on public.wa_outbound_messages
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Notificaciones programadas (recordatorios 48 h / 2 h, aftercare, lista de espera)
-- -----------------------------------------------------------------------------
create table public.scheduled_notifications (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  appointment_id     uuid,
  waitlist_entry_id  uuid,
  kind               app.notification_kind not null,
  send_at            timestamptz not null,
  status             app.notification_status not null default 'pending',
  attempts           smallint not null default 0,
  last_error         text,
  sent_at            timestamptz,
  created_at         timestamptz not null default now(),
  foreign key (org_id, appointment_id)    references public.appointments(org_id, id) on delete cascade,
  foreign key (org_id, waitlist_entry_id) references public.waitlist_entries(org_id, id) on delete cascade
);
create unique index scheduled_notifications_appt_kind_uq
  on public.scheduled_notifications(appointment_id, kind) where appointment_id is not null;
create index scheduled_notifications_due_idx
  on public.scheduled_notifications(send_at) where status = 'pending';

-- -----------------------------------------------------------------------------
-- Protocolo de crisis
-- -----------------------------------------------------------------------------
create table public.crisis_events (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  patient_id       uuid,
  wamid            text,
  severity         app.crisis_severity not null,
  matched_rules    text[] not null,
  on_call_notified boolean not null default false,
  acknowledged_by  uuid references auth.users(id),
  acknowledged_at  timestamptz,
  resolution_notes text,
  created_at       timestamptz not null default now()
);
create index crisis_events_open_idx on public.crisis_events(org_id, created_at desc) where acknowledged_at is null;

-- -----------------------------------------------------------------------------
-- Auditoría de acceso a datos clínicos (ISO 27001 A.8.15 / RGPD art. 30)
-- -----------------------------------------------------------------------------
create table public.audit_log (
  id          bigint generated always as identity primary key,
  org_id      uuid,
  actor_id    uuid,
  action      text not null,
  table_name  text not null,
  record_id   uuid,
  at          timestamptz not null default now()
);
create index audit_log_org_at_idx on public.audit_log(org_id, at desc);
