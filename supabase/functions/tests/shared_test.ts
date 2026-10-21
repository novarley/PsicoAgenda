import { assert, assertEquals, assertRejects, assertThrows } from 'jsr:@std/assert@1.0.13';
import { crisisLinesFor, detectCrisis } from '../_shared/bot/crisis.ts';
import {
  buildOutbound, buttonsMessage, InvalidWhatsAppMessageError, LIMITS, listMessage, templateMessage, textMessage,
} from '../_shared/whatsapp/schema.ts';
import { parseWebhook } from '../_shared/whatsapp/inbound.ts';
import { decryptText, encryptText, hmacSha256Hex, importAesKey, verifyMetaSignature } from '../_shared/crypto.ts';
import { addDaysToKey, formatTime, localDateKey } from '../_shared/time.ts';
import { wompiCheckoutUrl, wompiIntegritySignature } from '../_shared/payments/wompi.ts';
import { parseBirthDate, phonesMatch } from '../_shared/bot/engine.ts';

// ------------------------------------------------------------------- crisis
Deno.test('crisis: detecta ideación suicida con tildes, mayúsculas y letras repetidas', () => {
  for (const text of [
    'Ya no quiero vivir',
    'a veces pienso en SUICIDARME',
    'quierooo morirme',
    'me quiero quitar la vida',   // variante sin "quitarme"
    'voy a acabar con todo hoy',
    'me tomé todas las pastillas',
    'me voy a tirar del puente',
    'quiero hacerme daño',
  ]) {
    const hit = detectCrisis(text);
    assert(hit, `no detectó: "${text}"`);
    assertEquals(hit.severity, 'high', text);
  }
});

Deno.test('crisis: pánico es severidad media', () => {
  assertEquals(detectCrisis('creo que tengo un ataque de pánico, no puedo respirar')?.severity, 'medium');
});

Deno.test('crisis: mensajes normales no disparan alerta', () => {
  for (const text of ['Hola, quiero agendar una cita', 'CC', '1020304050', 'El martes en la tarde', 'Me muero de risa jaja']) {
    assertEquals(detectCrisis(text), null, text);
  }
});

Deno.test('crisis: líneas por país con respaldo', () => {
  assertEquals(crisisLinesFor('ES', [])[0].phone, '024');
  assertEquals(crisisLinesFor('CO', [{ name: 'Línea 106', phone: '106' }])[0].phone, '106');
});

// ------------------------------------------------------------- validación WA
Deno.test('schema: los builders recortan títulos largos y el resultado es válido', () => {
  const msg = listMessage('Elige profesional', 'Ver profesionales con nombre larguísimo', [
    { id: 'p|1', title: 'Dra. María Fernanda Rodríguez Castañeda', description: 'x'.repeat(200) },
  ]);
  const out = buildOutbound('+573001112233', msg);
  assert(out.type === 'interactive' && out.interactive.type === 'list');
  const row = out.interactive.action.sections[0].rows[0];
  assert(row.title.length <= LIMITS.rowTitle);
  assert((row.description ?? '').length <= LIMITS.rowDescription);
  assertEquals(out.to, '573001112233');
});

Deno.test('schema: los cuerpos conservan saltos de línea; los títulos se compactan', () => {
  const msg = buttonsMessage('Revisa tu cita:\n• Profesional: X\n\n\n\n¿La confirmo?  ', [{ id: 'c|1', title: 'Confirmar\n ya' }]);
  const out = buildOutbound('573001112233', msg);
  assert(out.type === 'interactive' && out.interactive.type === 'button');
  assertEquals(out.interactive.body.text, 'Revisa tu cita:\n• Profesional: X\n\n¿La confirmo?');
  assertEquals(out.interactive.action.buttons[0].reply.title, 'Confirmar ya');
  const text = buildOutbound('573001112233', textMessage('Línea 1\nLínea 2'));
  assert(text.type === 'text');
  assertEquals(text.text.body, 'Línea 1\nLínea 2');
});

Deno.test('schema: rechaza más de 3 botones, ids repetidos y claves sobrantes', () => {
  const four = buttonsMessage('¿?', [1, 2, 3, 4].map((n) => ({ id: `b|${n}`, title: `Op ${n}` })));
  assertThrows(() => buildOutbound('573001112233', four), InvalidWhatsAppMessageError);

  const dup = buttonsMessage('¿?', [{ id: 'b|1', title: 'A' }, { id: 'b|1', title: 'B' }]);
  assertThrows(() => buildOutbound('573001112233', dup), InvalidWhatsAppMessageError, 'repetido');

  const extra = { ...textMessage('hola'), metadata: { traza: 1 } } as never;
  assertThrows(() => buildOutbound('573001112233', extra), InvalidWhatsAppMessageError);
});

Deno.test('schema: rechaza destinatario inválido y parámetros de plantilla con salto de línea', () => {
  assertThrows(() => buildOutbound('abc', textMessage('hola')), InvalidWhatsAppMessageError);
  const bad = templateMessage('recordatorio_cita_48h', 'es', ['ok']);
  (bad as { template: { components: { parameters: { text: string }[] }[] } }).template.components[0].parameters[0].text = 'a\nb';
  assertThrows(() => buildOutbound('573001112233', bad), InvalidWhatsAppMessageError, 'salto de línea');
});

Deno.test('schema: plantilla de recordatorio con 3 quick replies es válida', () => {
  const t = templateMessage('recordatorio_cita_48h', 'es', ['Ana', 'jueves, 23 de octubre · 08:00', 'Dra. Ruiz', 'Sede Centro'],
    ['appt:confirm:x', 'appt:reschedule:x', 'appt:cancel:x']);
  buildOutbound('573001112233', t);
});

// ----------------------------------------------------------------- inbound
Deno.test('inbound: normaliza texto, respuesta de lista y quick reply de plantilla', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: 'PN1', display_phone_number: '57300' },
      contacts: [{ wa_id: '573001112233', profile: { name: 'Ana' } }],
      messages: [
        { from: '573001112233', id: 'wamid.1', timestamp: '1760000000', type: 'text', text: { body: 'hola' } },
        { from: '573001112233', id: 'wamid.2', timestamp: '1760000001', type: 'interactive',
          interactive: { type: 'list_reply', list_reply: { id: 'ask_day|2026-10-23', title: 'jue 23 oct' } } },
        { from: '573001112233', id: 'wamid.3', timestamp: '1760000002', type: 'button',
          button: { payload: 'appt:confirm:abc', text: 'Confirmar' } },
        { from: '573001112233', id: 'wamid.4', timestamp: '1760000003', type: 'image', image: { id: 'm' } },
      ],
      campo_nuevo_de_meta: true,
    } }] }],
  };
  const parsed = parseWebhook(payload)!;
  assertEquals(parsed.messages.map((m) => m.input.kind), ['text', 'reply', 'reply', 'unsupported']);
  assertEquals(parsed.messages[0].profileName, 'Ana');
  assertEquals(parsed.messages[0].sentAt, new Date(1760000000 * 1000).toISOString());
  assertEquals(parseWebhook({ object: 'otra_cosa' }), null);
});

// ------------------------------------------------------------------ crypto
Deno.test('crypto: firma de Meta válida, alterada y ausente', async () => {
  const body = '{"object":"whatsapp_business_account"}';
  const sig = `sha256=${await hmacSha256Hex('app-secret', body)}`;
  assert(await verifyMetaSignature('app-secret', body, sig));
  assert(!(await verifyMetaSignature('app-secret', body + ' ', sig)));
  assert(!(await verifyMetaSignature('app-secret', body, null)));
});

Deno.test('crypto: AES-GCM cifra, descifra y rechaza AAD distinta', async () => {
  const key = await importAesKey(btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))));
  const ct = await encryptText(key, 'Paciente refiere insomnio', 'nota-1');
  assert(!ct.includes('insomnio'));
  assertEquals(await decryptText(key, ct, 'nota-1'), 'Paciente refiere insomnio');
  await assertRejects(() => decryptText(key, ct, 'nota-2'));
});

// -------------------------------------------------------------------- time
Deno.test('time: 23:30 en Bogotá sigue siendo el mismo día aunque en UTC ya sea mañana', () => {
  const instant = '2026-10-23T04:30:00.000Z';            // = 22-oct 23:30 en Bogotá
  assertEquals(localDateKey(instant, 'America/Bogota'), '2026-10-22');
  assertEquals(localDateKey(instant, 'Europe/Madrid'), '2026-10-23');
  assertEquals(formatTime('2026-10-23T13:00:00Z', 'America/Bogota'), '08:00');
  assertEquals(addDaysToKey('2026-12-31', 1), '2027-01-01');
});

// ----------------------------------------------------------------- helpers
Deno.test('helpers: teléfonos y fecha de nacimiento', () => {
  assert(phonesMatch('+573001112233', '573001112233'));
  assert(phonesMatch('3001112233', '573001112233'));
  assert(!phonesMatch('+573009999999', '573001112233'));
  assertEquals(parseBirthDate('5/3/1990'), '1990-03-05');
  assertEquals(parseBirthDate('31/02/1990'), null);
});

// ------------------------------------------------------------------- wompi
Deno.test('wompi: firma de integridad = sha256(ref + monto + moneda + secreto)', async () => {
  const expected = await (async () => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('PA-1' + '5000000' + 'COP' + 'secreto'));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  })();
  assertEquals(await wompiIntegritySignature({ reference: 'PA-1', amountInCents: 5000000, currency: 'COP', integritySecret: 'secreto' }), expected);
  const url = new URL(await wompiCheckoutUrl({
    publicKey: 'pub_test_x', integritySecret: 'secreto', reference: 'PA-1', amountInCents: 5000000, currency: 'COP',
  }));
  assertEquals(url.searchParams.get('signature:integrity'), expected);
  assertEquals(url.searchParams.get('amount-in-cents'), '5000000');
});
