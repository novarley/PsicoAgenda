// =============================================================================
// Edge Function: webhook de la WhatsApp Cloud API (Meta)
//
//   GET  → verificación de la suscripción (hub.challenge)
//   POST → mensajes entrantes y estados de entrega
//
// Contrato con Meta: responder 200 rápido o reintenta. Por eso:
//   1. se verifica la firma X-Hub-Signature-256 sobre el cuerpo crudo,
//   2. cada mensaje se registra por su wamid (los reintentos se descartan),
//   3. se responde 200 y el bot trabaja en segundo plano (EdgeRuntime.waitUntil).
//
// URL: https://<project-ref>.supabase.co/functions/v1/whatsapp-webhook
// Requiere verify_jwt = false (Meta no envía JWT de Supabase); ver supabase/config.toml.
// =============================================================================
import { createClient, type SupabaseClient } from '../_shared/deps.ts';
import { env } from '../_shared/env.ts';
import { timingSafeEqual, verifyMetaSignature } from '../_shared/crypto.ts';
import { type InboundMessage, parseWebhook, type StatusUpdate } from '../_shared/whatsapp/inbound.ts';
import { createCloudApiSender, type WhatsAppSender } from '../_shared/whatsapp/client.ts';
import { textMessage, type OutboundContent } from '../_shared/whatsapp/schema.ts';
import { handleTurn } from '../_shared/bot/engine.ts';
import { createSupabasePorts, type LoadedOrg, loadOrgByPhoneNumberId } from '../_shared/bot/supabase-ports.ts';
import { acquireConversation, releaseConversation, saveConversation } from '../_shared/bot/conversation-repo.ts';
import type { TurnResult } from '../_shared/bot/types.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const db: SupabaseClient = createClient(env.supabaseUrl, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (req) => {
  if (req.method === 'GET') return verifySubscription(new URL(req.url));
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const raw = await req.text();
  if (!(await verifyMetaSignature(env.waAppSecret, raw, req.headers.get('x-hub-signature-256')))) {
    return new Response('invalid signature', { status: 401 });
  }

  let body: unknown;
  try { body = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }

  const events = parseWebhook(body);
  // Payload que no es de mensajes (p. ej. cambios de plantilla): 200 para que Meta no reintente
  if (!events) return new Response('ignored', { status: 200 });

  // Registro durable + deduplicación ANTES de responder: si la función muere después,
  // el mensaje queda en wa_inbound_messages con processed_at = null para reprocesarlo.
  const fresh = await recordInbound(events.messages);

  const work = Promise.all([
    processStatuses(events.statuses),
    processConversations(fresh),
  ]).catch((err) => console.error('Fallo procesando webhook', err));

  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work);
  else await work;
  return new Response('ok', { status: 200 });
});

function verifySubscription(url: URL): Response {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token') ?? '';
  const challenge = url.searchParams.get('hub.challenge') ?? '';
  if (mode === 'subscribe' && timingSafeEqual(token, env.waVerifyToken)) {
    return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  return new Response('forbidden', { status: 403 });
}

// -----------------------------------------------------------------------------
interface FreshMessage { org: LoadedOrg; msg: InboundMessage }

async function recordInbound(messages: InboundMessage[]): Promise<FreshMessage[]> {
  const fresh: FreshMessage[] = [];
  for (const msg of messages) {
    const org = await loadOrgByPhoneNumberId(db, msg.phoneNumberId);
    if (!org) {
      console.warn(`phone_number_id sin organización: ${msg.phoneNumberId}`);
      continue;
    }
    const { data, error } = await db.from('wa_inbound_messages')
      .upsert({
        wamid: msg.wamid, org_id: org.config.id, wa_id: msg.from, msg_type: msg.type, payload: msg.raw,
        received_at: msg.sentAt,
      }, { onConflict: 'wamid', ignoreDuplicates: true })
      .select('wamid');
    if (error) throw error;
    if (data?.length) fresh.push({ org, msg });   // vacío = reintento de Meta ya procesado
  }
  return fresh;
}

async function processStatuses(statuses: StatusUpdate[]): Promise<void> {
  for (const s of statuses) {
    await db.from('wa_outbound_messages')
      .update({ status: s.status, ...(s.errorCode ? { error: `meta_error_${s.errorCode}` } : {}) })
      .eq('provider_msg_id', s.providerMessageId);
  }
}

/** Mensajes del mismo usuario en orden; usuarios distintos en paralelo. */
async function processConversations(fresh: FreshMessage[]): Promise<void> {
  const byUser = new Map<string, FreshMessage[]>();
  for (const f of fresh) {
    const key = `${f.org.config.id}:${f.msg.from}`;
    byUser.set(key, [...(byUser.get(key) ?? []), f]);
  }
  await Promise.all([...byUser.values()].map(async (queue) => {
    for (const f of queue) await processMessage(f);
  }));
}

async function processMessage({ org, msg }: FreshMessage): Promise<void> {
  const convo = await acquireConversation(db, org.config.id, msg.from);
  const sender = createCloudApiSender({
    phoneNumberId: msg.phoneNumberId, accessToken: env.waAccessToken, graphVersion: env.waGraphVersion,
  });

  let result: TurnResult;
  try {
    result = await handleTurn(
      { state: convo.state, context: convo.context, patientId: convo.patient_id, humanHandoff: convo.human_handoff },
      msg.input,
      { org: org.config, ports: createSupabasePorts(db, org.config), waId: msg.from, now: new Date() },
    );
    // Primero se guarda el estado, luego se envía: un fallo de envío nunca repite una reserva.
    await saveConversation(db, convo, result, msg.sentAt);
  } catch (err) {
    await releaseConversation(db, convo.id);
    await db.from('wa_inbound_messages').update({ error: String(err) }).eq('wamid', msg.wamid);
    throw err;
  }

  for (const content of result.messages) await sendAndLog(sender, org, msg.from, content);

  if (result.crisis) await escalateCrisis(sender, org, convo.id, result, msg);

  await db.from('wa_inbound_messages').update({ processed_at: new Date().toISOString() }).eq('wamid', msg.wamid);
}

async function sendAndLog(sender: WhatsAppSender, org: LoadedOrg, to: string, content: OutboundContent) {
  const row = { org_id: org.config.id, wa_id: to, kind: content.type, payload: content };
  try {
    const { messageId } = await sender.send(to, content);
    await db.from('wa_outbound_messages').insert({ ...row, provider_msg_id: messageId, status: 'sent' });
    return true;
  } catch (err) {
    console.error('Envío a WhatsApp falló', err);
    await db.from('wa_outbound_messages').insert({ ...row, status: 'failed', error: String(err) });
    return false;
  }
}

/** Registra la alerta y avisa al profesional de guardia (sin incluir el contenido del mensaje). */
async function escalateCrisis(
  sender: WhatsAppSender, org: LoadedOrg, conversationId: string, result: TurnResult, msg: InboundMessage,
) {
  let notified = false;
  if (org.onCallPhone) {
    notified = await sendAndLog(sender, org, org.onCallPhone.replace(/^\+/, ''), textMessage(
      `⚠️ Alerta de crisis (${result.crisis!.severity === 'high' ? 'riesgo ALTO' : 'riesgo medio'}) ` +
        `en la conversación con +${msg.from}. El bot quedó en pausa. Atiéndela desde el panel ahora.`,
    ));
    // Si el profesional de guardia no escribió al número en 24 h, Meta exige plantilla:
    // el panel muestra igualmente la alerta en tiempo real (Supabase Realtime sobre crisis_events).
  }
  const { error } = await db.from('crisis_events').insert({
    org_id: org.config.id, conversation_id: conversationId, patient_id: result.patientId,
    wamid: msg.wamid, severity: result.crisis!.severity, matched_rules: result.crisis!.rules,
    on_call_notified: notified,
  });
  if (error) console.error('No se pudo registrar crisis_event', error);
}
