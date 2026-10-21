// Panel: acceso por enlace mágico (solo personal invitado) y navegación según el rol.
// Ocultar una pestaña es comodidad; quien protege los datos es RLS en la base de datos.
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { isDemo, supabase } from './lib/supabase';
import { SessionProvider, useSession, useSessionState, type Role } from './lib/session';
import { go, useRoute } from './lib/router';
import { ROLE_LABEL, Loading } from './ui';
import Inbox from './features/inbox/Inbox';
import { inboxApi } from './features/inbox/api';
import Agenda from './features/agenda/Agenda';
import Patients from './features/patients/Patients';
import PatientDetail from './features/patients/PatientDetail';
import Metrics from './features/metrics/Metrics';
import Settings from './features/settings/Settings';

export default function App() {
  const [auth, setAuth] = useState<Session | null | undefined>(isDemo ? null : undefined);

  useEffect(() => {
    if (isDemo) return;
    supabase.auth.getSession().then(({ data }) => setAuth(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setAuth(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (!isDemo && auth === undefined) return <Loading />;
  if (!isDemo && !auth) {
    return (
      <main className="mx-auto max-w-4xl p-4 font-sans text-slate-800">
        <h1 className="mb-6 text-2xl font-semibold text-teal-800">PsicoAgenda</h1>
        <Login />
      </main>
    );
  }
  return <SessionProvider><Gate /></SessionProvider>;
}

function Gate() {
  const { status, error } = useSessionState();
  if (status === 'loading') return <Loading />;
  if (status === 'no-membership') {
    return <Message title="Sin clínica asignada">Tu usuario aún no pertenece a ninguna clínica. Pide a un administrador que te invite.</Message>;
  }
  if (status === 'error') return <Message title="No se pudo cargar tu sesión">{error}</Message>;
  return <Shell />;
}

interface NavItem { path: string; label: string; show: boolean }

function Shell() {
  const s = useSession();
  const route = useRoute();
  const [attention, setAttention] = useState(0);

  const nav: NavItem[] = [
    { path: 'agenda', label: 'Agenda', show: true },
    { path: 'pacientes', label: 'Pacientes', show: true },
    { path: 'bandeja', label: 'Bandeja WhatsApp', show: s.isStaff },
    { path: 'metricas', label: 'Métricas', show: s.isAdmin },
    { path: 'configuracion', label: 'Configuración', show: s.isAdmin },
  ];
  const allowed = nav.filter((n) => n.show);
  const section = allowed.some((n) => n.path === route[0]) ? route[0] : 'agenda';

  // Ruta no permitida para este rol (o vacía): la URL pasa a reflejar lo que se muestra
  useEffect(() => {
    if (route[0] !== section) history.replaceState(null, '', `#/${section}`);
  }, [route, section]);

  // Contador de conversaciones que esperan a una persona (crisis o derivadas)
  useEffect(() => {
    if (!s.isStaff) return;
    const refresh = () => inboxApi.list()
      .then((items) => setAttention(items.filter((c) => c.open_crisis || c.human_handoff).length))
      .catch(() => setAttention(0));
    refresh();
    return inboxApi.subscribe(refresh);
  }, [s.isStaff, s.orgId]);

  let page: ReactNode;
  // #/pacientes/<id>[/historia[/<cita>]]
  if (section === 'pacientes') page = route[1] ? <PatientDetail key={route.join('/')} id={route[1]} initialTab={route[2]} appointmentId={route[3]} /> : <Patients />;
  else if (section === 'bandeja') page = <Inbox />;
  else if (section === 'metricas') page = <Metrics />;
  else if (section === 'configuracion') page = <Settings section={route[1]} />;
  else page = <Agenda />;

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-800">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
          <span className="text-lg font-semibold text-teal-800">PsicoAgenda</span>
          <nav className="flex flex-wrap gap-1 text-sm" aria-label="Secciones">
            {allowed.map((n) => (
              <button key={n.path} onClick={() => go(`/${n.path}`)} aria-current={section === n.path ? 'page' : undefined}
                className={`flex items-center rounded px-3 py-1.5 ${section === n.path ? 'bg-teal-700 text-white' : 'hover:bg-slate-100'}`}>
                {n.label}
                {n.path === 'bandeja' && attention > 0 && <span className="ml-1.5 rounded-full bg-red-600 px-1.5 text-xs text-white">{attention}</span>}
              </button>
            ))}
          </nav>
          <span className="ml-auto flex items-center gap-3 text-sm">
            {isDemo ? <DemoRoleSwitcher /> : (
              <>
                <span className="text-slate-600">{s.userName} · {s.orgName}</span>
                <button className="underline" onClick={() => supabase.auth.signOut()}>Cerrar sesión</button>
              </>
            )}
          </span>
        </div>
      </header>
      {/* key: al cambiar de rol (demo) o de clínica, las pantallas empiezan de cero */}
      <main key={`${s.orgId}:${s.roles.join(',')}`} className="mx-auto max-w-7xl p-4">{page}</main>
    </div>
  );
}

function DemoRoleSwitcher() {
  const { session, setDemoRole } = useSessionState();
  return (
    <label className="flex items-center gap-2 rounded bg-amber-100 px-2 py-1 text-xs text-amber-900">
      Demo · ver como
      <select value={session?.roles[0]} onChange={(e) => setDemoRole?.(e.target.value as Role)}
        className="rounded border border-amber-300 bg-white px-1 py-0.5">
        {(['admin', 'receptionist', 'professional'] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
      </select>
    </label>
  );
}

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-lg p-6 font-sans text-slate-800">
      <h1 className="mb-2 text-xl font-semibold">{title}</h1>
      <p className="text-slate-600">{children}</p>
      <button className="mt-4 underline" onClick={() => supabase.auth.signOut()}>Cerrar sesión</button>
    </main>
  );
}

function Login() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const { error } = await supabase.auth.signInWithOtp({
      email, options: { shouldCreateUser: false, emailRedirectTo: window.location.origin },
    });
    if (error) setError(error.message);
    else setSent(true);
  }

  if (sent) return <p>Revisa tu correo: te enviamos un enlace para entrar.</p>;
  return (
    <form onSubmit={submit} className="flex max-w-sm flex-col gap-3">
      <label className="text-sm">Correo del personal
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded border px-3 py-2" />
      </label>
      <button className="rounded bg-teal-700 px-4 py-2 text-white">Enviar enlace de acceso</button>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </form>
  );
}
