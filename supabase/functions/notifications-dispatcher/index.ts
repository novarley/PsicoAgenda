// =============================================================================
// Edge Function: dispatcher de notificaciones programadas
// La invoca pg_cron cada 5 min (migración 0004) con la cabecera x-dispatcher-secret.
//
// Recordatorios 48 h / 2 h con botones Confirmar · Reagendar · Cancelar (payload
// appt:<acción>:<id>, que el webhook entiende en cualquier paso del bot),
// mensaje post-sesión y oferta de hueco liberado a la lista de espera.
//
// Fuera de la ventana de 24 h Meta solo permite PLANTILLAS aprobadas: los nombres
// por defecto están abajo y se pueden cambiar por clínica en organizations.settings.templates.
// =============================================================================
import { createClient, type SupabaseClient } from '../_shared/deps.ts';
import { env } from '../_shared/env.ts';
import { timingSafeEqual } from '../_shared/crypto.ts';
import { createCloudApiSender } from '../_shared/whatsapp/client.ts';
import { type OutboundContent, templateMessage } from '../_shared/whatsapp/schema.ts';
import { formatDateTimeLong } from '../_shared/time.ts';

const db: SupabaseClient = createClient(env.supabaseUrl, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DEFAULT_TEMPLATES = {
  reminder_48h: 'recordatorio_cita_48h',
  reminder_2h: 'recordatorio_cita_2h',
  aftercare: 'seguimiento_post_sesion',
  waitlist_offer: 'oferta_lista_espera',
} as const;

const MAX_ATTEMPTS = 5;

interface Job {
  id: string;
  org_id: string;
  appointment_id: string | null;
  waitlist_entry_id: string | null;
  kind: 'reminder_48h' | 'reminder_2h' | 'aftercare' | 'pre_questionnaire' | 'waitlist_offer';
  attempts: number;
}

type Outcome = { status: 'sent'; providerMessageId: string } | { status: 'skipped'; reason: string };

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  if (!timingSafeEqual(req.headers.get('x-dispatcher-secret') ?? '', env.dispatcherSecret)) {
    return new Response('unauthorized', { status: 401 });
  }

  const { data: jobs, error } = await db.rpc('claim_due_notifications', { p_limit: 50 });
  if (error) {
    console.error('claim_due_notifications falló', error);
    return Response.json({ error: 'claim_failed' }, { status: 500 });
  }

  const summary = { sent: 0, skipped: 0, failed: 0 };
  for (const job of (jobs ?? []) as Job[]) {
    try {
      const outcome = await dispatch(job);
      if (outcome.status === 'sent') {
        summary.sent++;
        await db.from('scheduled_notifications')
          .update({ status: 'sent', sent_at: new Date().toISOString(), last_error: null }).eq('id', job.id);
      } else {
        summary.skipped++;
        await db.from('scheduled_notifications')
          .update({ status: 'skipped', last_error: outcome.reason }).eq('id', job.id);
      }
    } catch (err) {
      summary.failed++;
      const retry = job.attempts < MAX_ATTEMPTS;
      await db.from('scheduled_notifications').update({
        status: retry ? 'pending' : 'failed',
        // reintento con espera creciente: 5, 10, 15… minutos
        ...(retry ? { send_at: new Date(Date.now() + job.attempts * 5 * 60_000).toISOString() } : {}),
        last_error: String(err).slice(0, 500),
      }).eq('id', job.id);
    }
  }
  return Response.json(summary);
});

async function dispatch(job: Job): Promise<Outcome> {
  const { data: org, error: orgErr } = await db.from('organizations')
    .select('id, name, timezone, wa_phone_number_id, settings').eq('id', job.org_id).single();
  if (orgErr) throw orgErr;
  if (!org.wa_phone_number_id) return { status: 'skipped', reason: 'org_sin_whatsapp' };

  const settings = (org.settings ?? {}) as { templates?: Partial<Record<keyof typeof DEFAULT_TEMPLATES, string>>; template_language?: string };
  const language = settings.template_language ?? 'es';
  const templateName = (kind: keyof typeof DEFAULT_TEMPLATES) => settings.templates?.[kind] ?? DEFAULT_TEMPLATES[kind];

  let to: string;
  let content: OutboundContent;

  if (job.kind === 'waitlist_offer') {
    const { data: w, error } = await db.from('waitlist_entries')
      .select('id, status, offered_slot_at, patients(full_name, phone_e164, whatsapp_opt_in)')
      .eq('org_id', job.org_id).eq('id', job.waitlist_entry_id!).single();
    if (error) throw error;
    const p = w.patients as unknown as PatientRow;
    if (w.status !== 'offered' || !w.offered_slot_at) return { status: 'skipped', reason: 'oferta_no_vigente' };
    if (!p?.whatsapp_opt_in || !p.phone_e164) return { status: 'skipped', reason: 'sin_opt_in' };
    to = p.phone_e164;
    content = templateMessage(templateName('waitlist_offer'), language, [firstName(p.full_name), formatDateTimeLong(w.offered_slot_at, org.timezone)]);
  } else {
    if (job.kind === 'pre_questionnaire') return { status: 'skipped', reason: 'no_implementado' };
    const { data: a, error } = await db.from('appointments')
      .select(`id, status, starts_at, modality,
               patients(full_name, phone_e164, whatsapp_opt_in), professionals(full_name), sites(name)`)
      .eq('org_id', job.org_id).eq('id', job.appointment_id!).single();
    if (error) throw error;
    const p = a.patients as unknown as PatientRow;
    if (!p?.whatsapp_opt_in || !p.phone_e164) return { status: 'skipped', reason: 'sin_opt_in' };

    const professional = (a.professionals as unknown as { full_name: string }).full_name;
    if (job.kind === 'aftercare') {
      if (!['confirmed', 'completed', 'scheduled'].includes(a.status)) return { status: 'skipped', reason: `cita_${a.status}` };
      to = p.phone_e164;
      content = templateMessage(templateName('aftercare'), language, [firstName(p.full_name), professional]);
    } else {
      if (!['scheduled', 'confirmed'].includes(a.status)) return { status: 'skipped', reason: `cita_${a.status}` };
      const place = a.modality === 'online' ? 'en línea' : (a.sites as unknown as { name: string }).name;
      to = p.phone_e164;
      content = templateMessage(
        templateName(job.kind), language,
        [firstName(p.full_name), formatDateTimeLong(a.starts_at, org.timezone), professional, place],
        [`appt:confirm:${a.id}`, `appt:reschedule:${a.id}`, `appt:cancel:${a.id}`],
      );
    }
  }

  const sender = createCloudApiSender({
    phoneNumberId: org.wa_phone_number_id, accessToken: env.waAccessToken, graphVersion: env.waGraphVersion,
  });
  const { messageId } = await sender.send(to, content);
  await db.from('wa_outbound_messages').insert({
    org_id: job.org_id, wa_id: to.replace(/^\+/, ''), kind: 'template',
    template_name: content.type === 'template' ? content.template.name : null,
    payload: content, provider_msg_id: messageId, status: 'sent', notification_id: job.id,
  });
  return { status: 'sent', providerMessageId: messageId };
}

interface PatientRow { full_name: string; phone_e164: string | null; whatsapp_opt_in: boolean }

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}
