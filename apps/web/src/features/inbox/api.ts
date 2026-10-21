// Acceso a datos de la bandeja. Con VITE_DEMO=true usa datos en memoria (demo.ts)
// para ver la pantalla sin un proyecto de Supabase; si no, Supabase + RLS.
import { isDemo, supabase } from '../../lib/supabase';
import { demoInboxApi } from './demo';

export interface InboxItem {
  id: string;
  wa_id: string;
  patient_name: string | null;
  state: string;
  human_handoff: boolean;
  handoff_reason: string | null;
  crisis_flag: boolean;
  window_open: boolean;
  open_crisis: boolean;
  last_body: string | null;
  last_direction: 'in' | 'out' | null;
  last_at: string;
}

export interface ThreadMessage {
  message_id: string;
  direction: 'in' | 'out';
  body: string;
  sent_by: string | null;   // null = bot o recordatorio automático
  status: string;           // received | sent | delivered | read | failed
  at: string;
}

export type SendResult = { ok: true } | { ok: false; code: string; error: string };

export interface InboxApi {
  list(): Promise<InboxItem[]>;
  thread(conversationId: string): Promise<ThreadMessage[]>;
  send(conversationId: string, text: string): Promise<SendResult>;
  setHandoff(conversationId: string, humanInCharge: boolean): Promise<void>;
  ackCrisis(conversationId: string): Promise<void>;
  /** Avisa cuando llega o cambia algo; devuelve la función para dejar de escuchar. */
  subscribe(onChange: () => void): () => void;
}

const supabaseInboxApi: InboxApi = {
  async list() {
    const { data, error } = await supabase.from('v_inbox').select('*').order('last_at', { ascending: false }).limit(200);
    if (error) throw error;
    return data as InboxItem[];
  },

  async thread(conversationId) {
    const { data, error } = await supabase.from('v_conversation_messages')
      .select('message_id, direction, body, sent_by, status, at')
      .eq('conversation_id', conversationId).order('at', { ascending: true }).limit(300);
    if (error) throw error;
    return data as ThreadMessage[];
  },

  async send(conversationId, text) {
    const { error } = await supabase.functions.invoke('inbox-send', { body: { conversationId, text } });
    if (!error) return { ok: true };
    // FunctionsHttpError trae la respuesta de la función con { code, error }
    const detail = await (error as { context?: Response }).context?.json().catch(() => null);
    return { ok: false, code: detail?.code ?? 'UNKNOWN', error: detail?.error ?? 'No se pudo enviar el mensaje.' };
  },

  async setHandoff(conversationId, humanInCharge) {
    const { error } = await supabase.from('conversations')
      .update({ human_handoff: humanInCharge, handoff_reason: humanInCharge ? 'staff_takeover' : null })
      .eq('id', conversationId);
    if (error) throw error;
  },

  async ackCrisis(conversationId) {
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('crisis_events')
      .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: user?.id })
      .eq('conversation_id', conversationId).is('acknowledged_at', null);
    if (error) throw error;
  },

  subscribe(onChange) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const notify = () => { clearTimeout(timer); timer = setTimeout(onChange, 250); };
    const channel = supabase.channel('inbox');
    for (const table of ['wa_inbound_messages', 'wa_outbound_messages', 'conversations', 'crisis_events']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, notify);
    }
    channel.subscribe();
    return () => { clearTimeout(timer); supabase.removeChannel(channel); };
  },
};

export const inboxApi: InboxApi = isDemo ? demoInboxApi : supabaseInboxApi;
