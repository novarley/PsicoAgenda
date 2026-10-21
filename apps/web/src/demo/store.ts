// Datos ficticios en memoria para VITE_DEMO=true. Deterministas (misma semilla en cada carga)
// y con forma de fila de la BD real, para que las pantallas usen los mismos tipos.
import { addDays, todayKey, zonedToUtc } from '../lib/time';

export type Role = 'admin' | 'professional' | 'receptionist';
export type Row = Record<string, unknown> & { id: string };

// ------------------------------------------------------------- utilidades
let seed = 20261021;
function rand(): number {                       // mulberry32
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
let counter = 0;
export const uid = (prefix = 'id') => `${prefix}-${(++counter).toString(36)}-${Math.floor(rand() * 1e6).toString(36)}`;

const listeners = new Set<() => void>();
export function onDemoChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
export function demoChanged(): void { listeners.forEach((l) => l()); }

// ------------------------------------------------------------- sesión demo
export const demoAuth: { role: Role } = { role: 'admin' };
export const DEMO_USERS: Record<Role, { userId: string; name: string; professionalId: string | null }> = {
  admin: { userId: 'u-admin', name: 'Natalia Gómez', professionalId: null },
  receptionist: { userId: 'u-recep', name: 'Marta Ruiz', professionalId: null },
  professional: { userId: 'u-laura', name: 'Laura Méndez', professionalId: 'pr-1' },
};

// ------------------------------------------------------------- catálogos
const TZ = 'America/Bogota';
export const organization: Row = {
  id: 'demo-org', name: 'Centro de Psicología Demo', country_code: 'CO', timezone: TZ, currency: 'COP',
  wa_phone_number_id: '100000000000001', wa_display_phone: '+57 601 555 0100',
  on_call_phone_e164: '+573001234567', consent_text_version: 'v1',
  crisis_lines: [
    { name: 'Emergencias', phone: '123' },
    { name: 'Línea de salud mental Minsalud (opción 4)', phone: '192' },
    { name: 'Línea 106 (Bogotá)', phone: '106' },
  ],
  settings: { late_cancel_hours: 24, privacy_policy_url: 'https://psicoagenda.demo/privacidad' },
};

const tables: Record<string, Row[]> = {
  sites: [
    { id: 'site-1', org_id: 'demo-org', name: 'Sede Chapinero', address: 'Calle 60 # 9-00', is_virtual: false, active: true },
    { id: 'site-2', org_id: 'demo-org', name: 'Sede Usaquén', address: 'Carrera 7 # 120-20', is_virtual: false, active: true },
    { id: 'site-3', org_id: 'demo-org', name: 'Terapia en línea', address: null, is_virtual: true, active: true },
  ],
  services: [
    { id: 'svc-1', org_id: 'demo-org', name: 'Psicoterapia individual', specialty: 'psychology', duration_minutes: 50, price_cents: 12_000_000, deposit_percent: 50, active: true },
    { id: 'svc-2', org_id: 'demo-org', name: 'Terapia de pareja', specialty: 'psychology', duration_minutes: 60, price_cents: 18_000_000, deposit_percent: 50, active: true },
    { id: 'svc-3', org_id: 'demo-org', name: 'Consulta medicina general', specialty: 'general_medicine', duration_minutes: 20, price_cents: 6_000_000, deposit_percent: 0, active: true },
  ],
  insurers: [
    { id: 'ins-1', org_id: 'demo-org', name: 'EPS Sanitas', code: 'EPS005', kind: 'eps', active: true },
    { id: 'ins-2', org_id: 'demo-org', name: 'Compensar EPS', code: 'EPS008', kind: 'eps', active: true },
    { id: 'ins-3', org_id: 'demo-org', name: 'Colsanitas Prepagada', code: null, kind: 'prepagada', active: true },
    { id: 'ins-4', org_id: 'demo-org', name: 'Convenio Universidad Demo', code: 'CONV-01', kind: 'convenio', active: true },
  ],
  professionals: [
    { id: 'pr-1', org_id: 'demo-org', user_id: 'u-laura', full_name: 'Psic. Laura Méndez', specialty: 'psychology', license_number: 'TP 123456', phone_e164: '+573001110001', active: true },
    { id: 'pr-2', org_id: 'demo-org', user_id: 'u-camilo', full_name: 'Psic. Camilo Torres', specialty: 'psychology', license_number: 'TP 654321', phone_e164: '+573001110002', active: true },
    { id: 'pr-3', org_id: 'demo-org', user_id: null, full_name: 'Dr. Andrés Rojas', specialty: 'general_medicine', license_number: 'RM 789012', phone_e164: null, active: true },
  ],
  availability_rules: [],
  time_off: [],
  patients: [],
  appointments: [],
  bono_plans: [
    { id: 'plan-5', org_id: 'demo-org', service_id: 'svc-1', name: 'Bono 5 sesiones', sessions_total: 5, price_cents: 55_000_000, valid_days: 120, active: true },
    { id: 'plan-10', org_id: 'demo-org', service_id: 'svc-1', name: 'Bono 10 sesiones', sessions_total: 10, price_cents: 100_000_000, valid_days: 240, active: true },
  ],
  bonos: [],
  payments: [],
  patient_documents: [],
};

export const staff: Row[] = [
  { id: 'u-admin', user_id: 'u-admin', full_name: 'Natalia Gómez', email: 'natalia@psicoagenda.demo', roles: ['admin'], professional_id: null },
  { id: 'u-recep', user_id: 'u-recep', full_name: 'Marta Ruiz', email: 'recepcion@psicoagenda.demo', roles: ['receptionist'], professional_id: null },
  { id: 'u-laura', user_id: 'u-laura', full_name: 'Laura Méndez', email: 'laura@psicoagenda.demo', roles: ['professional'], professional_id: 'pr-1' },
  { id: 'u-camilo', user_id: 'u-camilo', full_name: 'Camilo Torres', email: 'camilo@psicoagenda.demo', roles: ['admin', 'professional'], professional_id: 'pr-2' },
];

// Generación PEREZOSA: solo corre si alguien pide datos de demo (nunca en producción).
let generated = false;
export function db(): Record<string, Row[]> {
  if (!generated) { generated = true; generate(); }
  return tables;
}

function generate(): void {
  // Horario semanal (hora de Bogotá)
  for (const [prof, site, days, start, end, slot] of [
    ['pr-1', 'site-1', [1, 2, 3, 4, 5], '08:00', '12:00', 60],
    ['pr-1', 'site-3', [1, 3, 5], '14:00', '18:00', 60],
    ['pr-2', 'site-2', [1, 2, 3, 4], '09:00', '13:00', 60],
    ['pr-2', 'site-1', [2, 4], '15:00', '19:00', 60],
    ['pr-3', 'site-1', [1, 2, 3, 4, 5], '07:00', '11:00', 20],
  ] as const) {
    for (const weekday of days) {
      tables.availability_rules.push({
        id: uid('rule'), org_id: 'demo-org', professional_id: prof, site_id: site, weekday,
        start_time: start, end_time: end, slot_minutes: slot, valid_from: null, valid_until: null,
      });
    }
  }

  // ------------------------------------------------------------- pacientes
  const NAMES = ['Ana Gómez', 'Luis Pérez', 'María José Restrepo', 'Carlos Ramírez', 'Valentina Ortiz', 'Andrés Castro',
    'Juliana Herrera', 'Santiago Vargas', 'Daniela Morales', 'Felipe Rojas', 'Camila Jiménez', 'Sebastián Díaz',
    'Laura Sánchez', 'Mateo Romero', 'Isabella Torres', 'Nicolás Gutiérrez', 'Sofía Aguilar', 'Juan Pablo Ríos',
    'Mariana López', 'Alejandro Navarro', 'Paula Medina', 'Diego Suárez', 'Natalia Cárdenas', 'Tomás Mejía'];
  NAMES.forEach((name, i) => {
    tables.patients.push({
      id: `pat-${i + 1}`, org_id: 'demo-org', doc_type: i % 9 === 8 ? 'CE' : 'CC',
      doc_number: String(1_010_000_000 + i * 7_919), full_name: name,
      birth_date: `${1975 + (i * 3) % 30}-${String(1 + (i * 5) % 12).padStart(2, '0')}-${String(1 + (i * 7) % 28).padStart(2, '0')}`,
      sex: i % 2 ? 'M' : 'F', phone_e164: `+57300${String(1_000_000 + i * 31_337).slice(0, 7)}`,
      email: `${name.split(' ')[0].toLowerCase()}@correo.demo`, address: null,
      insurer_id: i % 4 === 3 ? null : `ins-${(i % 3) + 1}`,
      emergency_contact: i % 3 === 0 ? { name: 'Contacto de emergencia', phone: '+573009990000' } : null,
      data_consent_at: i % 6 === 5 ? null : '2026-06-01T15:00:00.000Z', data_consent_version: 'v1',
      whatsapp_opt_in: i % 6 !== 5, last_professional_id: null, created_at: '2026-06-01T15:00:00.000Z',
    });
  });

  // ------------------------------------------------------------- citas
  // Ausentismo que baja con los recordatorios: ~28 % hace 4 meses → ~4 % este mes
  const today = todayKey(TZ);
  const services = tables.services;
  const profSpecialty: Record<string, string> = { 'pr-1': 'psychology', 'pr-2': 'psychology', 'pr-3': 'general_medicine' };
  for (let offset = -120; offset <= 14; offset++) {
    const day = addDays(today, offset);
    const weekday = ((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
    const noShowRate = offset < 0 ? Math.max(0.03, 0.28 + (offset + 120) * -0.0033) : 0;
    for (const rule of tables.availability_rules.filter((r) => r.weekday === weekday)) {
      const [sh, sm] = String(rule.start_time).split(':').map(Number);
      const [eh, em] = String(rule.end_time).split(':').map(Number);
      const step = Number(rule.slot_minutes);
      for (let t = sh * 60 + sm; t + step <= eh * 60 + em; t += step) {
        const fill = offset < 0 ? 0.74 : offset <= 7 ? 0.62 : 0.3;
        if (rand() > fill) continue;
        const service = services.find((s) => s.specialty === profSpecialty[String(rule.professional_id)] && (rand() > 0.2 || s.id !== 'svc-2'))!;
        const startsAt = zonedToUtc(day, `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`, TZ);
        const endsAt = new Date(new Date(startsAt).getTime() + Number(service.duration_minutes) * 60_000).toISOString();
        const roll = rand();
        let status: string;
        if (offset < 0) status = roll < noShowRate ? 'no_show' : roll < noShowRate + 0.08 ? 'cancelled' : 'completed';
        else if (offset === 0) status = roll < 0.75 ? 'confirmed' : 'scheduled';
        else status = offset <= 2 ? (roll < 0.55 ? 'confirmed' : roll < 0.9 ? 'scheduled' : 'pending_payment') : (roll < 0.92 ? 'scheduled' : 'pending_payment');
        const patient = tables.patients[Math.floor(rand() * tables.patients.length)];
        const appt: Row = {
          id: uid('appt'), org_id: 'demo-org', patient_id: patient.id, professional_id: rule.professional_id,
          site_id: rule.site_id, service_id: service.id, insurer_id: patient.insurer_id, bono_id: null,
          starts_at: startsAt, ends_at: endsAt, modality: rule.site_id === 'site-3' ? 'online' : 'in_person',
          status, channel: rand() < 0.78 ? 'whatsapp' : 'dashboard',
          hold_expires_at: status === 'pending_payment' ? new Date(Date.now() + 25 * 60_000).toISOString() : null,
        };
        tables.appointments.push(appt);
        patient.last_professional_id = rule.professional_id;
        if (status === 'completed') {
          tables.payments.push({
            id: uid('pay'), org_id: 'demo-org', patient_id: patient.id, appointment_id: appt.id,
            provider: rand() < 0.6 ? 'wompi' : 'cash', kind: 'full', status: 'approved',
            amount_cents: service.price_cents, currency: 'COP', paid_at: startsAt, created_at: startsAt,
          });
        }
      }
    }
  }

  // Algunos bonos
  for (const [i, plan, used] of [[0, 'plan-5', 3], [4, 'plan-10', 6], [9, 'plan-5', 5]] as const) {
    const p = tables.bono_plans.find((b) => b.id === plan)!;
    tables.bonos.push({
      id: uid('bono'), org_id: 'demo-org', plan_id: plan, plan_name: p.name, patient_id: tables.patients[i].id,
      sessions_total: p.sessions_total, sessions_used: used, status: used >= Number(p.sessions_total) ? 'exhausted' : 'active',
      purchased_at: '2026-08-15T15:00:00.000Z', expires_at: '2026-12-15T05:00:00.000Z',
    });
  }
  tables.patient_documents.push(
    { id: uid('doc'), org_id: 'demo-org', patient_id: 'pat-1', kind: 'referral', storage_path: 'demo-org/pat-1/remision-eps.pdf', created_at: '2026-09-02T15:00:00.000Z' },
    { id: uid('doc'), org_id: 'demo-org', patient_id: 'pat-1', kind: 'consent', storage_path: 'demo-org/pat-1/consentimiento-firmado.pdf', created_at: '2026-09-02T15:05:00.000Z' },
  );
}

/** Citas que ve el rol actual en la demo (en producción lo decide RLS). */
export function visibleAppointments(): Row[] {
  const me = DEMO_USERS[demoAuth.role];
  return demoAuth.role === 'professional'
    ? db().appointments.filter((a) => a.professional_id === me.professionalId)
    : db().appointments;
}

export function visiblePatients(): Row[] {
  if (demoAuth.role !== 'professional') return db().patients;
  const mine = new Set(visibleAppointments().map((a) => a.patient_id));
  return db().patients.filter((p) => mine.has(p.id));
}

export const demoTimezone = TZ;
