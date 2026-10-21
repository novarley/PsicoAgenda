// Historia clínica: cifrado y descifrado de anamnesis y notas de evolución.
//
// Reglas:
//  • Toda lectura/escritura en BD se hace con la SESIÓN DEL PROFESIONAL (las deps las
//    implementa clinical-record/index.ts con un cliente de usuario): RLS decide quién ve
//    qué. Esta capa no amplía permisos; solo cifra y descifra.
//  • AES-256-GCM con el id de la fila como dato asociado (AAD): un texto cifrado copiado
//    a otra fila no se descifra.
//  • Las lecturas quedan auditadas (los triggers de BD solo ven escrituras).

export const MAX_TEXT = 20_000;
export const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const KEY_VERSION = 1;

export interface RecordRow {
  id: string;
  org_id: string;
  patient_id: string;
  opened_by: string;
  anamnesis_ciphertext: string | null;
  key_version: number;
  updated_at: string;
}

export interface NoteRow {
  id: string;
  org_id: string;
  patient_id: string;
  author_id: string;
  is_private: boolean;
  content_ciphertext: string;
  key_version: number;
  appointment_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClinicalDeps {
  /** null si RLS no deja ver al paciente (no es tratante). */
  getPatientOrg(patientId: string): Promise<string | null>;
  getMyProfessionalId(orgId: string): Promise<string | null>;
  getRecord(patientId: string): Promise<RecordRow | null>;
  insertRecord(row: Omit<RecordRow, 'updated_at'>): Promise<void>;
  updateRecord(id: string, patch: { anamnesis_ciphertext: string | null; key_version: number }): Promise<void>;
  listNotes(patientId: string): Promise<NoteRow[]>;
  getNote(id: string): Promise<NoteRow | null>;
  insertNote(row: Omit<NoteRow, 'created_at' | 'updated_at'>): Promise<void>;
  updateNote(id: string, patch: { content_ciphertext: string; is_private: boolean; key_version: number }): Promise<void>;
  professionalNames(orgId: string, ids: string[]): Promise<Record<string, string>>;
  audit(entry: { org_id: string; table_name: string; record_id: string; action: 'read' }): Promise<void>;
  encrypt(plaintext: string, aad: string): Promise<string>;
  decrypt(ciphertext: string, aad: string): Promise<string>;
  now(): Date;
  newId(): string;
}

export interface NoteView {
  id: string;
  author_id: string;
  author_name: string;
  is_private: boolean;
  content: string | null;      // null = no se pudo descifrar (clave rotada o dato alterado)
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

type Result = { status: number; body: unknown };
const ok = (body: unknown): Result => ({ status: 200, body });
const fail = (status: number, error: string): Result => ({ status, body: { error } });
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v);

export async function handleClinical(deps: ClinicalDeps, body: Record<string, unknown>): Promise<Result> {
  const action = body.action;
  if (action === 'updateNote') return updateNote(deps, body);

  const patientId = body.patientId;
  if (!isUuid(patientId)) return fail(400, 'Paciente inválido.');

  const orgId = await deps.getPatientOrg(patientId);
  if (!orgId) return fail(404, 'No tienes acceso a la historia de este paciente.');
  const me = await deps.getMyProfessionalId(orgId);
  if (!me) return fail(403, 'Solo los profesionales tratantes acceden a la historia clínica.');

  switch (action) {
    case 'get': return ok(await view(deps, orgId, patientId, me));
    case 'ensureRecord': return ok({ recordId: (await ensureRecord(deps, orgId, patientId, me)).id });
    case 'saveAnamnesis': {
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (text.length > MAX_TEXT) return fail(400, `La anamnesis supera ${MAX_TEXT} caracteres.`);
      const record = await ensureRecord(deps, orgId, patientId, me);
      await deps.updateRecord(record.id, {
        anamnesis_ciphertext: text ? await deps.encrypt(text, record.id) : null, key_version: KEY_VERSION,
      });
      return ok({ recordId: record.id });
    }
    case 'addNote': {
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > MAX_TEXT) return fail(400, `Escribe la nota (máximo ${MAX_TEXT} caracteres).`);
      const appointmentId = isUuid(body.appointmentId) ? body.appointmentId : null;
      const id = deps.newId();
      await deps.insertNote({
        id, org_id: orgId, patient_id: patientId, author_id: me,
        is_private: body.isPrivate !== false,          // privada por defecto
        content_ciphertext: await deps.encrypt(text, id), key_version: KEY_VERSION, appointment_id: appointmentId,
      });
      return ok({ noteId: id });
    }
    default: return fail(400, 'Acción desconocida.');
  }
}

async function ensureRecord(deps: ClinicalDeps, orgId: string, patientId: string, me: string): Promise<RecordRow> {
  const existing = await deps.getRecord(patientId);
  if (existing) return existing;
  const row = { id: deps.newId(), org_id: orgId, patient_id: patientId, opened_by: me, anamnesis_ciphertext: null, key_version: KEY_VERSION };
  await deps.insertRecord(row);
  return { ...row, updated_at: deps.now().toISOString() };
}

async function safeDecrypt(deps: ClinicalDeps, ciphertext: string, aad: string, keyVersion: number): Promise<string | null> {
  if (keyVersion !== KEY_VERSION) return null;
  try { return await deps.decrypt(ciphertext, aad); } catch { return null; }
}

async function view(deps: ClinicalDeps, orgId: string, patientId: string, me: string): Promise<ClinicalView> {
  const [record, notes] = await Promise.all([deps.getRecord(patientId), deps.listNotes(patientId)]);
  const names = await deps.professionalNames(orgId, [...new Set(notes.map((n) => n.author_id))]);
  const now = deps.now().getTime();

  const anamnesis = record?.anamnesis_ciphertext
    ? await safeDecrypt(deps, record.anamnesis_ciphertext, record.id, record.key_version)
    : null;

  const noteViews = await Promise.all(
    [...notes].sort((a, b) => b.created_at.localeCompare(a.created_at)).map(async (n): Promise<NoteView> => ({
      id: n.id,
      author_id: n.author_id,
      author_name: names[n.author_id] ?? 'Profesional',
      is_private: n.is_private,
      content: await safeDecrypt(deps, n.content_ciphertext, n.id, n.key_version),
      appointment_id: n.appointment_id,
      created_at: n.created_at,
      updated_at: n.updated_at,
      mine: n.author_id === me,
      editable: n.author_id === me && now - new Date(n.created_at).getTime() < EDIT_WINDOW_MS,
    })),
  );

  await deps.audit({ org_id: orgId, table_name: 'clinical_records', record_id: record?.id ?? patientId, action: 'read' });

  return {
    record: record && {
      id: record.id, anamnesis, anamnesis_unreadable: Boolean(record.anamnesis_ciphertext) && anamnesis === null,
      updated_at: record.updated_at,
    },
    notes: noteViews,
  };
}

async function updateNote(deps: ClinicalDeps, body: Record<string, unknown>): Promise<Result> {
  if (!isUuid(body.noteId)) return fail(400, 'Nota inválida.');
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > MAX_TEXT) return fail(400, `Escribe la nota (máximo ${MAX_TEXT} caracteres).`);

  const note = await deps.getNote(body.noteId);
  if (!note) return fail(404, 'Nota no encontrada.');
  const me = await deps.getMyProfessionalId(note.org_id);
  if (!me || note.author_id !== me) return fail(403, 'Solo el autor puede corregir su nota.');
  if (deps.now().getTime() - new Date(note.created_at).getTime() >= EDIT_WINDOW_MS) {
    return fail(409, 'Pasaron más de 24 horas: agrega una nota nueva con la corrección.');
  }
  await deps.updateNote(note.id, {
    content_ciphertext: await deps.encrypt(text, note.id),
    is_private: typeof body.isPrivate === 'boolean' ? body.isPrivate : note.is_private,
    key_version: KEY_VERSION,
  });
  return ok({ noteId: note.id });
}
