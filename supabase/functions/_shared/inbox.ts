// Respuesta manual del equipo desde la bandeja del panel (human handoff).
// Lógica pura con dependencias inyectadas: inbox-send/index.ts pone Supabase y Meta.
import { LIMITS, type OutboundContent, textMessage } from './whatsapp/schema.ts';

export interface InboxConversation {
  id: string;
  org_id: string;
  wa_id: string;
  last_inbound_at: string | null;
  human_handoff: boolean;
}

export interface InboxDeps {
  /** Lee la conversación CON LA SESIÓN DEL USUARIO: si RLS no la deja ver, no es personal de esa clínica. */
  getConversationAsUser(id: string): Promise<InboxConversation | null>;
  getPhoneNumberId(orgId: string): Promise<string | null>;
  send(phoneNumberId: string, to: string, content: OutboundContent): Promise<string>;
  logOutbound(row: {
    org_id: string; wa_id: string; kind: 'text'; payload: OutboundContent;
    provider_msg_id: string | null; status: 'sent' | 'failed'; error?: string; sent_by: string;
  }): Promise<void>;
  /** Responder a mano pausa el bot: la persona del equipo queda a cargo. */
  takeOver(conversationId: string): Promise<void>;
  now(): Date;
}

export type InboxResult =
  | { ok: true; messageId: string }
  | { ok: false; status: number; code: InboxErrorCode; message: string };

export type InboxErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'OUTSIDE_WINDOW' | 'NO_WHATSAPP' | 'SEND_FAILED';

const WINDOW_MS = 24 * 60 * 60 * 1000;

export async function sendStaffReply(
  deps: InboxDeps, userId: string, input: { conversationId?: unknown; text?: unknown },
): Promise<InboxResult> {
  const conversationId = typeof input.conversationId === 'string' ? input.conversationId : '';
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!/^[0-9a-f-]{36}$/.test(conversationId) || text.length === 0 || text.length > LIMITS.textBody) {
    return fail(400, 'INVALID_INPUT', `Escribe un mensaje de 1 a ${LIMITS.textBody} caracteres.`);
  }

  const convo = await deps.getConversationAsUser(conversationId);
  if (!convo) return fail(404, 'NOT_FOUND', 'Conversación no encontrada.');

  // Meta solo permite texto libre dentro de las 24 h siguientes al último mensaje del paciente
  const last = convo.last_inbound_at ? new Date(convo.last_inbound_at).getTime() : 0;
  if (deps.now().getTime() - last > WINDOW_MS) {
    return fail(409, 'OUTSIDE_WINDOW',
      'Pasaron más de 24 h desde el último mensaje del paciente: WhatsApp solo permite enviarle una plantilla aprobada.');
  }

  const phoneNumberId = await deps.getPhoneNumberId(convo.org_id);
  if (!phoneNumberId) return fail(409, 'NO_WHATSAPP', 'La clínica no tiene un número de WhatsApp configurado.');

  if (!convo.human_handoff) await deps.takeOver(convo.id);

  const content = textMessage(text);
  try {
    const messageId = await deps.send(phoneNumberId, convo.wa_id, content);
    await deps.logOutbound({
      org_id: convo.org_id, wa_id: convo.wa_id, kind: 'text', payload: content,
      provider_msg_id: messageId, status: 'sent', sent_by: userId,
    });
    return { ok: true, messageId };
  } catch (err) {
    await deps.logOutbound({
      org_id: convo.org_id, wa_id: convo.wa_id, kind: 'text', payload: content,
      provider_msg_id: null, status: 'failed', error: String(err).slice(0, 500), sent_by: userId,
    });
    return fail(502, 'SEND_FAILED', 'WhatsApp rechazó el envío. Inténtalo de nuevo en un momento.');
  }
}

function fail(status: number, code: InboxErrorCode, message: string): InboxResult {
  return { ok: false, status, code, message };
}
