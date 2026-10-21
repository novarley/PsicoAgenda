// Adaptador: implementa BotPorts sobre Supabase (PostgREST + funciones RPC).
// Usa la service_role key → salta RLS, por eso CADA consulta filtra por org_id.
import type { SupabaseClient } from '../deps.ts';
import { env } from '../env.ts';
import { wompiCheckoutUrl } from '../payments/wompi.ts';
import { phonesMatch } from './engine.ts';
import type { CrisisLine } from './crisis.ts';
import type {
  BookingOutcome, BotPorts, OrgConfig, PatientSummary, ReminderActionResult,
} from './types.ts';

export interface LoadedOrg {
  config: OrgConfig;
  onCallPhone: string | null;
  settings: Record<string, unknown>;
}

const orgCache = new Map<string, { org: LoadedOrg | null; at: number }>();

/** Resuelve la clínica a partir del phone_number_id del webhook (multi-tenant). */
export async function loadOrgByPhoneNumberId(db: SupabaseClient, phoneNumberId: string): Promise<LoadedOrg | null> {
  const cached = orgCache.get(phoneNumberId);
  if (cached && Date.now() - cached.at < 60_000) return cached.org;

  const { data, error } = await db.from('organizations')
    .select('id, name, country_code, timezone, currency, consent_text_version, crisis_lines, on_call_phone_e164, settings')
    .eq('wa_phone_number_id', phoneNumberId)
    .maybeSingle();
  if (error) throw error;

  const org: LoadedOrg | null = data && {
    config: {
      id: data.id,
      name: data.name,
      countryCode: data.country_code,
      timezone: data.timezone,
      currency: data.currency,
      consentVersion: data.consent_text_version,
      crisisLines: (data.crisis_lines ?? []) as CrisisLine[],
      privacyPolicyUrl: (data.settings?.privacy_policy_url as string | undefined) ?? env.privacyPolicyUrl,
    },
    onCallPhone: data.on_call_phone_e164,
    settings: data.settings ?? {},
  };
  orgCache.set(phoneNumberId, { org, at: Date.now() });
  return org;
}

export function createSupabasePorts(db: SupabaseClient, org: OrgConfig): BotPorts {
  const orgId = org.id;

  const toPatient = (row: Record<string, unknown>): PatientSummary => ({
    id: row.id as string,
    fullName: row.full_name as string,
    phoneE164: (row.phone_e164 as string | null) ?? null,
    birthDate: (row.birth_date as string | null) ?? null,
    lastProfessionalId: (row.last_professional_id as string | null) ?? null,
  });
  const PATIENT_COLS = 'id, full_name, phone_e164, birth_date, last_professional_id';

  return {
    async findPatientByDocument(docType, docNumber) {
      const { data, error } = await db.from('patients').select(PATIENT_COLS)
        .eq('org_id', orgId).eq('doc_type', docType).eq('doc_number', docNumber).maybeSingle();
      if (error) throw error;
      return data ? toPatient(data) : null;
    },

    async createPatient({ docType, docNumber, fullName, phoneE164 }) {
      const { data, error } = await db.from('patients')
        .insert({ org_id: orgId, doc_type: docType, doc_number: docNumber, full_name: fullName, phone_e164: phoneE164 })
        .select(PATIENT_COLS).single();
      if (error?.code === '23505') {          // carrera: otro mensaje lo creó un instante antes
        const existing = await this.findPatientByDocument(docType, docNumber);
        if (existing) return existing;
      }
      if (error) throw error;
      return toPatient(data);
    },

    async saveConsent(patientId, at, version) {
      const { error } = await db.from('patients')
        .update({ data_consent_at: at, data_consent_version: version, whatsapp_opt_in: true })
        .eq('org_id', orgId).eq('id', patientId);
      if (error) throw error;
    },

    async listInsurers() {
      const { data, error } = await db.from('insurers').select('id, name')
        .eq('org_id', orgId).eq('active', true).neq('kind', 'particular').order('name');
      if (error) throw error;
      return data;
    },

    async listServices() {
      const { data, error } = await db.from('services').select('id, name, duration_minutes')
        .eq('org_id', orgId).eq('active', true).order('name');
      if (error) throw error;
      return data.map((s) => ({ id: s.id, name: s.name, description: `${s.duration_minutes} min` }));
    },

    async listSites() {
      const { data, error } = await db.from('sites').select('id, name, address, is_virtual')
        .eq('org_id', orgId).eq('active', true).order('is_virtual').order('name');
      if (error) throw error;
      return data.map((s) => ({ id: s.id, name: s.name, description: s.address ?? undefined, isVirtual: s.is_virtual }));
    },

    async listProfessionals(serviceId) {
      const { data: service, error: e1 } = await db.from('services').select('specialty')
        .eq('org_id', orgId).eq('id', serviceId).single();
      if (e1) throw e1;
      const { data, error } = await db.from('professionals').select('id, full_name')
        .eq('org_id', orgId).eq('active', true).eq('specialty', service.specialty).order('full_name');
      if (error) throw error;
      return data.map((p) => ({ id: p.id, name: p.full_name }));
    },

    async getLastProfessionalId(patientId) {
      const { data, error } = await db.from('patients').select('last_professional_id')
        .eq('org_id', orgId).eq('id', patientId).maybeSingle();
      if (error) throw error;
      return data?.last_professional_id ?? null;
    },

    async availableSlots(professionalId, siteId, fromDate, days) {
      const { data, error } = await db.rpc('available_slots', {
        p_org: orgId, p_professional: professionalId, p_site: siteId, p_from: fromDate, p_days: days,
      });
      if (error) throw error;
      return (data as { starts_at: string; ends_at: string; site_id: string }[]).map((r) => ({
        startsAt: new Date(r.starts_at).toISOString(),   // normaliza a ISO-8601 UTC con "Z"
        endsAt: new Date(r.ends_at).toISOString(),
        siteId: r.site_id,
      }));
    },

    async book(input): Promise<BookingOutcome> {
      const { data, error } = await db.rpc('book_appointment', {
        p_org: orgId, p_patient: input.patientId, p_professional: input.professionalId,
        p_site: input.siteId, p_service: input.serviceId, p_starts_at: input.startsAt,
        p_modality: input.modality, p_insurer: input.insurerId, p_channel: 'whatsapp',
      });
      if (error) {
        if (error.code === 'PA001') return { ok: false, reason: 'SLOT_NOT_AVAILABLE' };
        console.error('book_appointment falló', error);
        return { ok: false, reason: 'ERROR' };
      }
      const r = data as Record<string, unknown>;
      return {
        ok: true,
        appointmentId: r.appointment_id as string,
        status: r.status as 'scheduled' | 'pending_payment',
        startsAt: new Date(r.starts_at as string).toISOString(),
        depositCents: Number(r.deposit_cents ?? 0),
        currency: r.currency as string,
        bonoSessionsRemaining: r.bono_sessions_remaining == null ? null : Number(r.bono_sessions_remaining),
        holdExpiresAt: (r.hold_expires_at as string | null) ?? null,
      };
    },

    async paymentLink(booking, patientId) {
      const publicKey = env.wompiPublicKey;
      const integritySecret = env.wompiIntegritySecret;
      if (!publicKey || !integritySecret || booking.depositCents <= 0) return null;

      const reference = `PA-${booking.appointmentId}`;
      const url = await wompiCheckoutUrl({
        publicKey, integritySecret, reference,
        amountInCents: booking.depositCents, currency: booking.currency,
        redirectUrl: env.paymentRedirectUrl,
        expirationTime: booking.holdExpiresAt ? new Date(booking.holdExpiresAt).toISOString() : undefined,
      });
      const { error } = await db.from('payments').upsert({
        org_id: orgId, patient_id: patientId, appointment_id: booking.appointmentId,
        provider: 'wompi', kind: 'deposit', reference,
        amount_cents: booking.depositCents, currency: booking.currency, checkout_url: url,
      }, { onConflict: 'reference' });
      if (error) throw error;
      return url;
    },

    async applyReminderAction(appointmentId, action, waId): Promise<ReminderActionResult> {
      const { data: a, error } = await db.from('appointments')
        .select(`id, status, starts_at, patient_id, professional_id, site_id, service_id, modality,
                 patients(phone_e164), professionals(full_name), sites(name), services(name)`)
        .eq('org_id', orgId).eq('id', appointmentId).maybeSingle();
      if (error) throw error;
      // Solo el titular (mismo WhatsApp) puede modificar su cita, y solo si sigue vigente
      const phone = one<{ phone_e164: string | null }>(a?.patients)?.phone_e164 ?? null;
      if (!a || !phonesMatch(phone, waId)) return { ok: false };
      if (!['scheduled', 'confirmed'].includes(a.status) || new Date(a.starts_at) <= new Date()) return { ok: false };

      const now = new Date().toISOString();
      const patch = action === 'confirm'
        ? { status: 'confirmed', confirmed_at: now }
        : { status: 'cancelled', cancelled_at: now,
            cancellation_reason: action === 'reschedule' ? 'reschedule_requested' : 'patient_whatsapp' };
      const { error: e2 } = await db.from('appointments').update(patch).eq('org_id', orgId).eq('id', appointmentId);
      if (e2) throw e2;

      return {
        ok: true,
        appointment: {
          startsAt: new Date(a.starts_at).toISOString(),
          patientId: a.patient_id,
          professionalId: a.professional_id,
          professionalName: one<{ full_name: string }>(a.professionals)?.full_name ?? '',
          siteId: a.site_id,
          siteName: one<{ name: string }>(a.sites)?.name ?? '',
          serviceId: a.service_id,
          serviceName: one<{ name: string }>(a.services)?.name ?? '',
          modality: a.modality,
        },
      };
    },
  };
}

/** PostgREST devuelve una relación many-to-one como objeto; sin tipos generados supabase-js la tipa como array. */
function one<T>(rel: unknown): T | null {
  return ((Array.isArray(rel) ? rel[0] : rel) as T | undefined) ?? null;
}
