// Motor conversacional: máquina de estados finitos PURA.
//
// handleTurn(estado actual, mensaje) → (estado nuevo, mensajes a enviar).
// No toca la BD ni la red directamente: todo pasa por BotPorts. El estado se
// persiste fuera (tabla conversations), así un reintento del webhook o un salto
// entre instancias de la función no pierde el contexto.

import {
  buttonsMessage, type Choice, choiceMessage, listMessage, type OutboundContent,
  parseReplyId, replyId, textMessage,
} from '../whatsapp/schema.ts';
import type { UserInput } from '../whatsapp/inbound.ts';
import { crisisLinesFor, crisisReply, detectCrisis, normalizeForMatching } from './crisis.ts';
import { formatDateTimeLong, formatDayShort, formatTime, localDateKey } from '../time.ts';
import type {
  BotContext, BotPorts, BotState, ConversationSnapshot, OrgConfig, PatientSummary,
  ReminderAction, TurnResult,
} from './types.ts';

export interface EngineDeps {
  org: OrgConfig;
  ports: BotPorts;
  waId: string;
  now: Date;
}

interface Step {
  state: BotState;
  context: BotContext;
  patientId: string | null;
  messages: OutboundContent[];
  handoff?: TurnResult['handoff'];
}

const MAX_INVALID_ATTEMPTS = 3;
const SEARCH_DAYS = 14;

const DOC_TYPES: Record<string, Choice[]> = {
  CO: [
    { id: 'CC', title: 'Cédula de ciudadanía' },
    { id: 'TI', title: 'Tarjeta de identidad' },
    { id: 'CE', title: 'Cédula de extranjería' },
    { id: 'PA', title: 'Pasaporte' },
    { id: 'PPT', title: 'Permiso PPT' },
    { id: 'RC', title: 'Registro civil' },
  ],
  ES: [
    { id: 'DNI', title: 'DNI' },
    { id: 'NIE', title: 'NIE' },
    { id: 'PAS', title: 'Pasaporte' },
  ],
};
const docTypesFor = (country: string) => DOC_TYPES[country] ?? DOC_TYPES.CO;

// =============================================================================
export async function handleTurn(
  convo: ConversationSnapshot, input: UserInput, deps: EngineDeps,
): Promise<TurnResult> {
  // 0. Crisis: SIEMPRE primero, en cualquier paso, incluso con un humano a cargo.
  if (input.kind === 'text') {
    const crisis = detectCrisis(input.text);
    if (crisis) {
      const lines = crisisLinesFor(deps.org.countryCode, deps.org.crisisLines);
      return {
        state: convo.state, context: convo.context, patientId: convo.patientId,
        messages: [textMessage(crisisReply(crisis.severity, lines))],
        handoff: { reason: 'crisis' },
        crisis,
      };
    }
  }

  // 1. Con un humano a cargo, el bot no interfiere (la recepción responde desde el panel).
  if (convo.humanHandoff) {
    return { state: convo.state, context: convo.context, patientId: convo.patientId, messages: [] };
  }

  const s: Step = { state: convo.state, context: { ...convo.context }, patientId: convo.patientId, messages: [] };

  // 2. Botones de los recordatorios (plantillas): válidos desde cualquier paso.
  if (input.kind === 'reply') {
    const m = /^appt:(confirm|cancel|reschedule):([0-9a-f-]{36})$/.exec(input.id);
    if (m) return done(await handleReminder(s, m[1] as ReminderAction, m[2], deps));
  }

  // 3. Palabras clave globales.
  if (input.kind === 'text') {
    const t = normalizeForMatching(input.text);
    if (/^(menu|inicio|reiniciar|empezar|volver|hola)$/.test(t)) return done(await restart(s, deps));
    if (/\b(asesor|asesora|humano|una persona|recepcion|hablar con alguien|operador)\b/.test(t)) {
      return done(handoff(s, 'user_request'));
    }
  }

  // 4. Paso actual de la máquina de estados.
  return done(await receive(s, input, deps));
}

function done(s: Step): TurnResult {
  return {
    state: s.state, context: s.context, patientId: s.patientId,
    messages: s.messages, ...(s.handoff ? { handoff: s.handoff } : {}),
  };
}

// =============================================================================
// receive: interpreta la respuesta al paso actual
// =============================================================================
async function receive(s: Step, input: UserInput, deps: EngineDeps): Promise<Step> {
  const { ports, org } = deps;
  const choice = readChoice(s.state, input);
  if (choice.stale) {
    s.messages.push(textMessage('Esa opción era de un paso anterior. Sigamos desde aquí:'));
    return enter(s, s.state, deps);
  }
  const text = input.kind === 'text' ? input.text.trim() : '';

  switch (s.state) {
    case 'start':
    case 'closed':
      return restart(s, deps);

    case 'consent': {
      const t = normalizeForMatching(text);
      if (choice.value === 'yes' || /^(si|acepto|autorizo|si autorizo)$/.test(t)) {
        s.context.consentAt = deps.now.toISOString();
        return enter(s, 'ask_doc_type', deps);
      }
      if (choice.value === 'no' || /^(no|no acepto|no autorizo)$/.test(t)) return enter(s, 'closed', deps);
      return invalid(s, deps);
    }

    case 'ask_doc_type': {
      const types = docTypesFor(org.countryCode).map((d) => d.id);
      const value = choice.value ?? text.toUpperCase();
      if (!types.includes(value)) return invalid(s, deps);
      s.context.docType = value;
      return enter(s, 'ask_doc_number', deps);
    }

    case 'ask_doc_number': {
      const docNumber = text.replace(/[\s.\-]/g, '').toUpperCase();
      if (!/^[A-Z0-9]{3,20}$/.test(docNumber) || !s.context.docType) return invalid(s, deps);
      s.context.docNumber = docNumber;
      const patient = await ports.findPatientByDocument(s.context.docType, docNumber);
      if (!patient) return enter(s, 'ask_full_name', deps);
      if (phonesMatch(patient.phoneE164, deps.waId)) return identified(s, patient, deps);
      // El documento existe pero no con este WhatsApp: no revelamos nada y pedimos 2º factor.
      if (patient.birthDate) return enter(s, 'verify_birth_date', deps);
      return handoff(s, 'identity_verification');
    }

    case 'verify_birth_date': {
      const birthDate = parseBirthDate(text);
      const patient = s.context.docType && s.context.docNumber
        ? await ports.findPatientByDocument(s.context.docType, s.context.docNumber)
        : null;
      if (birthDate && patient?.birthDate === birthDate) return identified(s, patient, deps);
      s.context.birthDateAttempts = (s.context.birthDateAttempts ?? 0) + 1;
      if (s.context.birthDateAttempts >= 2) return handoff(s, 'identity_verification');
      s.messages.push(textMessage('Los datos no coinciden. Inténtalo de nuevo con el formato DD/MM/AAAA.'));
      return s;
    }

    case 'ask_full_name': {
      const fullName = text.replace(/\s+/g, ' ');
      if (!/^[\p{L}' -]{5,120}$/u.test(fullName) || fullName.split(' ').length < 2) return invalid(s, deps);
      const patient = await ports.createPatient({
        docType: s.context.docType!, docNumber: s.context.docNumber!, fullName, phoneE164: `+${deps.waId}`,
      });
      return identified(s, patient, deps);
    }

    case 'ask_insurer': {
      if (choice.value === 'none') {
        s.context.insurerId = null;
        return enter(s, 'ask_service', deps);
      }
      const insurer = (await ports.listInsurers()).find((i) => i.id === choice.value);
      if (!insurer) return invalid(s, deps);
      s.context.insurerId = insurer.id;
      return enter(s, 'ask_service', deps);
    }

    case 'ask_service': {
      const service = (await ports.listServices()).find((o) => o.id === choice.value);
      if (!service) return invalid(s, deps);
      s.context.serviceId = service.id;
      s.context.serviceName = service.name;
      return enter(s, 'ask_site', deps);
    }

    case 'ask_site': {
      const site = (await ports.listSites()).find((o) => o.id === choice.value);
      if (!site) return invalid(s, deps);
      selectSite(s, site);
      return enter(s, 'ask_professional', deps);
    }

    case 'ask_professional': {
      const prof = (await ports.listProfessionals(s.context.serviceId!)).find((o) => o.id === choice.value);
      if (!prof) return invalid(s, deps);
      s.context.professionalId = prof.id;
      s.context.professionalName = prof.name;
      return enter(s, 'ask_day', deps);
    }

    case 'ask_day': {
      if (choice.value === 'other') {
        delete s.context.professionalId;
        return enter(s, 'ask_professional', deps);
      }
      if (choice.value === 'human') return handoff(s, 'user_request');
      if (!choice.value || !/^\d{4}-\d{2}-\d{2}$/.test(choice.value)) return invalid(s, deps);
      s.context.day = choice.value;
      return enter(s, 'ask_time', deps);
    }

    case 'ask_time': {
      const slots = await slotsForDay(s, deps);
      const slot = slots.find((x) => x.startsAt === choice.value);
      if (!slot) {
        if (!choice.value) return invalid(s, deps);
        s.messages.push(textMessage('Ese horario ya no está disponible.'));
        return enter(s, 'ask_time', deps);
      }
      s.context.startsAt = slot.startsAt;
      return enter(s, 'confirm', deps);
    }

    case 'confirm': {
      if (choice.value === 'change') return enter(s, 'ask_day', deps);
      if (choice.value === 'cancel') {
        s.messages.push(textMessage('De acuerdo, no agendé ninguna cita. Escribe *inicio* cuando quieras.'));
        return toDone(s);
      }
      if (choice.value !== 'yes') return invalid(s, deps);
      return book(s, deps);
    }

    case 'done': {
      if (choice.value === 'book') return restart(s, deps);
      if (choice.value === 'human') return handoff(s, 'user_request');
      return enter(s, 'done', deps);
    }
  }
}

// =============================================================================
// enter: emite la pregunta del paso (y se salta pasos con una sola opción)
// =============================================================================
async function enter(s: Step, state: BotState, deps: EngineDeps): Promise<Step> {
  const { ports, org } = deps;
  s.state = state;
  s.context.invalidAttempts = 0;

  switch (state) {
    case 'start':
      return restart(s, deps);

    case 'consent': {
      const policy = org.privacyPolicyUrl ? ` Política de privacidad: ${org.privacyPolicyUrl}` : '';
      s.messages.push(buttonsMessage(
        `Hola, soy el asistente virtual de ${org.name}. Para agendar tu cita necesito tu autorización ` +
          'para tratar tus datos personales y de salud. Solo los usamos para gestionar tu atención ' +
          `y no los compartimos sin tu permiso.${policy}\n\n¿Nos autorizas?`,
        [{ id: replyId('consent', 'yes'), title: 'Sí, autorizo' }, { id: replyId('consent', 'no'), title: 'No autorizo' }],
      ));
      return s;
    }

    case 'closed':
      s.messages.push(textMessage(
        'Entendido. Sin tu autorización no puedo gestionar citas por este medio. ' +
          'Si cambias de opinión, escribe *inicio*.',
      ));
      return s;

    case 'ask_doc_type':
      s.messages.push(listMessage(
        '¿Qué tipo de documento de identidad tienes?', 'Ver opciones',
        docTypesFor(org.countryCode).map((d) => ({ id: replyId(state, d.id), title: d.title })),
      ));
      return s;

    case 'ask_doc_number':
      s.messages.push(textMessage('Escribe tu número de documento, sin puntos ni espacios.'));
      return s;

    case 'verify_birth_date':
      s.messages.push(textMessage('Por seguridad, confirma tu fecha de nacimiento (DD/MM/AAAA).'));
      return s;

    case 'ask_full_name':
      s.messages.push(textMessage('No encontré tu registro; te inscribo en un momento. ¿Cuál es tu nombre completo?'));
      return s;

    case 'ask_insurer': {
      const insurers = await ports.listInsurers();
      const choices: Choice[] = insurers.slice(0, 9).map((i) => ({ id: replyId(state, i.id), title: i.name }));
      choices.push({ id: replyId(state, 'none'), title: 'Particular' });
      s.messages.push(choiceMessage('¿Con qué EPS, prepagada o convenio vas a atenderte?', 'Ver opciones', choices));
      return s;
    }

    case 'ask_service': {
      const services = await ports.listServices();
      if (services.length === 0) return handoff(s, 'stuck');
      if (services.length === 1) {
        s.context.serviceId = services[0].id;
        s.context.serviceName = services[0].name;
        return enter(s, 'ask_site', deps);
      }
      s.messages.push(choiceMessage('¿Qué tipo de consulta necesitas?', 'Ver servicios',
        services.map((o) => ({ id: replyId(state, o.id), title: o.name, description: o.description }))));
      return s;
    }

    case 'ask_site': {
      const sites = await ports.listSites();
      if (sites.length === 0) return handoff(s, 'stuck');
      if (sites.length === 1) {
        selectSite(s, sites[0]);
        return enter(s, 'ask_professional', deps);
      }
      s.messages.push(choiceMessage('¿Dónde prefieres tu cita?', 'Ver sedes', sites.map((o) => ({
        id: replyId(state, o.id), title: o.name, description: o.isVirtual ? 'Terapia en línea' : o.description,
      }))));
      return s;
    }

    case 'ask_professional': {
      const profs = await ports.listProfessionals(s.context.serviceId!);
      if (profs.length === 0) return handoff(s, 'stuck');
      // Continuidad terapéutica: el último profesional que atendió al paciente va primero.
      const lastId = s.patientId ? await ports.getLastProfessionalId(s.patientId) : null;
      const ordered = [...profs].sort((a, b) => Number(b.id === lastId) - Number(a.id === lastId));
      if (ordered.length === 1) {
        s.context.professionalId = ordered[0].id;
        s.context.professionalName = ordered[0].name;
        return enter(s, 'ask_day', deps);
      }
      s.messages.push(listMessage('¿Con qué profesional quieres tu cita?', 'Ver profesionales', ordered.map((p) => ({
        id: replyId(state, p.id), title: p.name,
        description: p.id === lastId ? 'Tu profesional habitual' : p.description,
      }))));
      return s;
    }

    case 'ask_day': {
      const today = localDateKey(deps.now, org.timezone);
      const slots = await ports.availableSlots(s.context.professionalId!, s.context.siteId!, today, SEARCH_DAYS);
      const byDay = new Map<string, number>();
      for (const slot of slots) {
        const key = localDateKey(slot.startsAt, org.timezone);
        byDay.set(key, (byDay.get(key) ?? 0) + 1);
      }
      if (byDay.size === 0) {
        s.messages.push(buttonsMessage(
          `${s.context.professionalName ?? 'Este profesional'} no tiene horarios libres en los próximos ${SEARCH_DAYS} días.`,
          [{ id: replyId(state, 'other'), title: 'Otro profesional' }, { id: replyId(state, 'human'), title: 'Hablar con alguien' }],
        ));
        return s;
      }
      s.messages.push(listMessage('Elige el día de tu cita:', 'Ver días', [...byDay].slice(0, 10).map(([key, n]) => ({
        id: replyId(state, key), title: formatDayShort(key),
        description: n === 1 ? '1 horario disponible' : `${n} horarios disponibles`,
      }))));
      return s;
    }

    case 'ask_time': {
      const slots = await slotsForDay(s, deps);
      if (slots.length === 0) {
        s.messages.push(textMessage('Ese día ya no tiene horarios libres.'));
        return enter(s, 'ask_day', deps);
      }
      s.messages.push(listMessage(`Horarios para el ${formatDayShort(s.context.day!)}:`, 'Ver horarios',
        slots.slice(0, 10).map((x) => ({ id: replyId(state, x.startsAt), title: formatTime(x.startsAt, org.timezone) }))));
      return s;
    }

    case 'confirm': {
      const where = s.context.modality === 'online' ? 'En línea (te enviaremos el enlace)' : s.context.siteName;
      s.messages.push(buttonsMessage(
        [
          'Revisa tu cita:',
          `• Profesional: ${s.context.professionalName}`,
          `• Servicio: ${s.context.serviceName}`,
          `• Lugar: ${where}`,
          `• Fecha: ${formatDateTimeLong(s.context.startsAt!, org.timezone)}`,
          '',
          '¿La confirmo?',
        ].join('\n'),
        [
          { id: replyId(state, 'yes'), title: 'Confirmar' },
          { id: replyId(state, 'change'), title: 'Cambiar horario' },
          { id: replyId(state, 'cancel'), title: 'No, gracias' },
        ],
      ));
      return s;
    }

    case 'done':
      s.messages.push(buttonsMessage('¿Te ayudo con algo más?', [
        { id: replyId(state, 'book'), title: 'Agendar otra cita' },
        { id: replyId(state, 'human'), title: 'Hablar con alguien' },
      ]));
      return s;
  }
}

// =============================================================================
// Acciones
// =============================================================================
async function book(s: Step, deps: EngineDeps): Promise<Step> {
  const { ports, org } = deps;
  const c = s.context;
  const outcome = await ports.book({
    patientId: s.patientId!, professionalId: c.professionalId!, siteId: c.siteId!, serviceId: c.serviceId!,
    insurerId: c.insurerId ?? null, startsAt: c.startsAt!, modality: c.modality ?? 'in_person',
  });

  if (!outcome.ok) {
    if (outcome.reason === 'SLOT_NOT_AVAILABLE') {
      s.messages.push(textMessage('Alguien acaba de tomar ese horario. Elige otro, por favor.'));
      return enter(s, 'ask_time', deps);
    }
    return handoff(s, 'stuck');
  }

  const lines = [`✅ Tu cita quedó reservada para el ${formatDateTimeLong(outcome.startsAt, org.timezone)} con ${c.professionalName}.`];
  if (outcome.status === 'pending_payment') {
    const link = await ports.paymentLink(outcome, s.patientId!);
    const amount = formatMoney(outcome.depositCents, outcome.currency);
    lines.push(link
      ? `Para confirmarla, paga el anticipo de ${amount} aquí:\n${link}\nTe guardamos el horario durante 30 minutos.`
      : `Para confirmarla falta el anticipo de ${amount}; recepción te escribirá para el pago.`);
  }
  if (outcome.bonoSessionsRemaining !== null) {
    lines.push(`Usamos una sesión de tu bono. Te quedan ${outcome.bonoSessionsRemaining}.`);
  }
  lines.push('Te enviaremos un recordatorio 48 horas y 2 horas antes.');
  s.messages.push(textMessage(lines.join('\n\n')));
  return toDone(s);
}

async function handleReminder(s: Step, action: ReminderAction, appointmentId: string, deps: EngineDeps): Promise<Step> {
  const result = await deps.ports.applyReminderAction(appointmentId, action, deps.waId);
  if (!result.ok || !result.appointment) {
    s.messages.push(textMessage('No encontré esa cita o ya no se puede modificar. Escribe *inicio* para agendar una nueva.'));
    return s;
  }
  const a = result.appointment;
  const when = formatDateTimeLong(a.startsAt, deps.org.timezone);
  if (action === 'confirm') {
    s.messages.push(textMessage(`¡Gracias! Tu cita del ${when} está confirmada. Te esperamos.`));
    return toDone(s);
  }
  if (action === 'cancel') {
    s.messages.push(textMessage(`Tu cita del ${when} quedó cancelada. Si quieres agendar otra, escribe *inicio*.`));
    return toDone(s);
  }
  // Reagendar: la cita original ya se liberó; reanudamos el flujo en "elegir día"
  s.patientId = a.patientId;
  s.context = {
    consentAt: s.context.consentAt ?? 'on_file',
    serviceId: a.serviceId, serviceName: a.serviceName,
    siteId: a.siteId, siteName: a.siteName, modality: a.modality,
    professionalId: a.professionalId, professionalName: a.professionalName,
    rescheduleOf: appointmentId,
  };
  s.messages.push(textMessage('Liberé tu horario anterior. Elige uno nuevo:'));
  return enter(s, 'ask_day', deps);
}

async function restart(s: Step, deps: EngineDeps): Promise<Step> {
  const consentAt = s.context.consentAt;
  s.context = consentAt ? { consentAt } : {};
  if (!consentAt) return enter(s, 'consent', deps);
  if (s.patientId) return enter(s, 'ask_insurer', deps);
  return enter(s, 'ask_doc_type', deps);
}

async function identified(s: Step, patient: PatientSummary, deps: EngineDeps): Promise<Step> {
  s.patientId = patient.id;
  await deps.ports.saveConsent(patient.id, s.context.consentAt ?? deps.now.toISOString(), deps.org.consentVersion);
  delete s.context.docNumber;          // minimización: no guardamos el documento en el contexto
  delete s.context.birthDateAttempts;
  s.messages.push(textMessage(`Hola, ${patient.fullName.split(' ')[0]}.`));
  return enter(s, 'ask_insurer', deps);
}

function handoff(s: Step, reason: NonNullable<TurnResult['handoff']>['reason']): Step {
  const text: Record<typeof reason, string> = {
    user_request: 'Te comunico con una persona de nuestro equipo. Te responderá en este mismo chat en horario de atención.',
    identity_verification: 'Necesito verificar tu identidad con una persona del equipo. Te escribirán en este chat en horario de atención.',
    stuck: 'Voy a pasarle tu conversación a una persona del equipo para ayudarte mejor. Te escribirán en este chat.',
    crisis: '',
  };
  s.messages.push(textMessage(text[reason]));
  s.handoff = { reason };
  return s;
}

function invalid(s: Step, deps: EngineDeps): Promise<Step> | Step {
  const attempts = (s.context.invalidAttempts ?? 0) + 1;
  if (attempts >= MAX_INVALID_ATTEMPTS) return handoff(s, 'stuck');
  s.messages.push(textMessage('No logré entender tu respuesta. Usa las opciones del mensaje, por favor.'));
  return enter(s, s.state, deps).then((next) => {
    next.context.invalidAttempts = attempts;
    return next;
  });
}

function toDone(s: Step): Step {
  const { consentAt } = s.context;
  s.context = consentAt ? { consentAt } : {};
  s.state = 'done';
  return s;
}

// =============================================================================
// Utilidades
// =============================================================================
function readChoice(state: BotState, input: UserInput): { value?: string; stale?: boolean } {
  if (input.kind !== 'reply') return {};
  const parsed = parseReplyId(input.id);
  if (!parsed) return {};
  if (parsed.step !== state) return { stale: true };
  return { value: parsed.value };
}

function selectSite(s: Step, site: { id: string; name: string; isVirtual: boolean }) {
  s.context.siteId = site.id;
  s.context.siteName = site.name;
  s.context.modality = site.isVirtual ? 'online' : 'in_person';
}

async function slotsForDay(s: Step, deps: EngineDeps) {
  const { day, professionalId, siteId } = s.context;
  if (!day || !professionalId || !siteId) return [];
  const slots = await deps.ports.availableSlots(professionalId, siteId, day, 1);
  return slots.filter((x) => localDateKey(x.startsAt, deps.org.timezone) === day);
}

export function phonesMatch(e164: string | null, waId: string): boolean {
  if (!e164) return false;
  const a = e164.replace(/\D/g, '');
  const b = waId.replace(/\D/g, '');
  return a === b || (a.length >= 10 && b.length >= 10 && a.slice(-10) === b.slice(-10));
}

/** "05/03/1990" | "5-3-1990" → "1990-03-05" */
export function parseBirthDate(text: string): string | null {
  const m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(text.trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(cents / 100);
}
