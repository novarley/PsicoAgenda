import { assert, assertEquals } from 'jsr:@std/assert@1.0.13';
import { inviteStaff, type StaffDeps } from '../_shared/staff.ts';

const ORG = '11111111-1111-1111-1111-111111111111';

function fakeDeps(opts: { admin?: boolean; existingUser?: string | null; hasRole?: boolean } = {}) {
  const calls = { invited: [] as string[], memberships: [] as unknown[], professionals: [] as unknown[], profiles: [] as unknown[] };
  const deps: StaffDeps = {
    isAdminOf: async () => opts.admin ?? true,
    findUserIdByEmail: async () => opts.existingUser ?? null,
    inviteUser: async (email) => (calls.invited.push(email), 'new-user'),
    upsertProfile: async (id, name, email) => void calls.profiles.push({ id, name, email }),
    addMembership: async (org, user, role) => (calls.memberships.push({ org, user, role }), !opts.hasRole),
    linkProfessional: async (org, user, name, specialty) => (calls.professionals.push({ org, user, name, specialty }), 'prof-1'),
  };
  return { deps, calls };
}

Deno.test('personal: invita a recepción por correo nuevo', async () => {
  const { deps, calls } = fakeDeps();
  const r = await inviteStaff(deps, { orgId: ORG, email: ' Recepcion@Clinica.co ', fullName: 'Marta  Ruiz', role: 'receptionist' });
  assert(r.ok);
  assertEquals(r.invited, true);
  assertEquals(calls.invited, ['recepcion@clinica.co']);
  assertEquals(calls.profiles[0], { id: 'new-user', name: 'Marta Ruiz', email: 'recepcion@clinica.co' });
  assertEquals(calls.professionals.length, 0);
});

Deno.test('personal: profesional existente se enlaza sin reenviar invitación', async () => {
  const { deps, calls } = fakeDeps({ existingUser: 'u-9' });
  const r = await inviteStaff(deps, { orgId: ORG, email: 'psico@clinica.co', fullName: 'Laura Méndez', role: 'professional', specialty: 'psychology' });
  assert(r.ok);
  assertEquals(r.invited, false);
  assertEquals(r.professionalId, 'prof-1');
  assertEquals(calls.invited.length, 0);
  assertEquals(calls.professionals[0], { org: ORG, user: 'u-9', name: 'Laura Méndez', specialty: 'psychology' });
});

Deno.test('personal: solo un admin puede invitar', async () => {
  const { deps, calls } = fakeDeps({ admin: false });
  const r = await inviteStaff(deps, { orgId: ORG, email: 'x@clinica.co', fullName: 'Ana Pérez', role: 'admin' });
  assert(!r.ok && r.status === 403);
  assertEquals(calls.invited.length, 0);
});

Deno.test('personal: validaciones', async () => {
  const { deps } = fakeDeps();
  const cases: Record<string, unknown>[] = [
    { orgId: 'x', email: 'a@b.co', fullName: 'Ana Pérez', role: 'admin' },
    { orgId: ORG, email: 'no-es-correo', fullName: 'Ana Pérez', role: 'admin' },
    { orgId: ORG, email: 'a@b.co', fullName: 'A', role: 'admin' },
    { orgId: ORG, email: 'a@b.co', fullName: 'Ana Pérez', role: 'superadmin' },
    { orgId: ORG, email: 'a@b.co', fullName: 'Ana Pérez', role: 'professional' },   // falta especialidad
  ];
  for (const c of cases) {
    const r = await inviteStaff(deps, c);
    assert(!r.ok && r.status === 400, JSON.stringify(c));
  }
});

Deno.test('personal: si ya tenía el rol lo indica', async () => {
  const { deps } = fakeDeps({ existingUser: 'u-1', hasRole: true });
  const r = await inviteStaff(deps, { orgId: ORG, email: 'a@b.co', fullName: 'Ana Pérez', role: 'receptionist' });
  assert(r.ok && r.alreadyHadRole);
});
