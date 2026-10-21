// =============================================================================
// Edge Function: invitar personal a la clínica desde el panel
// POST { orgId, email, fullName, role, specialty?, licenseNumber? }
//
// Necesita la service_role (Auth Admin API) para crear la cuenta y enviar el
// correo de invitación; por eso no puede hacerse desde el navegador. Antes
// comprueba con la sesión del usuario que es admin de esa organización.
// =============================================================================
import { createClient, type SupabaseClient } from '../_shared/deps.ts';
import { env, optionalEnv, requireEnv } from '../_shared/env.ts';
import { corsHeaders, json } from '../_shared/cors.ts';
import { inviteStaff } from '../_shared/staff.ts';

const admin: SupabaseClient = createClient(env.supabaseUrl, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

  const asUser = createClient(env.supabaseUrl, requireEnv('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: 'No autenticado' }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'JSON inválido' }, 400); }

  try {
    const result = await inviteStaff({
      async isAdminOf(orgId) {
        const { data } = await asUser.from('memberships').select('role')
          .eq('org_id', orgId).eq('user_id', user.id).eq('role', 'admin').maybeSingle();
        return Boolean(data);
      },
      async findUserIdByEmail(email) {
        const { data: profile } = await admin.from('profiles').select('id').eq('email', email).maybeSingle();
        if (profile) return profile.id;
        // Cuentas sin perfil todavía: se buscan en Auth (clínicas pequeñas: pocas páginas)
        for (let page = 1; page <= 10; page++) {
          const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
          if (error) throw error;
          const found = data.users.find((u) => u.email?.toLowerCase() === email);
          if (found) return found.id;
          if (data.users.length < 200) break;
        }
        return null;
      },
      async inviteUser(email, fullName) {
        const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
          data: { full_name: fullName },
          redirectTo: optionalEnv('PANEL_URL'),
        });
        if (error) throw error;
        return data.user.id;
      },
      async upsertProfile(userId, fullName, email) {
        const { error } = await admin.from('profiles').upsert({ id: userId, full_name: fullName, email });
        if (error) throw error;
      },
      async addMembership(orgId, userId, role) {
        const { data, error } = await admin.from('memberships')
          .upsert({ org_id: orgId, user_id: userId, role }, { onConflict: 'org_id,user_id,role', ignoreDuplicates: true })
          .select('role');
        if (error) throw error;
        return (data?.length ?? 0) > 0;
      },
      async linkProfessional(orgId, userId, fullName, specialty, licenseNumber) {
        const { data: existing } = await admin.from('professionals').select('id')
          .eq('org_id', orgId).eq('user_id', userId).maybeSingle();
        if (existing) return existing.id;
        const { data, error } = await admin.from('professionals')
          .insert({ org_id: orgId, user_id: userId, full_name: fullName, specialty, license_number: licenseNumber })
          .select('id').single();
        if (error) throw error;
        return data.id;
      },
    }, body);

    return result.ok ? json(result) : json({ error: result.error }, result.status);
  } catch (err) {
    console.error('staff-invite falló', err);
    return json({ error: 'No se pudo completar la invitación. Revisa el correo e inténtalo de nuevo.' }, 500);
  }
});
