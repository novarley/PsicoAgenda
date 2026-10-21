// Métricas del dashboard (solo administración por RLS / función org_occupancy).
import { isDemo, supabase } from '../../lib/supabase';
import { db, demoTimezone } from '../../demo/store';
import { addDays, localDateKey } from '../../lib/time';

export interface Occupancy {
  professional_id: string;
  full_name: string;
  available_minutes: number;
  booked_minutes: number;
  attended: number;
  no_shows: number;
  cancelled: number;
  occupancy_pct: number | null;
}
export interface MonthAttendance { month: string; booked: number; attended: number; no_shows: number; cancelled: number }
export interface MonthRevenue { month: string; total_cents: number; payments: number }

export interface MetricsApi {
  occupancy(orgId: string, fromKey: string, toKey: string): Promise<Occupancy[]>;
  attendance(orgId: string, sinceMonth: string): Promise<MonthAttendance[]>;
  revenue(orgId: string, sinceMonth: string): Promise<MonthRevenue[]>;
}

function sumBy<T extends { month: string }>(rows: T[], keys: (keyof T)[]): T[] {
  const out = new Map<string, T>();
  for (const r of rows) {
    const cur = out.get(r.month) ?? ({ month: r.month, ...Object.fromEntries(keys.map((k) => [k, 0])) } as T);
    for (const k of keys) (cur[k] as number) += Number(r[k] ?? 0);
    out.set(r.month, cur);
  }
  return [...out.values()].sort((a, b) => a.month.localeCompare(b.month));
}

const supabaseMetrics: MetricsApi = {
  async occupancy(orgId, fromKey, toKey) {
    const { data, error } = await supabase.rpc('org_occupancy', { p_org: orgId, p_from: fromKey, p_to: toKey });
    if (error) throw error;
    return data as Occupancy[];
  },
  async attendance(orgId, sinceMonth) {
    const { data, error } = await supabase.from('v_attendance_monthly')
      .select('month, booked, attended, no_shows, cancelled').eq('org_id', orgId).gte('month', `${sinceMonth}-01`);
    if (error) throw error;
    return sumBy((data as MonthAttendance[]).map((r) => ({ ...r, month: r.month.slice(0, 7) })), ['booked', 'attended', 'no_shows', 'cancelled']);
  },
  async revenue(orgId, sinceMonth) {
    const { data, error } = await supabase.from('v_revenue_monthly')
      .select('month, total_cents, payments').eq('org_id', orgId).gte('month', `${sinceMonth}-01`);
    if (error) throw error;
    return sumBy((data as MonthRevenue[]).map((r) => ({ ...r, month: r.month.slice(0, 7) })), ['total_cents', 'payments']);
  },
};

// ----------------------------------------------------------------------- demo
const ACTIVE = ['pending_payment', 'scheduled', 'confirmed', 'completed', 'no_show'];
const monthOf = (iso: string) => localDateKey(iso, demoTimezone).slice(0, 7);

const demoMetrics: MetricsApi = {
  async occupancy(_orgId, fromKey, toKey) {
    const t = db();
    return t.professionals.filter((p) => p.active).map((p) => {
      let available = 0;
      for (let d = fromKey; d <= toKey; d = addDays(d, 1)) {
        const wd = ((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
        for (const r of t.availability_rules.filter((r) => r.professional_id === p.id && r.weekday === wd)) {
          const [sh, sm] = String(r.start_time).split(':').map(Number);
          const [eh, em] = String(r.end_time).split(':').map(Number);
          available += eh * 60 + em - (sh * 60 + sm);
        }
      }
      const appts = t.appointments.filter((a) => a.professional_id === p.id
        && localDateKey(String(a.starts_at), demoTimezone) >= fromKey && localDateKey(String(a.starts_at), demoTimezone) <= toKey);
      const booked = appts.filter((a) => ACTIVE.includes(String(a.status)))
        .reduce((m, a) => m + (new Date(String(a.ends_at)).getTime() - new Date(String(a.starts_at)).getTime()) / 60_000, 0);
      return {
        professional_id: p.id, full_name: String(p.full_name), available_minutes: available, booked_minutes: Math.round(booked),
        attended: appts.filter((a) => a.status === 'completed').length,
        no_shows: appts.filter((a) => a.status === 'no_show').length,
        cancelled: appts.filter((a) => a.status === 'cancelled').length,
        occupancy_pct: available ? Math.round((1000 * booked) / available) / 10 : null,
      };
    });
  },
  async attendance(_orgId, sinceMonth) {
    return sumBy(db().appointments.filter((a) => monthOf(String(a.starts_at)) >= sinceMonth).map((a) => ({
      month: monthOf(String(a.starts_at)),
      booked: ['scheduled', 'confirmed', 'completed', 'no_show'].includes(String(a.status)) ? 1 : 0,
      attended: a.status === 'completed' ? 1 : 0, no_shows: a.status === 'no_show' ? 1 : 0, cancelled: a.status === 'cancelled' ? 1 : 0,
    })), ['booked', 'attended', 'no_shows', 'cancelled']);
  },
  async revenue(_orgId, sinceMonth) {
    return sumBy(db().payments.filter((p) => p.status === 'approved' && monthOf(String(p.paid_at)) >= sinceMonth)
      .map((p) => ({ month: monthOf(String(p.paid_at)), total_cents: Number(p.amount_cents), payments: 1 })), ['total_cents', 'payments']);
  },
};

export const metricsApi: MetricsApi = isDemo ? demoMetrics : supabaseMetrics;

/** Mes (YYYY-MM) desplazado n meses. */
export function shiftMonth(monthKey: string, n: number): string {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
