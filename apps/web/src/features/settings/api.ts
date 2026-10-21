// Datos de configuración (solo admin por RLS) y gestión de personal (Edge Function staff-invite).
import { isDemo, supabase } from '../../lib/supabase';
import { db, demoChanged, organization, staff, uid, type Row } from '../../demo/store';

export type CatalogTable = 'sites' | 'services' | 'insurers' | 'professionals' | 'availability_rules' | 'time_off';
export type AnyRow = Record<string, unknown> & { id: string };

export interface OrgSettings {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  country_code: string;
  wa_phone_number_id: string | null;
  wa_display_phone: string | null;
  on_call_phone_e164: string | null;
  crisis_lines: { name: string; phone: string }[];
  settings: { late_cancel_hours?: number; privacy_policy_url?: string; [k: string]: unknown };
}

export interface StaffMember {
  user_id: string;
  full_name: string | null;
  email: string | null;
  roles: string[];
  professional_id: string | null;
}

export interface InviteInput {
  orgId: string; email: string; fullName: string; role: string; specialty?: string; licenseNumber?: string;
}

export interface SettingsApi {
  list(table: CatalogTable, orgId: string, filter?: Record<string, string>): Promise<AnyRow[]>;
  insert(table: CatalogTable, orgId: string, row: Record<string, unknown>): Promise<void>;
  update(table: CatalogTable, id: string, patch: Record<string, unknown>): Promise<void>;
  remove(table: CatalogTable, id: string): Promise<void>;
  getOrg(orgId: string): Promise<OrgSettings>;
  updateOrg(orgId: string, patch: Partial<OrgSettings>): Promise<void>;
  staff(orgId: string): Promise<StaffMember[]>;
  invite(input: InviteInput): Promise<{ ok: true; invited: boolean } | { ok: false; error: string }>;
  removeRole(orgId: string, userId: string, role: string): Promise<void>;
}

const ORDER: Record<CatalogTable, string> = {
  sites: 'name', services: 'name', insurers: 'name', professionals: 'full_name', availability_rules: 'weekday', time_off: 'starts_at',
};

function friendly(e: { code?: string; message?: string }): Error {
  if (e.code === 'PA004') return new Error('La clínica debe tener al menos un administrador. Asigna otro antes de quitar este rol.');
  if (e.code === '23503') return new Error('No se puede borrar: tiene citas u otros datos asociados. Desactívalo en su lugar.');
  if (e.code === '23505') return new Error('Ya existe un registro igual.');
  if (e.code === '23514') return new Error('Algún valor no es válido (revisa horas y duraciones).');
  return new Error(e.message ?? 'Error inesperado');
}

const supabaseSettings: SettingsApi = {
  async list(table, orgId, filter = {}) {
    let q = supabase.from(table).select('*').eq('org_id', orgId);
    for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
    const { data, error } = await q.order(ORDER[table]);
    if (error) throw friendly(error);
    return data as AnyRow[];
  },
  async insert(table, orgId, row) {
    const { error } = await supabase.from(table).insert({ ...row, org_id: orgId });
    if (error) throw friendly(error);
  },
  async update(table, id, patch) {
    const { error } = await supabase.from(table).update(patch).eq('id', id);
    if (error) throw friendly(error);
  },
  async remove(table, id) {
    const { error } = await supabase.from(table).delete().eq('id', id);
    if (error) throw friendly(error);
  },
  async getOrg(orgId) {
    const { data, error } = await supabase.from('organizations')
      .select('id, name, timezone, currency, country_code, wa_phone_number_id, wa_display_phone, on_call_phone_e164, crisis_lines, settings')
      .eq('id', orgId).single();
    if (error) throw friendly(error);
    return data as OrgSettings;
  },
  async updateOrg(orgId, patch) {
    const { error } = await supabase.from('organizations').update(patch).eq('id', orgId);
    if (error) throw friendly(error);
  },
  async staff(orgId) {
    const { data, error } = await supabase.from('v_staff').select('user_id, full_name, email, roles, professional_id')
      .eq('org_id', orgId).order('full_name');
    if (error) throw friendly(error);
    return data as StaffMember[];
  },
  async invite(input) {
    const { data, error } = await supabase.functions.invoke('staff-invite', { body: input });
    if (!error) return { ok: true, invited: Boolean((data as { invited?: boolean }).invited) };
    const detail = await (error as { context?: Response }).context?.json().catch(() => null);
    return { ok: false, error: detail?.error ?? 'No se pudo invitar.' };
  },
  async removeRole(orgId, userId, role) {
    const { error } = await supabase.from('memberships').delete().eq('org_id', orgId).eq('user_id', userId).eq('role', role);
    if (error) throw friendly(error);
  },
};

// ----------------------------------------------------------------------- demo
const demoSettings: SettingsApi = {
  async list(table, _orgId, filter = {}) {
    const key = ORDER[table];
    return (db()[table] as Row[])
      .filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v))
      .sort((a, b) => String(a[key]).localeCompare(String(b[key]), 'es', { numeric: true })) as AnyRow[];
  },
  async insert(table, _orgId, row) { db()[table].push({ id: uid(table), org_id: 'demo-org', ...row }); demoChanged(); },
  async update(table, id, patch) { Object.assign(db()[table].find((r) => r.id === id) ?? {}, patch); demoChanged(); },
  async remove(table, id) {
    if (['sites', 'services', 'professionals'].includes(table) && db().appointments.some((a) => Object.values(a).includes(id))) {
      throw new Error('No se puede borrar: tiene citas u otros datos asociados. Desactívalo en su lugar.');
    }
    const rows = db()[table];
    rows.splice(rows.findIndex((r) => r.id === id), 1);
    demoChanged();
  },
  async getOrg() { return structuredClone(organization) as unknown as OrgSettings; },
  async updateOrg(_orgId, patch) { Object.assign(organization, patch); demoChanged(); },
  async staff() { return structuredClone(staff) as unknown as StaffMember[]; },
  async invite(input) {
    const existing = staff.find((m) => m.email === input.email.toLowerCase());
    if (existing) {
      if (!(existing.roles as string[]).includes(input.role)) (existing.roles as string[]).push(input.role);
    } else {
      staff.push({ id: uid('u'), user_id: uid('u'), full_name: input.fullName, email: input.email.toLowerCase(), roles: [input.role], professional_id: null });
    }
    demoChanged();
    return { ok: true, invited: !existing };
  },
  async removeRole(_orgId, userId, role) {
    const admins = staff.filter((m) => (m.roles as string[]).includes('admin'));
    if (role === 'admin' && admins.length === 1 && admins[0].user_id === userId) {
      throw new Error('La clínica debe tener al menos un administrador. Asigna otro antes de quitar este rol.');
    }
    const m = staff.find((x) => x.user_id === userId);
    if (m) m.roles = (m.roles as string[]).filter((r) => r !== role);
    if (m && (m.roles as string[]).length === 0) staff.splice(staff.indexOf(m), 1);
    demoChanged();
  },
};

export const settingsApi: SettingsApi = isDemo ? demoSettings : supabaseSettings;
