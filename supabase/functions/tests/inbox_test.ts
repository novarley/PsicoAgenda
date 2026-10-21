import { assert, assertEquals } from 'jsr:@std/assert@1.0.13';
import { type InboxConversation, type InboxDeps, sendStaffReply } from '../_shared/inbox.ts';

const NOW = new Date('2026-10-21T15:00:00.000Z');
const CONVO_ID = '88888888-8888-8888-8888-888888888801';

function fakeDeps(convo: Partial<InboxConversation> | null, opts: { phone?: string | null; sendFails?: boolean } = {}) {
  const calls = { sent: [] as unknown[], logged: [] as Record<string, unknown>[], takenOver: [] as string[] };
  const deps: InboxDeps = {
    getConversationAsUser: async () => convo && {
      id: CONVO_ID, org_id: 'org', wa_id: '573001112233', human_handoff: false,
      last_inbound_at: '2026-10-21T14:50:00.000Z', ...convo,
    },
    getPhoneNumberId: async () => opts.phone === undefined ? 'PN1' : opts.phone,
    send: async (pn, to, content) => {
      if (opts.sendFails) throw new Error('meta caída');
      calls.sent.push({ pn, to, content });
      return 'wamid.out.1';
    },
    logOutbound: async (row) => void calls.logged.push(row),
    takeOver: async (id) => void calls.takenOver.push(id),
    now: () => NOW,
  };
  return { deps, calls };
}

Deno.test('bandeja: envía, registra quién respondió y pausa el bot', async () => {
  const { deps, calls } = fakeDeps({});
  const r = await sendStaffReply(deps, 'user-recepcion', { conversationId: CONVO_ID, text: '  Hola, soy Laura del equipo.\nTe llamo en 5 min.  ' });
  assertEquals(r, { ok: true, messageId: 'wamid.out.1' });
  assertEquals(calls.takenOver, [CONVO_ID]);
  assertEquals(calls.logged[0].sent_by, 'user-recepcion');
  assertEquals(calls.logged[0].status, 'sent');
  const sent = calls.sent[0] as { content: { text: { body: string } } };
  assertEquals(sent.content.text.body, 'Hola, soy Laura del equipo.\nTe llamo en 5 min.');
});

Deno.test('bandeja: si ya estaba a cargo de una persona no vuelve a tomarla', async () => {
  const { deps, calls } = fakeDeps({ human_handoff: true });
  await sendStaffReply(deps, 'u', { conversationId: CONVO_ID, text: 'ok' });
  assertEquals(calls.takenOver.length, 0);
});

Deno.test('bandeja: fuera de la ventana de 24 h no envía texto libre', async () => {
  const { deps, calls } = fakeDeps({ last_inbound_at: '2026-10-20T14:00:00.000Z' });
  const r = await sendStaffReply(deps, 'u', { conversationId: CONVO_ID, text: 'hola' });
  assert(!r.ok && r.code === 'OUTSIDE_WINDOW' && r.status === 409);
  assertEquals(calls.sent.length, 0);
  assertEquals(calls.takenOver.length, 0, 'no debe pausar el bot si no envió nada');
});

Deno.test('bandeja: conversación no visible para el usuario → 404', async () => {
  const { deps } = fakeDeps(null);
  const r = await sendStaffReply(deps, 'u', { conversationId: CONVO_ID, text: 'hola' });
  assert(!r.ok && r.status === 404);
});

Deno.test('bandeja: entrada inválida', async () => {
  const { deps } = fakeDeps({});
  for (const input of [{ conversationId: CONVO_ID, text: '   ' }, { conversationId: 'x', text: 'hola' },
    { conversationId: CONVO_ID, text: 'a'.repeat(5000) }, {}]) {
    const r = await sendStaffReply(deps, 'u', input);
    assert(!r.ok && r.code === 'INVALID_INPUT', JSON.stringify(input));
  }
});

Deno.test('bandeja: clínica sin número de WhatsApp', async () => {
  const { deps } = fakeDeps({}, { phone: null });
  const r = await sendStaffReply(deps, 'u', { conversationId: CONVO_ID, text: 'hola' });
  assert(!r.ok && r.code === 'NO_WHATSAPP');
});

Deno.test('bandeja: fallo de Meta queda registrado como failed', async () => {
  const { deps, calls } = fakeDeps({}, { sendFails: true });
  const r = await sendStaffReply(deps, 'u', { conversationId: CONVO_ID, text: 'hola' });
  assert(!r.ok && r.code === 'SEND_FAILED' && r.status === 502);
  assertEquals(calls.logged[0].status, 'failed');
});
