// Invitación de personal a una clínica. Lógica pura: staff-invite/index.ts pone Supabase Auth.
export const STAFF_ROLES = ['admin', 'professional', 'receptionist'] as const;
export const SPECIALTIES = ['psychology', 'psychiatry', 'general_medicine', 'other'] as const;
export type StaffRole = typeof STAFF_ROLES[number];
export type Specialty = typeof SPECIALTIES[number];

export interface StaffDeps {
  /** Con la sesión de quien invita: ¿es admin de esa organización? */
  isAdminOf(orgId: string): Promise<boolean>;
  findUserIdByEmail(email: string): Promise<string | null>;
  /** Crea la cuenta y envía el correo de invitación; devuelve el id del usuario nuevo. */
  inviteUser(email: string, fullName: string): Promise<string>;
  upsertProfile(userId: string, fullName: string, email: string): Promise<void>;
  /** true si se añadió; false si ya tenía ese rol. */
  addMembership(orgId: string, userId: string, role: StaffRole): Promise<boolean>;
  linkProfessional(orgId: string, userId: string, fullName: string, specialty: Specialty, licenseNumber: string | null): Promise<string>;
}

export type InviteResult =
  | { ok: true; userId: string; invited: boolean; alreadyHadRole: boolean; professionalId: string | null }
  | { ok: false; status: number; error: string };

export async function inviteStaff(deps: StaffDeps, raw: Record<string, unknown>): Promise<InviteResult> {
  const orgId = str(raw.orgId);
  const email = str(raw.email).toLowerCase();
  const fullName = str(raw.fullName).replace(/\s+/g, ' ');
  const role = str(raw.role) as StaffRole;
  const specialty = str(raw.specialty) as Specialty;
  const licenseNumber = str(raw.licenseNumber) || null;

  if (!/^[0-9a-f-]{36}$/.test(orgId)) return fail(400, 'Organización inválida.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(400, 'Correo inválido.');
  if (fullName.length < 3 || fullName.length > 120) return fail(400, 'Escribe el nombre completo.');
  if (!STAFF_ROLES.includes(role)) return fail(400, 'Rol inválido.');
  if (role === 'professional' && !SPECIALTIES.includes(specialty)) return fail(400, 'Indica la especialidad del profesional.');

  if (!(await deps.isAdminOf(orgId))) return fail(403, 'Solo un administrador de la clínica puede invitar personal.');

  let userId = await deps.findUserIdByEmail(email);
  const invited = !userId;
  if (!userId) userId = await deps.inviteUser(email, fullName);

  await deps.upsertProfile(userId, fullName, email);
  const added = await deps.addMembership(orgId, userId, role);
  const professionalId = role === 'professional'
    ? await deps.linkProfessional(orgId, userId, fullName, specialty, licenseNumber)
    : null;

  return { ok: true, userId, invited, alreadyHadRole: !added, professionalId };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function fail(status: number, error: string): InviteResult {
  return { ok: false, status, error };
}
