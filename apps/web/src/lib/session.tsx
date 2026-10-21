// Contexto de sesión: quién es el usuario, en qué clínica trabaja y con qué roles.
// La UI lo usa para mostrar u ocultar pantallas; la SEGURIDAD real la impone RLS.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { isDemo, supabase } from './supabase';
import { DEMO_USERS, demoAuth, demoChanged, organization, type Role } from '../demo/store';

export type { Role };

export interface SessionInfo {
  userId: string;
  userName: string;
  orgId: string;
  orgName: string;
  timezone: string;
  currency: string;
  countryCode: string;
  roles: Role[];
  professionalId: string | null;
  isAdmin: boolean;
  isStaff: boolean;          // admin o recepción
  isProfessional: boolean;
}

interface Ctx {
  session: SessionInfo | null;
  status: 'loading' | 'ready' | 'no-membership' | 'error';
  error?: string;
  /** Solo en demo: cambiar de rol para ver la app como cada perfil. */
  setDemoRole?: (role: Role) => void;
  reload: () => void;
}

const SessionContext = createContext<Ctx | null>(null);

function build(base: Omit<SessionInfo, 'isAdmin' | 'isStaff' | 'isProfessional'>): SessionInfo {
  return {
    ...base,
    isAdmin: base.roles.includes('admin'),
    isStaff: base.roles.includes('admin') || base.roles.includes('receptionist'),
    isProfessional: base.roles.includes('professional'),
  };
}

function demoSession(role: Role): SessionInfo {
  const u = DEMO_USERS[role];
  return build({
    userId: u.userId, userName: u.name, orgId: String(organization.id), orgName: String(organization.name),
    timezone: String(organization.timezone), currency: String(organization.currency),
    countryCode: String(organization.country_code), roles: [role], professionalId: u.professionalId,
  });
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<Ctx, 'reload' | 'setDemoRole'>>({ session: null, status: 'loading' });

  const load = useCallback(async () => {
    if (isDemo) {
      setState({ session: demoSession(demoAuth.role), status: 'ready' });
      return;
    }
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: memberships, error } = await supabase.from('memberships').select('org_id, role').eq('user_id', user.id);
      if (error) throw error;
      if (!memberships?.length) { setState({ session: null, status: 'no-membership' }); return; }

      const preferred = localStorage.getItem('psicoagenda.org');
      const orgId = memberships.some((m) => m.org_id === preferred) ? preferred! : memberships[0].org_id;
      const [{ data: org, error: e1 }, { data: prof }, { data: profile }] = await Promise.all([
        supabase.from('organizations').select('id, name, timezone, currency, country_code').eq('id', orgId).single(),
        supabase.from('professionals').select('id').eq('org_id', orgId).eq('user_id', user.id).maybeSingle(),
        supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle(),
      ]);
      if (e1) throw e1;
      setState({
        status: 'ready',
        session: build({
          userId: user.id, userName: profile?.full_name ?? user.email ?? 'Usuario',
          orgId, orgName: org.name, timezone: org.timezone, currency: org.currency, countryCode: org.country_code,
          roles: memberships.filter((m) => m.org_id === orgId).map((m) => m.role as Role),
          professionalId: prof?.id ?? null,
        }),
      });
    } catch (e) {
      setState({ session: null, status: 'error', error: String((e as Error).message ?? e) });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const setDemoRole = isDemo ? (role: Role) => {
    demoAuth.role = role;
    setState({ session: demoSession(role), status: 'ready' });
    demoChanged();
  } : undefined;

  return (
    <SessionContext.Provider value={{ ...state, setDemoRole, reload: () => void load() }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSessionState(): Ctx {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSessionState fuera de SessionProvider');
  return ctx;
}

/** Para pantallas que solo se muestran con sesión lista. */
export function useSession(): SessionInfo {
  const { session } = useSessionState();
  if (!session) throw new Error('Sesión no disponible');
  return session;
}
