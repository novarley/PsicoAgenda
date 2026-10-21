// Datos de la agenda. Producción: Supabase (RLS + funciones available_slots / book_appointment,
// las mismas que usa el bot de WhatsApp). Demo: memoria.
import { isDemo, supabase } from '../../lib/supabase';
import { db, demoChanged, demoTimezone, uid, visibleAppointments, visiblePatients, type Row } from '../../demo/store';
import { dayRangeUtc, zonedToUtc } from '../../lib/time';

export interface AgendaAppointment {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  modality: 'in_person' | 'online';
  channel: string;
  professional_id: string;
  patient_id: string;
  patient_name: string;
  service_name: string;
  service_price_cents: number;
  service_deposit_percent: number;
  site_name: string;
  hold_expires_at: string | null;
}

export interface Catalog {
  professionals: { id: string; name: string; specialty: string }[];
  sites: { id: string; name: string; is_virtual: boolean }[];
  services: { id: string; name: string; specialty: string; duration_minutes: number; price_cents: number; deposit_percent: number }[];
}

export interface PatientHit { id: string; full_name: string; doc_type: string; doc_number: string; phone_e164: string | null }
export interface Slot { starts_at: string; ends_at: string; site_id: string }
export type BookResult = { ok: true; status: string; deposit_cents: number } | { ok: false; error: string };

export interface AgendaApi {
  day(orgId: string, dateKey: string, timeZone: string): Promise<AgendaAppointment[]>;
  catalog(orgId: string): Promise<Catalog>;
  slots(orgId: string, professionalId: string, siteId: string | null, dateKey: string): Promise<Slot[]>;
  searchPatients(orgId: string, q: string): Promise<PatientHit[]>;
  book(input: { orgId: string; patientId: string; professionalId: string; siteId: string; serviceId: string; startsAt: string; modality: 'in_person' | 'online' }): Promise<BookResult>;
  setStatus(id: string, status: string): Promise<void>;
  recordPayment(input: { orgId: string; patientId: string; appointmentId: string; amountCents: number; provider: 'cash' | 'transfer'; kind: 'deposit' | 'full' }): Promise<void>;
}

const APPT_COLS = `id, starts_at, ends_at, status, modality, channel, professional_id, patient_id, hold_expires_at,
  patients(full_name), services(name, price_cents, deposit_percent), sites(name)`;

function one<T>(rel: unknown): T | null {
  return ((Array.isArray(rel) ? rel[0] : rel) as T | undefined) ?? null;
}

export function toAppointment(r: Record<string, unknown>): AgendaAppointment {
  const svc = one<{ name: string; price_cents: number; deposit_percent: number }>(r.services);
  return {
    id: r.id as string, starts_at: r.starts_at as string, ends_at: r.ends_at as string, status: r.status as string,
    modality: r.modality as 'in_person' | 'online', channel: r.channel as string,
    professional_id: r.professional_id as string, patient_id: r.patient_id as string,
    patient_name: one<{ full_name: string }>(r.patients)?.full_name ?? '—',
    service_name: svc?.name ?? '—', service_price_cents: svc?.price_cents ?? 0, service_deposit_percent: svc?.deposit_percent ?? 0,
    site_name: one<{ name: string }>(r.sites)?.name ?? '—',
    hold_expires_at: (r.hold_expires_at as string | null) ?? null,
  };
}

const supabaseAgenda: AgendaApi = {
  async day(orgId, dateKey, timeZone) {
    const [from, to] = dayRangeUtc(dateKey, timeZone);
    const { data, error } = await supabase.from('appointments').select(APPT_COLS)
      .eq('org_id', orgId).gte('starts_at', from).lt('starts_at', to).order('starts_at');
    if (error) throw error;
    return data.map(toAppointment);
  },
  async catalog(orgId) {
    const [p, s, v] = await Promise.all([
      supabase.from('professionals').select('id, full_name, specialty').eq('org_id', orgId).eq('active', true).order('full_name'),
      supabase.from('sites').select('id, name, is_virtual').eq('org_id', orgId).eq('active', true).order('name'),
      supabase.from('services').select('id, name, specialty, duration_minutes, price_cents, deposit_percent').eq('org_id', orgId).eq('active', true).order('name'),
    ]);
    for (const r of [p, s, v]) if (r.error) throw r.error;
    return {
      professionals: p.data!.map((x) => ({ id: x.id, name: x.full_name, specialty: x.specialty })),
      sites: s.data!, services: v.data!,
    };
  },
  async slots(orgId, professionalId, siteId, dateKey) {
    const { data, error } = await supabase.rpc('available_slots', {
      p_org: orgId, p_professional: professionalId, p_site: siteId, p_from: dateKey, p_days: 1, p_min_lead: '0 minutes',
    });
    if (error) throw error;
    return (data as Slot[]).map((x) => ({ ...x, starts_at: new Date(x.starts_at).toISOString(), ends_at: new Date(x.ends_at).toISOString() }));
  },
  async searchPatients(orgId, q) {
    const term = q.trim().replace(/[%,()]/g, ' ');
    let query = supabase.from('patients').select('id, full_name, doc_type, doc_number, phone_e164').eq('org_id', orgId).order('full_name').limit(10);
    if (term) query = query.or(`full_name.ilike.%${term}%,doc_number.ilike.%${term}%,phone_e164.ilike.%${term}%`);
    const { data, error } = await query;
    if (error) throw error;
    return data;
  },
  async book(i) {
    const { data, error } = await supabase.rpc('book_appointment', {
      p_org: i.orgId, p_patient: i.patientId, p_professional: i.professionalId, p_site: i.siteId,
      p_service: i.serviceId, p_starts_at: i.startsAt, p_modality: i.modality, p_channel: 'dashboard',
    });
    if (error) {
      return { ok: false, error: error.code === 'PA001' ? 'Ese horario ya no está disponible.' : error.message };
    }
    const r = data as { status: string; deposit_cents: number };
    return { ok: true, status: r.status, deposit_cents: Number(r.deposit_cents) };
  },
  async setStatus(id, status) {
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { status };
    if (status === 'confirmed') patch.confirmed_at = now;
    if (status === 'cancelled') { patch.cancelled_at = now; patch.cancellation_reason = 'staff_dashboard'; }
    const { error } = await supabase.from('appointments').update(patch).eq('id', id);
    if (error) throw error;
  },
  async recordPayment(i) {
    const { error } = await supabase.rpc('record_manual_payment', {
      p_org: i.orgId, p_patient: i.patientId, p_amount_cents: i.amountCents, p_provider: i.provider,
      p_kind: i.kind, p_appointment: i.appointmentId,
    });
    if (error) throw error;
  },
};

// ----------------------------------------------------------------------- demo
function demoJoin(a: Row): AgendaAppointment {
  const t = db();
  return toAppointment({
    ...a,
    patients: t.patients.find((p) => p.id === a.patient_id),
    services: t.services.find((s) => s.id === a.service_id),
    sites: t.sites.find((s) => s.id === a.site_id),
  });
}

const ACTIVE = ['pending_payment', 'scheduled', 'confirmed', 'completed'];

const demoAgenda: AgendaApi = {
  async day(_orgId, dateKey, timeZone) {
    const [from, to] = dayRangeUtc(dateKey, timeZone);
    return visibleAppointments()
      .filter((a) => String(a.starts_at) >= from && String(a.starts_at) < to)
      .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)))
      .map(demoJoin);
  },
  async catalog() {
    const t = db();
    return {
      professionals: t.professionals.filter((p) => p.active).map((p) => ({ id: p.id, name: String(p.full_name), specialty: String(p.specialty) })),
      sites: t.sites.filter((s) => s.active) as unknown as Catalog['sites'],
      services: t.services.filter((s) => s.active) as unknown as Catalog['services'],
    };
  },
  async slots(_orgId, professionalId, siteId, dateKey) {
    const t = db();
    const weekday = ((new Date(`${dateKey}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
    const busy = t.appointments.filter((a) => a.professional_id === professionalId && ACTIVE.includes(String(a.status)));
    const out: Slot[] = [];
    for (const r of t.availability_rules.filter((r) => r.professional_id === professionalId && r.weekday === weekday && (!siteId || r.site_id === siteId))) {
      const [sh, sm] = String(r.start_time).split(':').map(Number);
      const [eh, em] = String(r.end_time).split(':').map(Number);
      for (let m = sh * 60 + sm; m + Number(r.slot_minutes) <= eh * 60 + em; m += Number(r.slot_minutes)) {
        const starts = zonedToUtc(dateKey, `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, demoTimezone);
        const ends = new Date(new Date(starts).getTime() + Number(r.slot_minutes) * 60_000).toISOString();
        const taken = busy.some((a) => String(a.starts_at) < ends && String(a.ends_at) > starts);
        if (!taken && new Date(starts) > new Date()) out.push({ starts_at: starts, ends_at: ends, site_id: String(r.site_id) });
      }
    }
    return out.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  },
  async searchPatients(_orgId, q) {
    const term = q.trim().toLowerCase();
    return visiblePatients()
      .filter((p) => !term || `${p.full_name} ${p.doc_number} ${p.phone_e164}`.toLowerCase().includes(term))
      .slice(0, 10) as unknown as PatientHit[];
  },
  async book(i) {
    const t = db();
    const svc = t.services.find((s) => s.id === i.serviceId)!;
    const ends = new Date(new Date(i.startsAt).getTime() + Number(svc.duration_minutes) * 60_000).toISOString();
    const clash = t.appointments.some((a) => a.professional_id === i.professionalId && ACTIVE.includes(String(a.status))
      && String(a.starts_at) < ends && String(a.ends_at) > i.startsAt);
    if (clash) return { ok: false, error: 'Ese horario ya no está disponible.' };
    const deposit = Number(svc.price_cents) * Number(svc.deposit_percent) / 100;
    const status = deposit > 0 ? 'pending_payment' : 'scheduled';
    t.appointments.push({
      id: uid('appt'), org_id: 'demo-org', patient_id: i.patientId, professional_id: i.professionalId, site_id: i.siteId,
      service_id: i.serviceId, starts_at: i.startsAt, ends_at: ends, modality: i.modality, status, channel: 'dashboard',
      hold_expires_at: status === 'pending_payment' ? new Date(Date.now() + 30 * 60_000).toISOString() : null,
    });
    demoChanged();
    return { ok: true, status, deposit_cents: deposit };
  },
  async setStatus(id, status) {
    const a = db().appointments.find((x) => x.id === id);
    if (a) a.status = status;
    demoChanged();
  },
  async recordPayment(i) {
    const t = db();
    t.payments.push({
      id: uid('pay'), org_id: 'demo-org', patient_id: i.patientId, appointment_id: i.appointmentId, provider: i.provider,
      kind: i.kind, status: 'approved', amount_cents: i.amountCents, currency: 'COP',
      paid_at: new Date().toISOString(), created_at: new Date().toISOString(),
    });
    const a = t.appointments.find((x) => x.id === i.appointmentId);
    if (a?.status === 'pending_payment') { a.status = 'scheduled'; a.hold_expires_at = null; }
    demoChanged();
  },
};

export const agendaApi: AgendaApi = isDemo ? demoAgenda : supabaseAgenda;
