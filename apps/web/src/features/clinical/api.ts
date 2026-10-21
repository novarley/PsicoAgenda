// Historia clínica. El contenido cifrado (anamnesis, notas) pasa SIEMPRE por la Edge
// Function clinical-record: el navegador nunca ve la clave ni el texto cifrado.
// Los diagnósticos son códigos estructurados y van directo con RLS.
import { isDemo, supabase } from '../../lib/supabase';
import { db, DEMO_USERS, demoAuth, demoChanged, uid } from '../../demo/store';

export interface NoteView {
  id: string;
  author_id: string;
  author_name: string;
  is_private: boolean;
  content: string | null;
  appointment_id: string | null;
  created_at: string;
  updated_at: string;
  mine: boolean;
  editable: boolean;
}

export interface ClinicalView {
  record: { id: string; anamnesis: string | null; anamnesis_unreadable: boolean; updated_at: string } | null;
  notes: NoteView[];
}

export interface Diagnosis {
  id: string;
  code_system: string;
  code: string;
  description: string;
  is_primary: boolean;
  diagnosed_at: string;
  resolved_at: string | null;
}

export interface ClinicalApi {
  get(patientId: string): Promise<ClinicalView>;
  saveAnamnesis(patientId: string, text: string): Promise<void>;
  addNote(patientId: string, text: string, isPrivate: boolean, appointmentId: string | null): Promise<void>;
  updateNote(noteId: string, text: string, isPrivate: boolean): Promise<void>;
  diagnoses(patientId: string): Promise<Diagnosis[]>;
  addDiagnosis(input: { orgId: string; patientId: string; professionalId: string; codeSystem: string; code: string; description: string; isPrimary: boolean }): Promise<void>;
  resolveDiagnosis(id: string): Promise<void>;
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('clinical-record', { body });
  if (!error) return data as T;
  const detail = await (error as { context?: Response }).context?.json().catch(() => null);
  throw new Error(detail?.error ?? 'No se pudo acceder a la historia clínica.');
}

const supabaseClinical: ClinicalApi = {
  get: (patientId) => call<ClinicalView>({ action: 'get', patientId }),
  async saveAnamnesis(patientId, text) { await call({ action: 'saveAnamnesis', patientId, text }); },
  async addNote(patientId, text, isPrivate, appointmentId) { await call({ action: 'addNote', patientId, text, isPrivate, appointmentId }); },
  async updateNote(noteId, text, isPrivate) { await call({ action: 'updateNote', noteId, text, isPrivate }); },
  async diagnoses(patientId) {
    const { data, error } = await supabase.from('diagnoses')
      .select('id, code_system, code, description, is_primary, diagnosed_at, resolved_at, clinical_records!inner(patient_id)')
      .eq('clinical_records.patient_id', patientId).order('diagnosed_at', { ascending: false });
    if (error) throw error;
    return data as unknown as Diagnosis[];
  },
  async addDiagnosis(i) {
    const { recordId } = await call<{ recordId: string }>({ action: 'ensureRecord', patientId: i.patientId });
    const { error } = await supabase.from('diagnoses').insert({
      org_id: i.orgId, record_id: recordId, professional_id: i.professionalId,
      code_system: i.codeSystem, code: i.code.trim().toUpperCase(), description: i.description.trim(), is_primary: i.isPrimary,
    });
    if (error) throw error;
  },
  async resolveDiagnosis(id) {
    const { error } = await supabase.from('diagnoses').update({ resolved_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
  },
};

// ----------------------------------------------------------------------- demo
// Sin cifrado real (no hay Edge Function): reproduce las mismas reglas de visibilidad.
interface DemoNote { id: string; patient_id: string; author_id: string; is_private: boolean; content: string; appointment_id: string | null; created_at: string }
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const demo = {
  anamnesis: {
    'pat-1': 'Motivo de consulta: ansiedad persistente y dificultad para dormir desde hace 4 meses, asociada a carga laboral.\n\nAntecedentes personales: sin hospitalizaciones. Episodio depresivo leve en 2021 tratado con psicoterapia.\nAntecedentes familiares: madre con trastorno de ansiedad.\nMedicación actual: ninguna.\nRed de apoyo: pareja y hermana.',
  } as Record<string, string>,
  diagnoses: [
    { id: 'dx-1', patient_id: 'pat-1', code_system: 'CIE-10', code: 'F41.1', description: 'Trastorno de ansiedad generalizada', is_primary: true, diagnosed_at: hoursAgo(24 * 40), resolved_at: null },
    { id: 'dx-2', patient_id: 'pat-1', code_system: 'CIE-10', code: 'F51.0', description: 'Insomnio no orgánico', is_primary: false, diagnosed_at: hoursAgo(24 * 40), resolved_at: null },
  ] as (Diagnosis & { patient_id: string })[],
  notes: [
    { id: 'n-1', patient_id: 'pat-1', author_id: 'pr-1', is_private: false, appointment_id: null, created_at: hoursAgo(24 * 21),
      content: 'S: Refiere preocupación constante por el trabajo y despertares a las 3 a. m.\nO: Discurso coherente, afecto ansioso, sin ideación suicida.\nA: Cuadro compatible con TAG. Escala GAD-7: 14.\nP: Psicoeducación sobre ansiedad, registro de pensamientos, higiene del sueño. Control en 1 semana.' },
    { id: 'n-2', patient_id: 'pat-1', author_id: 'pr-1', is_private: true, appointment_id: null, created_at: hoursAgo(24 * 14),
      content: 'Impresión personal: posible conflicto de pareja no verbalizado. Explorar con cuidado en próximas sesiones.' },
    { id: 'n-3', patient_id: 'pat-1', author_id: 'pr-2', is_private: false, appointment_id: null, created_at: hoursAgo(24 * 10),
      content: 'Interconsulta: sesión de pareja solicitada por la paciente. Se acuerda intervención conjunta con Psic. Méndez.' },
    { id: 'n-4', patient_id: 'pat-1', author_id: 'pr-2', is_private: true, appointment_id: null, created_at: hoursAgo(24 * 10),
      content: 'Nota privada de Camilo Torres: en la demo, Laura NO debe ver esto.' },
    { id: 'n-5', patient_id: 'pat-1', author_id: 'pr-1', is_private: false, appointment_id: null, created_at: hoursAgo(2),
      content: 'S: Mejor descanso (6 h). Practica respiración diafragmática a diario.\nO: Menor tensión motora.\nA: Buena adherencia. GAD-7: 9.\nP: Reestructuración cognitiva. Próxima sesión en 2 semanas.' },
  ] as DemoNote[],
};

const me = () => DEMO_USERS[demoAuth.role].professionalId;
const delay = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 120));

const demoClinical: ClinicalApi = {
  async get(patientId) {
    if (!me()) throw new Error('Solo los profesionales tratantes acceden a la historia clínica.');
    const names = Object.fromEntries(db().professionals.map((p) => [p.id, String(p.full_name)]));
    const notes = demo.notes
      .filter((n) => n.patient_id === patientId && (!n.is_private || n.author_id === me()))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((n) => ({
        ...n, author_name: names[n.author_id] ?? 'Profesional', updated_at: n.created_at, mine: n.author_id === me(),
        editable: n.author_id === me() && Date.now() - new Date(n.created_at).getTime() < 24 * 3_600_000,
      }));
    const anamnesis = demo.anamnesis[patientId] ?? null;
    return delay({
      record: anamnesis || demo.diagnoses.some((d) => d.patient_id === patientId)
        ? { id: `rec-${patientId}`, anamnesis, anamnesis_unreadable: false, updated_at: hoursAgo(24 * 40) } : null,
      notes,
    });
  },
  async saveAnamnesis(patientId, text) { demo.anamnesis[patientId] = text.trim(); demoChanged(); },
  async addNote(patientId, text, isPrivate, appointmentId) {
    demo.notes.push({ id: uid('note'), patient_id: patientId, author_id: me()!, is_private: isPrivate, content: text.trim(), appointment_id: appointmentId, created_at: new Date().toISOString() });
    demoChanged();
  },
  async updateNote(noteId, text, isPrivate) {
    const n = demo.notes.find((x) => x.id === noteId);
    if (n) { n.content = text.trim(); n.is_private = isPrivate; }
    demoChanged();
  },
  async diagnoses(patientId) { return delay(demo.diagnoses.filter((d) => d.patient_id === patientId)); },
  async addDiagnosis(i) {
    demo.diagnoses.unshift({ id: uid('dx'), patient_id: i.patientId, code_system: i.codeSystem, code: i.code.trim().toUpperCase(), description: i.description.trim(), is_primary: i.isPrimary, diagnosed_at: new Date().toISOString(), resolved_at: null });
    demoChanged();
  },
  async resolveDiagnosis(id) {
    const d = demo.diagnoses.find((x) => x.id === id);
    if (d) d.resolved_at = new Date().toISOString();
    demoChanged();
  },
};

export const clinicalApi: ClinicalApi = isDemo ? demoClinical : supabaseClinical;

/** Códigos CIE-10 frecuentes para el atajo del formulario (el profesional puede escribir cualquiera). */
export const COMMON_CODES: { code: string; description: string }[] = [
  { code: 'F32.0', description: 'Episodio depresivo leve' },
  { code: 'F32.1', description: 'Episodio depresivo moderado' },
  { code: 'F33', description: 'Trastorno depresivo recurrente' },
  { code: 'F41.0', description: 'Trastorno de pánico' },
  { code: 'F41.1', description: 'Trastorno de ansiedad generalizada' },
  { code: 'F41.2', description: 'Trastorno mixto de ansiedad y depresión' },
  { code: 'F42', description: 'Trastorno obsesivo-compulsivo' },
  { code: 'F43.1', description: 'Trastorno de estrés postraumático' },
  { code: 'F43.2', description: 'Trastornos de adaptación' },
  { code: 'F50.0', description: 'Anorexia nerviosa' },
  { code: 'F51.0', description: 'Insomnio no orgánico' },
  { code: 'F60.3', description: 'Trastorno de la personalidad emocionalmente inestable' },
  { code: 'F90.0', description: 'Perturbación de la actividad y de la atención' },
  { code: 'Z63.0', description: 'Problemas en la relación entre esposos o pareja' },
  { code: 'Z73.0', description: 'Problemas relacionados con el agotamiento (burnout)' },
  { code: 'I10', description: 'Hipertensión esencial (primaria)' },
  { code: 'E11', description: 'Diabetes mellitus tipo 2' },
  { code: 'J06.9', description: 'Infección aguda de las vías respiratorias superiores' },
];

export const SOAP_TEMPLATE = 'S (subjetivo): \nO (objetivo): \nA (análisis): \nP (plan): ';
export const ANAMNESIS_TEMPLATE = 'Motivo de consulta: \n\nEnfermedad actual: \n\nAntecedentes personales: \nAntecedentes familiares: \nMedicación actual: \nRed de apoyo: ';
