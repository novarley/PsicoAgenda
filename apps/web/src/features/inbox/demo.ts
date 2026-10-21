// Datos de ejemplo en memoria para VITE_DEMO=true. Todo es ficticio.
import type { InboxApi, InboxItem, ThreadMessage } from './api';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const conversations: InboxItem[] = [
  {
    id: 'demo-1', wa_id: '573001112233', patient_name: 'Ana Gómez', state: 'ask_insurer',
    human_handoff: true, handoff_reason: 'crisis', crisis_flag: true, window_open: true, open_crisis: true,
    last_body: null, last_direction: null, last_at: minutesAgo(2),
  },
  {
    id: 'demo-2', wa_id: '573104445566', patient_name: 'Luis Pérez', state: 'done',
    human_handoff: true, handoff_reason: 'user_request', crisis_flag: false, window_open: true, open_crisis: false,
    last_body: null, last_direction: null, last_at: minutesAgo(14),
  },
  {
    id: 'demo-3', wa_id: '573207778899', patient_name: null, state: 'ask_day',
    human_handoff: false, handoff_reason: null, crisis_flag: false, window_open: true, open_crisis: false,
    last_body: null, last_direction: null, last_at: minutesAgo(40),
  },
  {
    id: 'demo-4', wa_id: '573150001122', patient_name: 'María José Restrepo', state: 'done',
    human_handoff: false, handoff_reason: null, crisis_flag: false, window_open: false, open_crisis: false,
    last_body: null, last_direction: null, last_at: minutesAgo(60 * 30),
  },
];

const msg = (direction: 'in' | 'out', body: string, at: string, sent_by: string | null = null, status?: string): ThreadMessage =>
  ({ message_id: crypto.randomUUID(), direction, body, at, sent_by, status: status ?? (direction === 'in' ? 'received' : 'read') });

const threads: Record<string, ThreadMessage[]> = {
  'demo-1': [
    msg('in', 'Hola, quiero pedir una cita', minutesAgo(9)),
    msg('out', 'Hola, soy el asistente virtual de Centro de Psicología Demo. Para agendar tu cita necesito tu autorización para tratar tus datos personales y de salud.\n\n¿Nos autorizas?', minutesAgo(9)),
    msg('in', 'Sí, autorizo', minutesAgo(8)),
    msg('out', 'Hola, Ana.', minutesAgo(7)),
    msg('out', '¿Con qué EPS, prepagada o convenio vas a atenderte?', minutesAgo(7)),
    msg('in', 'la verdad no sé si vale la pena, ya no quiero vivir', minutesAgo(3)),
    msg('out', 'Gracias por contármelo. Lo que sientes importa y no tienes que pasar por esto sin compañía.\n\nSi estás en peligro ahora mismo, llama de inmediato:\n• Emergencias: 123\n• Línea de salud mental Minsalud (opción 4): 192\n• Línea 106 (Bogotá): 106\n\nYa avisé a una persona de nuestro equipo clínico para que te contacte lo antes posible.', minutesAgo(2)),
  ],
  'demo-2': [
    msg('out', 'Plantilla: recordatorio_cita_48h', minutesAgo(60 * 20), null, 'read'),
    msg('in', 'Confirmar', minutesAgo(60 * 19)),
    msg('out', '¡Gracias! Tu cita del jueves, 23 de octubre · 09:00 está confirmada. Te esperamos.', minutesAgo(60 * 19)),
    msg('in', 'Hola, necesito la factura de la sesión pasada para mi empresa. ¿Me pueden ayudar con una persona?', minutesAgo(15)),
    msg('out', 'Te comunico con una persona de nuestro equipo. Te responderá en este mismo chat en horario de atención.', minutesAgo(14)),
  ],
  'demo-3': [
    msg('in', 'Buenas tardes', minutesAgo(45)),
    msg('out', 'Hola, soy el asistente virtual de Centro de Psicología Demo…', minutesAgo(45)),
    msg('in', 'Sí, autorizo', minutesAgo(43)),
    msg('in', 'Psic. Laura Méndez', minutesAgo(41)),
    msg('out', 'Elige el día de tu cita:', minutesAgo(40)),
  ],
  'demo-4': [
    msg('in', 'Confirmar', minutesAgo(60 * 31)),
    msg('out', '¡Gracias! Tu cita del miércoles, 22 de octubre · 15:00 está confirmada. Te esperamos.', minutesAgo(60 * 30)),
  ],
};

const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

function withLast(c: InboxItem): InboxItem {
  const last = threads[c.id]?.at(-1);
  return { ...c, last_body: last?.body ?? null, last_direction: last?.direction ?? null, last_at: last?.at ?? c.last_at };
}

export const demoInboxApi: InboxApi = {
  async list() { return conversations.map(withLast); },
  async thread(id) { return [...(threads[id] ?? [])]; },
  async send(id, text) {
    const c = conversations.find((x) => x.id === id);
    if (!c) return { ok: false, code: 'NOT_FOUND', error: 'Conversación no encontrada.' };
    if (!c.window_open) return { ok: false, code: 'OUTSIDE_WINDOW', error: 'Pasaron más de 24 h: solo se puede enviar una plantilla.' };
    c.human_handoff = true;
    threads[id].push(msg('out', text.trim(), new Date().toISOString(), 'demo-user', 'sent'));
    changed();
    return { ok: true };
  },
  async setHandoff(id, value) {
    const c = conversations.find((x) => x.id === id);
    if (c) { c.human_handoff = value; c.handoff_reason = value ? 'staff_takeover' : null; }
    changed();
  },
  async ackCrisis(id) {
    const c = conversations.find((x) => x.id === id);
    if (c) c.open_crisis = false;
    changed();
  },
  subscribe(onChange) {
    listeners.add(onChange);
    return () => { listeners.delete(onChange); };
  },
};
