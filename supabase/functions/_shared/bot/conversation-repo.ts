// Persistencia del estado conversacional en Postgres (sustituye a Redis: 0 €).
//
// Dos garantías:
//  • Lease (locked_until): si el usuario envía 2 mensajes seguidos y Meta los entrega
//    en paralelo a dos instancias de la función, se procesan en orden, no a la vez.
//  • Bloqueo optimista (version): si aun así dos escrituras compiten, la segunda falla
//    en vez de pisar el estado de la primera.
import type { SupabaseClient } from '../deps.ts';
import type { BotContext, BotState, TurnResult } from './types.ts';

export interface ConversationRow {
  id: string;
  org_id: string;
  wa_id: string;
  patient_id: string | null;
  state: BotState;
  context: BotContext;
  version: number;
  human_handoff: boolean;
  crisis_flag: boolean;
}

const COLUMNS = 'id, org_id, wa_id, patient_id, state, context, version, human_handoff, crisis_flag';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function acquireConversation(
  db: SupabaseClient, orgId: string, waId: string, leaseMs = 30_000,
): Promise<ConversationRow> {
  const { error: upsertError } = await db.from('conversations')
    .upsert({ org_id: orgId, wa_id: waId }, { onConflict: 'org_id,wa_id', ignoreDuplicates: true });
  if (upsertError) throw upsertError;

  for (let attempt = 0; attempt < 40; attempt++) {
    const now = new Date();
    const { data, error } = await db.from('conversations')
      .update({ locked_until: new Date(now.getTime() + leaseMs).toISOString() })
      .eq('org_id', orgId)
      .eq('wa_id', waId)
      .or(`locked_until.is.null,locked_until.lt."${now.toISOString()}"`)
      .select(COLUMNS)
      .maybeSingle();
    if (error) throw error;
    if (data) return data as ConversationRow;
    await sleep(150 + attempt * 25);   // otra instancia la tiene: esperamos su turno
  }
  throw new Error(`Conversación ocupada demasiado tiempo (${waId})`);
}

export async function saveConversation(
  db: SupabaseClient, row: ConversationRow, result: TurnResult, inboundAt: string,
): Promise<void> {
  const { data, error } = await db.from('conversations')
    .update({
      state: result.state,
      context: result.context,
      patient_id: result.patientId,
      version: row.version + 1,
      locked_until: null,
      last_inbound_at: inboundAt,
      human_handoff: row.human_handoff || Boolean(result.handoff),
      ...(result.handoff ? { handoff_reason: result.handoff.reason } : {}),
      crisis_flag: row.crisis_flag || Boolean(result.crisis),
    })
    .eq('id', row.id)
    .eq('version', row.version)
    .select('id');
  if (error) throw error;
  if (!data?.length) throw new Error(`Conflicto de versión en la conversación ${row.id}`);
}

export async function releaseConversation(db: SupabaseClient, id: string): Promise<void> {
  await db.from('conversations').update({ locked_until: null }).eq('id', id);
}
