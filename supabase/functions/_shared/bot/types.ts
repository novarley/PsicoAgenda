// Contratos del motor conversacional (arquitectura hexagonal):
// el motor solo conoce estas interfaces; Supabase, Meta y Wompi son adaptadores.
import type { OutboundContent } from '../whatsapp/schema.ts';
import type { CrisisLine, CrisisMatch } from './crisis.ts';

/** Pasos del flujo transaccional (los números son los del documento de requisitos). */
export type BotState =
  | 'start'
  | 'consent'            // 1. consentimiento Habeas Data / RGPD
  | 'ask_doc_type'       // 2. tipo de documento
  | 'ask_doc_number'     // 2. número de documento → 3. validación
  | 'verify_birth_date'  // 3b. segundo factor si el teléfono no coincide
  | 'ask_full_name'      // 3c. alta de paciente nuevo
  | 'ask_insurer'        // 4. EPS / convenio / particular
  | 'ask_service'        // 4b. servicio (se salta si solo hay uno)
  | 'ask_site'           // 5. sede física u online
  | 'ask_professional'   // 6. profesional (continuidad terapéutica primero)
  | 'ask_day'            // 7. disponibilidad real
  | 'ask_time'           // 8. hora
  | 'confirm'            // 9. confirmación activa → 10. reserva + pago
  | 'done'
  | 'closed';

export interface BotContext {
  consentAt?: string;
  docType?: string;
  docNumber?: string;
  candidatePatientId?: string;
  candidateBirthDate?: string;
  birthDateAttempts?: number;
  insurerId?: string | null;
  serviceId?: string;
  serviceName?: string;
  siteId?: string;
  siteName?: string;
  modality?: 'in_person' | 'online';
  professionalId?: string;
  professionalName?: string;
  day?: string;          // YYYY-MM-DD en hora local de la organización
  startsAt?: string;     // ISO-8601 UTC
  rescheduleOf?: string; // cita original cuando el flujo viene de "Reagendar"
  invalidAttempts?: number;
}

export interface OrgConfig {
  id: string;
  name: string;
  countryCode: string;
  timezone: string;
  currency: string;
  consentVersion: string;
  crisisLines: CrisisLine[];
  privacyPolicyUrl?: string;
}

export interface PatientSummary {
  id: string;
  fullName: string;
  phoneE164: string | null;
  birthDate: string | null;   // YYYY-MM-DD
  lastProfessionalId: string | null;
}

export interface Option { id: string; name: string; description?: string }
export interface SiteOption extends Option { isVirtual: boolean }
export interface Slot { startsAt: string; endsAt: string; siteId: string }

export interface BookingSuccess {
  ok: true;
  appointmentId: string;
  status: 'scheduled' | 'pending_payment';
  startsAt: string;
  depositCents: number;
  currency: string;
  bonoSessionsRemaining: number | null;
  holdExpiresAt: string | null;
}
export type BookingOutcome = BookingSuccess | { ok: false; reason: 'SLOT_NOT_AVAILABLE' | 'ERROR' };

export type ReminderAction = 'confirm' | 'cancel' | 'reschedule';
export interface ReminderActionResult {
  ok: boolean;
  appointment?: {
    startsAt: string;
    patientId: string;
    professionalId: string;
    professionalName: string;
    siteId: string;
    siteName: string;
    serviceId: string;
    serviceName: string;
    modality: 'in_person' | 'online';
  };
}

/** Puertos que el motor necesita del mundo exterior. */
export interface BotPorts {
  findPatientByDocument(docType: string, docNumber: string): Promise<PatientSummary | null>;
  createPatient(input: { docType: string; docNumber: string; fullName: string; phoneE164: string }): Promise<PatientSummary>;
  saveConsent(patientId: string, at: string, version: string): Promise<void>;
  listInsurers(): Promise<Option[]>;
  listServices(): Promise<Option[]>;
  listSites(): Promise<SiteOption[]>;
  listProfessionals(serviceId: string): Promise<Option[]>;
  getLastProfessionalId(patientId: string): Promise<string | null>;
  availableSlots(professionalId: string, siteId: string, fromDate: string, days: number): Promise<Slot[]>;
  book(input: {
    patientId: string; professionalId: string; siteId: string; serviceId: string;
    insurerId: string | null; startsAt: string; modality: 'in_person' | 'online';
  }): Promise<BookingOutcome>;
  paymentLink(booking: BookingSuccess, patientId: string): Promise<string | null>;
  applyReminderAction(appointmentId: string, action: ReminderAction, waId: string): Promise<ReminderActionResult>;
}

export interface ConversationSnapshot {
  state: BotState;
  context: BotContext;
  patientId: string | null;
  humanHandoff: boolean;
}

export interface TurnResult {
  state: BotState;
  context: BotContext;
  patientId: string | null;
  messages: OutboundContent[];
  handoff?: { reason: 'crisis' | 'user_request' | 'identity_verification' | 'stuck' };
  crisis?: CrisisMatch;
}
