// Pruebas del motor FSM con puertos falsos en memoria (sin red ni BD).
import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1.0.13';
import { handleTurn } from '../_shared/bot/engine.ts';
import type { BotPorts, ConversationSnapshot, OrgConfig, PatientSummary, Slot } from '../_shared/bot/types.ts';
import type { UserInput } from '../_shared/whatsapp/inbound.ts';
import { buildOutbound, type OutboundContent } from '../_shared/whatsapp/schema.ts';

const WA_ID = '573001112233';
const NOW = new Date('2026-10-21T15:00:00.000Z'); // 10:00 en Bogotá

const org: OrgConfig = {
  id: 'org-1', name: 'Clínica Demo', countryCode: 'CO', timezone: 'America/Bogota',
  currency: 'COP', consentVersion: 'v1', crisisLines: [],
};

function fakePorts(overrides: Partial<BotPorts> = {}) {
  const calls: Record<string, unknown[]> = {};
  const track = (name: string, arg: unknown) => (calls[name] ??= []).push(arg);
  const patients: PatientSummary[] = [
    { id: 'pat-1', fullName: 'Ana Gómez', phoneE164: `+${WA_ID}`, birthDate: '1990-03-05', lastProfessionalId: 'prof-2' },
    { id: 'pat-2', fullName: 'Luis Pérez', phoneE164: '+573009999999', birthDate: '1985-01-20', lastProfessionalId: null },
  ];
  const slots: Slot[] = [
    { startsAt: '2026-10-22T13:00:00.000Z', endsAt: '2026-10-22T13:50:00.000Z', siteId: 'site-1' }, // jue 08:00
    { startsAt: '2026-10-22T14:00:00.000Z', endsAt: '2026-10-22T14:50:00.000Z', siteId: 'site-1' }, // jue 09:00
    { startsAt: '2026-10-23T13:00:00.000Z', endsAt: '2026-10-23T13:50:00.000Z', siteId: 'site-1' }, // vie 08:00
  ];
  const ports: BotPorts = {
    findPatientByDocument: async (t, n) => (track('find', [t, n]), n === '1020' ? patients[0] : n === '2030' ? patients[1] : null),
    createPatient: async (i) => (track('create', i), { id: 'pat-new', fullName: i.fullName, phoneE164: i.phoneE164, birthDate: null, lastProfessionalId: null }),
    saveConsent: async (id, at) => void track('consent', [id, at]),
    listInsurers: async () => [{ id: 'eps-1', name: 'EPS Sanitas' }],
    listServices: async () => [{ id: 'svc-1', name: 'Psicoterapia individual' }],
    listSites: async () => [
      { id: 'site-1', name: 'Sede Centro', isVirtual: false },
      { id: 'site-2', name: 'Terapia en línea', isVirtual: true },
    ],
    listProfessionals: async () => [{ id: 'prof-1', name: 'Dr. Ruiz' }, { id: 'prof-2', name: 'Dra. Mora' }],
    getLastProfessionalId: async (id) => patients.find((p) => p.id === id)?.lastProfessionalId ?? null,
    availableSlots: async (_p, _s, from, days) => slots.filter((x) => x.startsAt.slice(0, 10) >= from && days > 0),
    book: async (i) => (track('book', i), {
      ok: true, appointmentId: 'appt-1', status: 'pending_payment', startsAt: i.startsAt,
      depositCents: 5_000_000, currency: 'COP', bonoSessionsRemaining: null, holdExpiresAt: null,
    }),
    paymentLink: async () => 'https://checkout.wompi.co/p/?reference=PA-appt-1',
    applyReminderAction: async (id, action) => (track('reminder', [id, action]), {
      ok: true,
      appointment: {
        startsAt: '2026-10-22T13:00:00.000Z', patientId: 'pat-1', professionalId: 'prof-2', professionalName: 'Dra. Mora',
        siteId: 'site-1', siteName: 'Sede Centro', serviceId: 'svc-1', serviceName: 'Psicoterapia individual', modality: 'in_person',
      },
    }),
    ...overrides,
  };
  return { ports, calls };
}

/** Simula una conversación completa encadenando turnos y validando CADA mensaje contra el esquema de Meta. */
function makeChat(ports: BotPorts) {
  let convo: ConversationSnapshot = { state: 'start', context: {}, patientId: null, humanHandoff: false };
  return {
    get convo() { return convo; },
    async send(input: UserInput | string) {
      const msg: UserInput = typeof input === 'string' ? { kind: 'text', text: input } : input;
      const r = await handleTurn(convo, msg, { org, ports, waId: WA_ID, now: NOW });
      r.messages.forEach((m) => buildOutbound(WA_ID, m));   // lanza si algún mensaje no cumple
      convo = { state: r.state, context: r.context, patientId: r.patientId, humanHandoff: convo.humanHandoff || !!r.handoff };
      return r;
    },
  };
}

const reply = (id: string): UserInput => ({ kind: 'reply', id, title: id });
const bodyOf = (m: OutboundContent) =>
  m.type === 'text' ? m.text.body : m.type === 'interactive' ? m.interactive.body.text : m.template.name;
const choiceIds = (m: OutboundContent): string[] => {
  if (m.type !== 'interactive') return [];
  return m.interactive.type === 'button'
    ? m.interactive.action.buttons.map((b) => b.reply.id)
    : m.interactive.action.sections.flatMap((s) => s.rows.map((r) => r.id));
};

Deno.test('flujo completo de 10 pasos: consentimiento → reserva con enlace de pago', async () => {
  const { ports, calls } = fakePorts();
  const chat = makeChat(ports);

  let r = await chat.send('Buenas tardes');
  assertEquals(r.state, 'consent');                                     // 1
  r = await chat.send(reply('consent|yes'));
  assertEquals(r.state, 'ask_doc_type');                                // 2
  r = await chat.send(reply('ask_doc_type|CC'));
  r = await chat.send('1.020');                                         // con punto: se normaliza
  assertEquals(calls.find[0], ['CC', '1020']);                          // 3
  assertMatch(bodyOf(r.messages[0]), /Hola, Ana/);
  assertEquals(r.patientId, 'pat-1');
  assertEquals(r.state, 'ask_insurer');                                 // 4
  assertEquals(r.context.docNumber, undefined, 'el documento no se guarda en el contexto');

  r = await chat.send(reply('ask_insurer|eps-1'));
  // Solo hay 1 servicio → se salta ask_service y pregunta sede (5)
  assertEquals(r.state, 'ask_site');
  r = await chat.send(reply('ask_site|site-1'));
  assertEquals(r.state, 'ask_professional');                            // 6
  assertEquals(choiceIds(r.messages[0])[0], 'ask_professional|prof-2', 'el profesional habitual va primero');

  r = await chat.send(reply('ask_professional|prof-2'));
  assertEquals(r.state, 'ask_day');                                     // 7
  assertEquals(choiceIds(r.messages[0]), ['ask_day|2026-10-22', 'ask_day|2026-10-23']);

  r = await chat.send(reply('ask_day|2026-10-22'));
  assertEquals(r.state, 'ask_time');                                    // 8
  assertEquals(choiceIds(r.messages[0]), ['ask_time|2026-10-22T13:00:00.000Z', 'ask_time|2026-10-22T14:00:00.000Z']);

  r = await chat.send(reply('ask_time|2026-10-22T13:00:00.000Z'));
  assertEquals(r.state, 'confirm');                                     // 9
  assertMatch(bodyOf(r.messages[0]), /08:00/);                          // hora local, no UTC

  r = await chat.send(reply('confirm|yes'));                            // 10
  assertEquals(r.state, 'done');
  assertMatch(bodyOf(r.messages[0]), /checkout\.wompi\.co/);
  assertMatch(bodyOf(r.messages[0]), /50\.000/);                        // 50 % de 100.000 COP
  assertEquals((calls.book[0] as { startsAt: string }).startsAt, '2026-10-22T13:00:00.000Z');
  assertEquals(calls.consent.length, 1);
});

Deno.test('crisis interrumpe cualquier paso, pasa a humano y el bot queda en silencio', async () => {
  const { ports } = fakePorts();
  const chat = makeChat(ports);
  await chat.send('hola');
  await chat.send(reply('consent|yes'));
  const r = await chat.send('la verdad ya no quiero vivir');
  assertEquals(r.handoff?.reason, 'crisis');
  assertEquals(r.crisis?.severity, 'high');
  assertMatch(bodyOf(r.messages[0]), /123/);
  assertEquals(r.state, 'ask_doc_type', 'no avanza el flujo');

  const after = await chat.send('CC');
  assertEquals(after.messages.length, 0, 'con humano a cargo el bot no responde');
});

Deno.test('botón de un paso anterior no se confunde con el actual', async () => {
  const { ports } = fakePorts();
  const chat = makeChat(ports);
  await chat.send('hola');
  await chat.send(reply('consent|yes'));
  const r = await chat.send(reply('consent|yes'));     // vuelve a pulsar el botón viejo
  assertEquals(r.state, 'ask_doc_type');
  assertMatch(bodyOf(r.messages[0]), /paso anterior/);
});

Deno.test('documento existente con otro WhatsApp exige fecha de nacimiento', async () => {
  const { ports } = fakePorts();
  const chat = makeChat(ports);
  await chat.send('hola');
  await chat.send(reply('consent|yes'));
  await chat.send(reply('ask_doc_type|CC'));
  let r = await chat.send('2030');
  assertEquals(r.state, 'verify_birth_date');
  assertEquals(r.patientId, null, 'no se identifica sin el segundo factor');
  r = await chat.send('01/01/2000');
  assertEquals(r.state, 'verify_birth_date');
  r = await chat.send('02/02/2000');
  assertEquals(r.handoff?.reason, 'identity_verification');
});

Deno.test('paciente nuevo se registra con su nombre', async () => {
  const { ports, calls } = fakePorts();
  const chat = makeChat(ports);
  await chat.send('hola');
  await chat.send(reply('consent|yes'));
  await chat.send(reply('ask_doc_type|CC'));
  let r = await chat.send('99999');
  assertEquals(r.state, 'ask_full_name');
  r = await chat.send('x');
  assertEquals(r.state, 'ask_full_name', 'nombre inválido se vuelve a pedir');
  r = await chat.send('María José Restrepo');
  assertEquals(r.patientId, 'pat-new');
  assertEquals((calls.create[0] as { phoneE164: string }).phoneE164, `+${WA_ID}`);
});

Deno.test('rechazo del consentimiento cierra el flujo sin pedir datos', async () => {
  const { ports, calls } = fakePorts();
  const chat = makeChat(ports);
  await chat.send('hola');
  const r = await chat.send(reply('consent|no'));
  assertEquals(r.state, 'closed');
  assertEquals(calls.find, undefined);
});

Deno.test('recordatorio: Confirmar funciona desde cualquier estado', async () => {
  const { ports, calls } = fakePorts();
  const chat = makeChat(ports);
  const r = await chat.send(reply('appt:confirm:0b8f3a2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'));
  assertEquals(calls.reminder[0], ['0b8f3a2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b', 'confirm']);
  assertMatch(bodyOf(r.messages[0]), /confirmada/);
});

Deno.test('recordatorio: Reagendar libera y reanuda en elegir día con el mismo profesional', async () => {
  const { ports } = fakePorts();
  const chat = makeChat(ports);
  const r = await chat.send(reply('appt:reschedule:0b8f3a2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'));
  assertEquals(r.state, 'ask_day');
  assertEquals(r.context.professionalId, 'prof-2');
  assertEquals(r.patientId, 'pat-1');
});

Deno.test('hueco tomado por otra persona al confirmar → vuelve a elegir hora', async () => {
  const { ports } = fakePorts({ book: async () => ({ ok: false, reason: 'SLOT_NOT_AVAILABLE' }) });
  const chat = makeChat(ports);
  for (const step of ['hola', reply('consent|yes'), reply('ask_doc_type|CC'), '1020', reply('ask_insurer|none'),
    reply('ask_site|site-1'), reply('ask_professional|prof-1'), reply('ask_day|2026-10-22'),
    reply('ask_time|2026-10-22T14:00:00.000Z')]) await chat.send(step);
  const r = await chat.send(reply('confirm|yes'));
  assertEquals(r.state, 'ask_time');
  assertMatch(bodyOf(r.messages[0]), /acaba de tomar/);
});

Deno.test('tres respuestas inválidas seguidas → pasa a una persona', async () => {
  const { ports } = fakePorts();
  const chat = makeChat(ports);
  await chat.send('hola');
  await chat.send('quizás');
  await chat.send('mmm');
  const r = await chat.send('no sé');
  assertEquals(r.handoff?.reason, 'stuck');
  assert(r.messages.length > 0);
});
