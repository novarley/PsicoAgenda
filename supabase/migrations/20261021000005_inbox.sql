-- =============================================================================
-- PsicoAgenda · Bandeja de WhatsApp del panel (human handoff)
-- Vistas con security_invoker: cada rol ve solo lo que su RLS le permite
-- (conversaciones → admin y recepción; profesionales no).
-- =============================================================================

-- Quién del equipo escribió cada respuesta manual (null = bot o recordatorio)
alter table public.wa_outbound_messages
  add column sent_by uuid references auth.users(id);

create index wa_inbound_thread_idx  on public.wa_inbound_messages(org_id, wa_id, received_at);
create index wa_outbound_thread_idx on public.wa_outbound_messages(org_id, wa_id, created_at);

-- Historial unificado de una conversación, en texto legible
create or replace view public.v_conversation_messages
with (security_invoker = true) as
select
  i.org_id,
  c.id                as conversation_id,
  i.wamid             as message_id,
  'in'::text          as direction,
  coalesce(
    i.payload -> 'text' ->> 'body',
    i.payload -> 'interactive' -> 'button_reply' ->> 'title',
    i.payload -> 'interactive' -> 'list_reply' ->> 'title',
    i.payload -> 'button' ->> 'text',
    '[' || i.msg_type || ']'
  )                   as body,
  null::uuid          as sent_by,
  'received'::text    as status,
  i.received_at       as at
from public.wa_inbound_messages i
join public.conversations c on c.org_id = i.org_id and c.wa_id = i.wa_id
union all
select
  o.org_id,
  c.id,
  o.id::text,
  'out',
  coalesce(
    o.payload -> 'text' ->> 'body',
    o.payload -> 'interactive' -> 'body' ->> 'text',
    'Plantilla: ' || (o.payload -> 'template' ->> 'name'),
    '[' || o.kind || ']'
  ),
  o.sent_by,
  o.status,
  o.created_at
from public.wa_outbound_messages o
join public.conversations c on c.org_id = o.org_id and c.wa_id = o.wa_id;

-- Lista de la bandeja: una fila por conversación con su último mensaje
create or replace view public.v_inbox
with (security_invoker = true) as
select
  c.id,
  c.org_id,
  c.wa_id,
  c.patient_id,
  p.full_name                                         as patient_name,
  c.state,
  c.human_handoff,
  c.handoff_reason,
  c.crisis_flag,
  c.last_inbound_at,
  coalesce(c.last_inbound_at > now() - interval '24 hours', false) as window_open,
  exists (
    select 1 from public.crisis_events e
    where e.conversation_id = c.id and e.acknowledged_at is null
  )                                                   as open_crisis,
  lm.body                                             as last_body,
  lm.direction                                        as last_direction,
  coalesce(lm.at, c.updated_at)                       as last_at
from public.conversations c
left join public.patients p on p.id = c.patient_id
left join lateral (
  select m.body, m.direction, m.at
  from public.v_conversation_messages m
  where m.conversation_id = c.id
  order by m.at desc
  limit 1
) lm on true;

-- Tiempo real en el panel: mensajes nuevos, cambios de estado y alertas de crisis.
-- (crisis_events no estaba publicado: la alerta en vivo del panel nunca llegaba.)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.wa_inbound_messages,
      public.wa_outbound_messages,
      public.conversations,
      public.crisis_events;
  end if;
end $$;
