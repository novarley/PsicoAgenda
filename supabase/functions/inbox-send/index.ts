// =============================================================================
// Edge Function: respuesta manual desde la bandeja del panel
// POST { conversationId, text }  ·  Authorization: Bearer <sesión del usuario>
//
// verify_jwt = true: Supabase rechaza la llamada si no hay sesión válida.
// Además se lee la conversación con la sesión del usuario: si RLS no se la
// muestra (no es admin/recepción de esa clínica), responde 404.
// El token de Meta nunca sale de aquí hacia el navegador.
// =============================================================================
import { createClient, type SupabaseClient } from '../_shared/deps.ts';
import { env, requireEnv } from '../_shared/env.ts';
import { corsHeaders, json } from '../_shared/cors.ts';
import { type InboxConversation, sendStaffReply } from '../_shared/inbox.ts';
import { createCloudApiSender } from '../_shared/whatsapp/client.ts';

const admin: SupabaseClient = createClient(env.supabaseUrl, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

  const authorization = req.headers.get('Authorization') ?? '';
  const asUser = createClient(env.supabaseUrl, requireEnv('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: 'No autenticado' }, 401);

  let body: { conversationId?: unknown; text?: unknown };
  try { body = await req.json(); } catch { return json({ code: 'INVALID_INPUT', error: 'JSON inválido' }, 400); }

  const result = await sendStaffReply({
    async getConversationAsUser(id) {
      const { data, error } = await asUser.from('conversations')
        .select('id, org_id, wa_id, last_inbound_at, human_handoff').eq('id', id).maybeSingle();
      if (error) throw error;
      return data as InboxConversation | null;
    },
    async getPhoneNumberId(orgId) {
      const { data, error } = await admin.from('organizations').select('wa_phone_number_id').eq('id', orgId).single();
      if (error) throw error;
      return data.wa_phone_number_id;
    },
    async send(phoneNumberId, to, content) {
      const sender = createCloudApiSender({
        phoneNumberId, accessToken: env.waAccessToken, graphVersion: env.waGraphVersion,
      });
      return (await sender.send(to, content)).messageId;
    },
    async logOutbound(row) {
      const { error } = await admin.from('wa_outbound_messages').insert(row);
      if (error) console.error('No se pudo registrar el mensaje saliente', error);
    },
    async takeOver(conversationId) {
      const { error } = await admin.from('conversations')
        .update({ human_handoff: true, handoff_reason: 'staff_reply' }).eq('id', conversationId);
      if (error) throw error;
    },
    now: () => new Date(),
  }, user.id, body);

  return result.ok
    ? json({ messageId: result.messageId })
    : json({ code: result.code, error: result.message }, result.status);
});
