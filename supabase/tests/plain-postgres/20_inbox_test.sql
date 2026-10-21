-- Pruebas de la bandeja (migración 0005). Se ejecuta DESPUÉS de 10_booking_rls_test.sql,
-- reutilizando su organización, usuarios y pacientes sintéticos.
\set ON_ERROR_STOP 1
reset role;
set request.jwt.claims = '{"role":"service_role"}';

insert into public.conversations (id, org_id, wa_id, patient_id, state, human_handoff, handoff_reason, crisis_flag, last_inbound_at)
values
  ('88888888-8888-8888-8888-888888888801', '11111111-1111-1111-1111-111111111111', '573000000001',
   '55555555-5555-5555-5555-555555555501', 'ask_doc_type', true, 'crisis', true, now() - interval '5 minutes'),
  ('88888888-8888-8888-8888-888888888802', '11111111-1111-1111-1111-111111111111', '573000000002',
   null, 'done', false, null, false, now() - interval '3 days');

insert into public.wa_inbound_messages (wamid, org_id, wa_id, msg_type, payload, received_at) values
  ('wamid.t1', '11111111-1111-1111-1111-111111111111', '573000000001', 'text',
   '{"type":"text","text":{"body":"ya no quiero vivir"}}', now() - interval '5 minutes'),
  ('wamid.t2', '11111111-1111-1111-1111-111111111111', '573000000002', 'interactive',
   '{"type":"interactive","interactive":{"type":"list_reply","list_reply":{"id":"x","title":"jue 22 oct"}}}', now() - interval '3 days');

insert into public.wa_outbound_messages (org_id, wa_id, kind, payload, status, sent_by, created_at) values
  ('11111111-1111-1111-1111-111111111111', '573000000001', 'text',
   '{"type":"text","text":{"body":"Hola, soy Laura del equipo. Estoy aquí."}}', 'sent',
   '00000000-0000-0000-0000-0000000000a2', now() - interval '1 minute'),
  ('11111111-1111-1111-1111-111111111111', '573000000002', 'template',
   '{"type":"template","template":{"name":"recordatorio_cita_48h"}}', 'delivered', null, now() - interval '2 days');

insert into public.crisis_events (org_id, conversation_id, patient_id, severity, matched_rules)
values ('11111111-1111-1111-1111-111111111111', '88888888-8888-8888-8888-888888888801',
        '55555555-5555-5555-5555-555555555501', 'high', array['no_quiero_vivir']);

set role authenticated;

-- Recepción ve la bandeja completa con su último mensaje
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000a2"}';
do $$
declare r record; n int;
begin
  select count(*) into n from public.v_inbox;
  assert n = 2, format('recepción debía ver 2 conversaciones, vio %s', n);

  select * into r from public.v_inbox where id = '88888888-8888-8888-8888-888888888801';
  assert r.patient_name = 'Paciente Uno', 'falta el nombre del paciente';
  assert r.open_crisis, 'debe marcar la crisis abierta';
  assert r.window_open, 'la ventana de 24 h está abierta';
  assert r.last_direction = 'out' and r.last_body like 'Hola, soy Laura%', format('último mensaje: %s', r.last_body);

  select * into r from public.v_inbox where id = '88888888-8888-8888-8888-888888888802';
  assert not r.window_open, 'tras 3 días la ventana está cerrada';
  assert r.last_body = 'Plantilla: recordatorio_cita_48h', format('plantilla: %s', r.last_body);

  select count(*) into n from public.v_conversation_messages
  where conversation_id = '88888888-8888-8888-8888-888888888802' and body = 'jue 22 oct';
  assert n = 1, 'la respuesta de lista debe mostrarse con su título';

  -- Recepción puede devolver la conversación al bot y atender la crisis
  update public.conversations set human_handoff = false where id = '88888888-8888-8888-8888-888888888801';
  get diagnostics n = row_count;
  assert n = 1, 'recepción debe poder devolver la conversación al bot';
  update public.crisis_events set acknowledged_at = now(), acknowledged_by = '00000000-0000-0000-0000-0000000000a2'
  where conversation_id = '88888888-8888-8888-8888-888888888801';
  get diagnostics n = row_count;
  assert n = 1, 'recepción debe poder marcar la crisis como atendida';
end $$;

-- Un profesional no ve la bandeja de WhatsApp (solo su agenda y sus historias)
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000a3"}';
do $$ declare n int; begin
  select count(*) into n from public.v_inbox;
  assert n = 0, 'un profesional no debe ver la bandeja';
  select count(*) into n from public.v_conversation_messages;
  assert n = 0, 'un profesional no debe ver los mensajes';
end $$;

reset role;
\echo 'OK 8 · bandeja: vistas legibles, ventana 24 h, crisis abierta, permisos por rol'
