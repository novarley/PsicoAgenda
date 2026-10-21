// Datos de pacientes. RLS decide qué ve cada rol: recepción y admin todos; un profesional
// solo los que tienen cita con él. La historia clínica NO pasa por aquí.
import { isDemo, supabase } from '../../lib/supabase';
import { db, demoChanged, uid, visibleAppointments, visiblePatients } from '../../demo/store';
import { toAppointment, type AgendaAppointment } from '../agenda/api';

export interface Patient {
  id: string;
  doc_type: string;
  doc_number: string;
  full_name: string;
  birth_date: string | null;
  sex: string | null;
  phone_e164: string | null;
  email: string | null;
  address: string | null;
  insurer_id: string | null;
  emergency_contact: { name: string; phone: string } | null;
  data_consent_at: string | null;
  whatsapp_opt_in: boolean;
  created_at: string;
}
export type PatientInput = Omit<Patient, 'id' | 'created_at' | 'data_consent_at'> & { consent_given: boolean };

export interface Bono { id: string; plan_name: string; sessions_total: number; sessions_used: number; status: string; expires_at: string | null }
export interface PatientDocument { id: string; kind: string; storage_path: string; created_at: string }
export interface Insurer { id: string; name: string; kind: string }

export interface PatientsApi {
  list(orgId: string, q: string): Promise<Patient[]>;
  get(id: string): Promise<Patient | null>;
  create(orgId: string, input: PatientInput): Promise<Patient>;
  update(id: string, input: PatientInput, hadConsent: boolean): Promise<void>;
  appointments(patientId: string): Promise<AgendaAppointment[]>;
  bonos(patientId: string): Promise<Bono[]>;
  documents(patientId: string): Promise<PatientDocument[]>;
  upload(orgId: string, patientId: string, file: File, kind: string): Promise<void>;
  documentUrl(path: string): Promise<string | null>;
  insurers(orgId: string): Promise<Insurer[]>;
}

const COLS = 'id, doc_type, doc_number, full_name, birth_date, sex, phone_e164, email, address, insurer_id, emergency_contact, data_consent_at, whatsapp_opt_in, created_at';

/** El consentimiento solo se registra cuando se marca, y nunca se "des-registra" desde aquí. */
function toRow(input: PatientInput, hadConsent: boolean) {
  const { consent_given, ...row } = input;
  return {
    ...row,
    doc_number: row.doc_number.replace(/[\s.]/g, '').toUpperCase(),
    whatsapp_opt_in: consent_given && row.whatsapp_opt_in,
    ...(consent_given && !hadConsent ? { data_consent_at: new Date().toISOString(), data_consent_version: 'v1' } : {}),
  };
}

async function sha256(file: File): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const supabasePatients: PatientsApi = {
  async list(orgId, q) {
    const term = q.trim().replace(/[%,()]/g, ' ');
    let query = supabase.from('patients').select(COLS).eq('org_id', orgId).order('full_name').limit(100);
    if (term) query = query.or(`full_name.ilike.%${term}%,doc_number.ilike.%${term}%,phone_e164.ilike.%${term}%`);
    const { data, error } = await query;
    if (error) throw error;
    return data as Patient[];
  },
  async get(id) {
    const { data, error } = await supabase.from('patients').select(COLS).eq('id', id).maybeSingle();
    if (error) throw error;
    return data as Patient | null;
  },
  async create(orgId, input) {
    const { data, error } = await supabase.from('patients').insert({ org_id: orgId, ...toRow(input, false) }).select(COLS).single();
    if (error) throw error.code === '23505' ? new Error('Ya existe un paciente con ese documento.') : error;
    return data as Patient;
  },
  async update(id, input, hadConsent) {
    const { error } = await supabase.from('patients').update(toRow(input, hadConsent)).eq('id', id);
    if (error) throw error;
  },
  async appointments(patientId) {
    const { data, error } = await supabase.from('appointments')
      .select('id, starts_at, ends_at, status, modality, channel, professional_id, patient_id, hold_expires_at, patients(full_name), services(name, price_cents, deposit_percent), sites(name)')
      .eq('patient_id', patientId).order('starts_at', { ascending: false }).limit(100);
    if (error) throw error;
    return data.map(toAppointment);
  },
  async bonos(patientId) {
    const { data, error } = await supabase.from('bonos')
      .select('id, sessions_total, sessions_used, status, expires_at, bono_plans(name)').eq('patient_id', patientId).order('purchased_at', { ascending: false });
    if (error) throw error;
    return data.map((b) => ({
      ...b, plan_name: (Array.isArray(b.bono_plans) ? b.bono_plans[0] : b.bono_plans as { name: string } | null)?.name ?? 'Bono',
    })) as Bono[];
  },
  async documents(patientId) {
    const { data, error } = await supabase.from('patient_documents').select('id, kind, storage_path, created_at')
      .eq('patient_id', patientId).order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  },
  async upload(orgId, patientId, file, kind) {
    if (file.size > 10 * 1024 * 1024) throw new Error('El archivo supera 10 MB.');
    const safe = file.name.normalize('NFD').replace(/[^\w.\-]+/g, '_').slice(-80);
    const path = `${orgId}/${patientId}/${Date.now()}-${safe}`;      // convención exigida por las políticas de Storage
    const { error } = await supabase.storage.from('clinical-documents').upload(path, file, { contentType: file.type });
    if (error) throw error;
    const { data: { user } } = await supabase.auth.getUser();
    const { error: e2 } = await supabase.from('patient_documents').insert({
      org_id: orgId, patient_id: patientId, storage_path: path, kind, uploaded_by: user?.id, sha256: await sha256(file),
    });
    if (e2) throw e2;
  },
  async documentUrl(path) {
    const { data, error } = await supabase.storage.from('clinical-documents').createSignedUrl(path, 60);
    if (error) throw error;
    return data.signedUrl;
  },
  async insurers(orgId) {
    const { data, error } = await supabase.from('insurers').select('id, name, kind').eq('org_id', orgId).eq('active', true).order('name');
    if (error) throw error;
    return data;
  },
};

// ----------------------------------------------------------------------- demo
const demoPatients: PatientsApi = {
  async list(_orgId, q) {
    const term = q.trim().toLowerCase();
    return (visiblePatients() as unknown as Patient[])
      .filter((p) => !term || `${p.full_name} ${p.doc_number} ${p.phone_e164}`.toLowerCase().includes(term))
      .sort((a, b) => a.full_name.localeCompare(b.full_name));
  },
  async get(id) { return (visiblePatients().find((p) => p.id === id) as unknown as Patient) ?? null; },
  async create(_orgId, input) {
    const row = toRow(input, false);
    if (db().patients.some((p) => p.doc_type === row.doc_type && p.doc_number === row.doc_number)) {
      throw new Error('Ya existe un paciente con ese documento.');
    }
    const p = { id: uid('pat'), org_id: 'demo-org', created_at: new Date().toISOString(), data_consent_at: null, ...row };
    db().patients.push(p);
    demoChanged();
    return p as unknown as Patient;
  },
  async update(id, input, hadConsent) {
    const p = db().patients.find((x) => x.id === id);
    if (p) Object.assign(p, toRow(input, hadConsent));
    demoChanged();
  },
  async appointments(patientId) {
    const t = db();
    return visibleAppointments().filter((a) => a.patient_id === patientId)
      .sort((a, b) => String(b.starts_at).localeCompare(String(a.starts_at)))
      .map((a) => toAppointment({
        ...a, patients: t.patients.find((p) => p.id === a.patient_id),
        services: t.services.find((v) => v.id === a.service_id), sites: t.sites.find((x) => x.id === a.site_id),
      }));
  },
  async bonos(patientId) { return db().bonos.filter((b) => b.patient_id === patientId) as unknown as Bono[]; },
  async documents(patientId) { return db().patient_documents.filter((d) => d.patient_id === patientId) as unknown as PatientDocument[]; },
  async upload(_orgId, patientId, file, kind) {
    db().patient_documents.unshift({ id: uid('doc'), org_id: 'demo-org', patient_id: patientId, kind, storage_path: `demo-org/${patientId}/${file.name}`, created_at: new Date().toISOString() });
    demoChanged();
  },
  async documentUrl() { return null; },
  async insurers() { return db().insurers.filter((i) => i.active) as unknown as Insurer[]; },
};

export const patientsApi: PatientsApi = isDemo ? demoPatients : supabasePatients;

export const DOC_TYPES = [
  { value: 'CC', label: 'Cédula de ciudadanía' }, { value: 'TI', label: 'Tarjeta de identidad' },
  { value: 'CE', label: 'Cédula de extranjería' }, { value: 'PA', label: 'Pasaporte' },
  { value: 'PPT', label: 'Permiso PPT' }, { value: 'RC', label: 'Registro civil' },
  { value: 'DNI', label: 'DNI (España)' }, { value: 'NIE', label: 'NIE (España)' },
];

export const DOCUMENT_KINDS: Record<string, string> = {
  lab_result: 'Resultado de laboratorio', referral: 'Remisión', id_document: 'Documento de identidad',
  consent: 'Consentimiento', other: 'Otro',
};
