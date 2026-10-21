// =============================================================================
// Edge Function: historia clínica cifrada
// POST { action: 'get' | 'saveAnamnesis' | 'ensureRecord' | 'addNote' | 'updateNote', ... }
//
// La clave CLINICAL_DATA_KEY solo existe aquí. Todas las consultas usan la sesión del
// profesional (RLS decide el acceso); la service_role solo se usa para escribir la
// auditoría de lecturas, que el usuario no puede insertar por sí mismo.
// =============================================================================
import { createClient, type SupabaseClient } from '../_shared/deps.ts';
import { env, requireEnv } from '../_shared/env.ts';
import { corsHeaders, json } from '../_shared/cors.ts';
import { decryptText, encryptText, importAesKey } from '../_shared/crypto.ts';
import { handleClinical, type NoteRow, type RecordRow } from '../_shared/clinical.ts';

const admin: SupabaseClient = createClient(env.supabaseUrl, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const keyPromise = importAesKey(env.clinicalDataKey);

const RECORD_COLS = 'id, org_id, patient_id, opened_by, anamnesis_ciphertext, key_version, updated_at';
const NOTE_COLS = 'id, org_id, patient_id, author_id, is_private, content_ciphertext, key_version, appointment_id, created_at, updated_at';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

  const asUser = createClient(env.supabaseUrl, requireEnv('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: 'No autenticado' }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'JSON inválido' }, 400); }

  const key = await keyPromise;
  const must = <T>(r: { data: T; error: unknown }): T => { if (r.error) throw r.error; return r.data; };

  try {
    const result = await handleClinical({
      async getPatientOrg(patientId) {
        const data = must(await asUser.from('patients').select('org_id').eq('id', patientId).maybeSingle());
        return data?.org_id ?? null;
      },
      async getMyProfessionalId(orgId) {
        const data = must(await asUser.from('professionals').select('id')
          .eq('org_id', orgId).eq('user_id', user.id).eq('active', true).maybeSingle());
        return data?.id ?? null;
      },
      async getRecord(patientId) {
        return must(await asUser.from('clinical_records').select(RECORD_COLS).eq('patient_id', patientId).maybeSingle()) as RecordRow | null;
      },
      async insertRecord(row) { must(await asUser.from('clinical_records').insert(row)); },
      async updateRecord(id, patch) { must(await asUser.from('clinical_records').update(patch).eq('id', id)); },
      async listNotes(patientId) {
        return must(await asUser.from('clinical_notes').select(NOTE_COLS).eq('patient_id', patientId)) as NoteRow[];
      },
      async getNote(id) {
        return must(await asUser.from('clinical_notes').select(NOTE_COLS).eq('id', id).maybeSingle()) as NoteRow | null;
      },
      async insertNote(row) { must(await asUser.from('clinical_notes').insert(row)); },
      async updateNote(id, patch) { must(await asUser.from('clinical_notes').update(patch).eq('id', id)); },
      async professionalNames(orgId, ids) {
        if (ids.length === 0) return {};
        const data = must(await asUser.from('professionals').select('id, full_name').eq('org_id', orgId).in('id', ids));
        return Object.fromEntries((data ?? []).map((p) => [p.id, p.full_name]));
      },
      async audit(entry) {
        const { error } = await admin.from('audit_log').insert({ ...entry, actor_id: user.id });
        if (error) console.error('No se pudo auditar la lectura', error);
      },
      encrypt: (text, aad) => encryptText(key, text, aad),
      decrypt: (ct, aad) => decryptText(key, ct, aad),
      now: () => new Date(),
      newId: () => crypto.randomUUID(),
    }, body);
    return json(result.body, result.status);
  } catch (err) {
    console.error('clinical-record falló', err);
    return json({ error: 'No se pudo completar la operación sobre la historia clínica.' }, 500);
  }
});
