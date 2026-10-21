// Historia clínica con cifrado REAL (AES-256-GCM) y una BD en memoria que imita RLS.
import { assert, assertEquals } from 'jsr:@std/assert@1.0.13';
import { decryptText, encryptText, importAesKey } from '../_shared/crypto.ts';
import { type ClinicalDeps, handleClinical, type NoteRow, type RecordRow } from '../_shared/clinical.ts';

const ORG = '11111111-1111-1111-1111-111111111111';
const PATIENT = '55555555-5555-5555-5555-555555555501';
const LAURA = 'prof-laura';
const CAMILO = 'prof-camilo';

async function setup(me: string | null, opts: { patientVisible?: boolean; now?: string } = {}) {
  const key = await importAesKey(btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))));
  const db = { records: [] as RecordRow[], notes: [] as NoteRow[], audit: [] as unknown[] };
  let clock = new Date(opts.now ?? '2026-10-21T15:00:00.000Z');
  let seq = 0;
  const deps: ClinicalDeps = {
    getPatientOrg: async () => (opts.patientVisible === false ? null : ORG),
    getMyProfessionalId: async () => me,
    getRecord: async (p) => db.records.find((r) => r.patient_id === p) ?? null,
    insertRecord: async (r) => void db.records.push({ ...r, updated_at: clock.toISOString() }),
    updateRecord: async (id, patch) => void Object.assign(db.records.find((r) => r.id === id)!, patch),
    // "RLS": las privadas solo las ve su autor
    listNotes: async (p) => db.notes.filter((n) => n.patient_id === p && (!n.is_private || n.author_id === me)),
    getNote: async (id) => db.notes.find((n) => n.id === id && (!n.is_private || n.author_id === me)) ?? null,
    insertNote: async (n) => void db.notes.push({ ...n, created_at: clock.toISOString(), updated_at: clock.toISOString() }),
    updateNote: async (id, patch) => void Object.assign(db.notes.find((n) => n.id === id)!, patch),
    professionalNames: async () => ({ [LAURA]: 'Psic. Laura Méndez', [CAMILO]: 'Psic. Camilo Torres' }),
    audit: async (e) => void db.audit.push(e),
    encrypt: (t, aad) => encryptText(key, t, aad),
    decrypt: (c, aad) => decryptText(key, c, aad),
    now: () => clock,
    newId: () => `00000000-0000-0000-0000-${String(++seq).padStart(12, '0')}`,
  };
  return { deps, db, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); }, key };
}

Deno.test('historia: la nota se guarda cifrada y se lee descifrada', async () => {
  const { deps, db } = await setup(LAURA);
  const r = await handleClinical(deps, { action: 'addNote', patientId: PATIENT, text: 'Paciente refiere insomnio de 3 semanas.' });
  assertEquals(r.status, 200);
  assert(!db.notes[0].content_ciphertext.includes('insomnio'), 'en BD solo debe haber texto cifrado');
  assertEquals(db.notes[0].is_private, true, 'privada por defecto');

  const v = await handleClinical(deps, { action: 'get', patientId: PATIENT });
  const body = v.body as { notes: { content: string; mine: boolean; editable: boolean }[] };
  assertEquals(body.notes[0].content, 'Paciente refiere insomnio de 3 semanas.');
  assert(body.notes[0].mine && body.notes[0].editable);
  assertEquals(db.audit.length, 1, 'la lectura queda auditada');
});

Deno.test('historia: anamnesis cifrada ligada al registro', async () => {
  const { deps, db } = await setup(LAURA);
  await handleClinical(deps, { action: 'saveAnamnesis', patientId: PATIENT, text: 'Motivo de consulta: ansiedad.' });
  assertEquals(db.records.length, 1);
  assert(!db.records[0].anamnesis_ciphertext!.includes('ansiedad'));
  const v = await handleClinical(deps, { action: 'get', patientId: PATIENT });
  assertEquals((v.body as { record: { anamnesis: string } }).record.anamnesis, 'Motivo de consulta: ansiedad.');
});

Deno.test('historia: un cifrado copiado a otra fila no se descifra (AAD)', async () => {
  const { deps, db } = await setup(LAURA);
  await handleClinical(deps, { action: 'addNote', patientId: PATIENT, text: 'Nota A', isPrivate: false });
  await handleClinical(deps, { action: 'addNote', patientId: PATIENT, text: 'Nota B', isPrivate: false });
  db.notes[1].content_ciphertext = db.notes[0].content_ciphertext;     // ataque: copiar el cifrado de A en B
  const v = await handleClinical(deps, { action: 'get', patientId: PATIENT });
  const notes = (v.body as { notes: { id: string; content: string | null }[] }).notes;
  assertEquals(notes.find((n) => n.id === db.notes[1].id)!.content, null);
  assertEquals(notes.find((n) => n.id === db.notes[0].id)!.content, 'Nota A');
});

Deno.test('historia: la nota privada de otro profesional no se ve; la compartida sí', async () => {
  const camilo = await setup(CAMILO);
  await handleClinical(camilo.deps, { action: 'addNote', patientId: PATIENT, text: 'Privada de Camilo' });
  await handleClinical(camilo.deps, { action: 'addNote', patientId: PATIENT, text: 'Compartida de Camilo', isPrivate: false });

  const laura = await setup(LAURA);
  laura.db.notes.push(...camilo.db.notes);
  laura.deps.decrypt = camilo.deps.decrypt;            // misma clave de la clínica
  const v = await handleClinical(laura.deps, { action: 'get', patientId: PATIENT });
  const notes = (v.body as { notes: { content: string; mine: boolean; editable: boolean; author_name: string }[] }).notes;
  assertEquals(notes.map((n) => n.content), ['Compartida de Camilo']);
  assert(!notes[0].mine && !notes[0].editable);
  assertEquals(notes[0].author_name, 'Psic. Camilo Torres');
});

Deno.test('historia: corregir solo dentro de 24 h y solo el autor', async () => {
  const { deps, db, advance } = await setup(LAURA);
  await handleClinical(deps, { action: 'addNote', patientId: PATIENT, text: 'Primera versión' });
  const id = db.notes[0].id;
  assertEquals((await handleClinical(deps, { action: 'updateNote', noteId: id, text: 'Versión corregida' })).status, 200);
  advance(25 * 60 * 60 * 1000);
  const late = await handleClinical(deps, { action: 'updateNote', noteId: id, text: 'Tarde' });
  assertEquals(late.status, 409);
  const v = await handleClinical(deps, { action: 'get', patientId: PATIENT });
  assertEquals((v.body as { notes: { content: string; editable: boolean }[] }).notes[0].content, 'Versión corregida');
  assert(!(v.body as { notes: { editable: boolean }[] }).notes[0].editable);
});

Deno.test('historia: sin acceso o sin ser profesional', async () => {
  const noPatient = await setup(LAURA, { patientVisible: false });
  assertEquals((await handleClinical(noPatient.deps, { action: 'get', patientId: PATIENT })).status, 404);
  const receptionist = await setup(null);
  assertEquals((await handleClinical(receptionist.deps, { action: 'get', patientId: PATIENT })).status, 403);
  assertEquals((await handleClinical(receptionist.deps, { action: 'get', patientId: 'x' })).status, 400);
});

Deno.test('historia: validaciones de texto', async () => {
  const { deps } = await setup(LAURA);
  assertEquals((await handleClinical(deps, { action: 'addNote', patientId: PATIENT, text: '   ' })).status, 400);
  assertEquals((await handleClinical(deps, { action: 'addNote', patientId: PATIENT, text: 'x'.repeat(20_001) })).status, 400);
  assertEquals((await handleClinical(deps, { action: 'borrarTodo', patientId: PATIENT })).status, 400);
});
