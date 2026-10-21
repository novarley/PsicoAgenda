// Panel: acceso por enlace mágico (solo personal invitado), agenda del día y bandeja
// de WhatsApp. Lo que cada rol ve lo decide RLS en la base de datos.
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { isDemo, supabase } from './lib/supabase';
import Inbox from './features/inbox/Inbox';
import { inboxApi } from './features/inbox/api';

interface Appointment { id: string; starts_at: string; status: string; patients: { full_name: string } | null }
type Tab = 'today' | 'inbox';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    if (isDemo) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (!isDemo && !session) {
    return (
      <main className="mx-auto max-w-4xl p-4 font-sans text-slate-800">
        <h1 className="mb-6 text-2xl font-semibold">PsicoAgenda</h1>
        <Login />
      </main>
    );
  }
  return <Shell />;
}

function Shell() {
  const [tab, setTab] = useState<Tab>('inbox');
  const [attention, setAttention] = useState(0);

  // Contador de conversaciones que esperan a una persona (crisis o derivadas)
  useEffect(() => {
    const refresh = () => inboxApi.list()
      .then((items) => setAttention(items.filter((c) => c.open_crisis || c.human_handoff).length))
      .catch(() => setAttention(0));
    refresh();
    return inboxApi.subscribe(refresh);
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-800">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <span className="text-lg font-semibold text-teal-800">PsicoAgenda</span>
          <nav className="flex gap-1 text-sm">
            <TabButton active={tab === 'today'} onClick={() => setTab('today')}>Hoy</TabButton>
            <TabButton active={tab === 'inbox'} onClick={() => setTab('inbox')}>
              Bandeja WhatsApp
              {attention > 0 && <span className="ml-1.5 rounded-full bg-red-600 px-1.5 text-xs text-white">{attention}</span>}
            </TabButton>
          </nav>
          <span className="ml-auto flex items-center gap-3 text-sm">
            {isDemo && <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">Modo demo · datos ficticios</span>}
            {!isDemo && <button className="underline" onClick={() => supabase.auth.signOut()}>Cerrar sesión</button>}
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-6xl p-4">
        {tab === 'inbox' ? <Inbox /> : <Today />}
      </main>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick}
      className={`flex items-center rounded px-3 py-1.5 ${active ? 'bg-teal-700 text-white' : 'hover:bg-slate-100'}`}>
      {children}
    </button>
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

function Today() {
  const [today, setToday] = useState<Appointment[]>([]);

  useEffect(() => {
    if (isDemo) return;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    supabase.from('appointments').select('id, starts_at, status, patients(full_name)')
      .gte('starts_at', start.toISOString()).lt('starts_at', end.toISOString()).order('starts_at')
      .then(({ data }) => setToday((data ?? []) as unknown as Appointment[]));
  }, []);

  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold">Agenda de hoy</h2>
      {today.length === 0 ? <p className="text-slate-500">{isDemo ? 'La agenda aún no tiene modo demo.' : 'Sin citas hoy.'}</p> : (
        <ul className="divide-y rounded border bg-white">
          {today.map((a) => (
            <li key={a.id} className="flex justify-between p-3">
              <span>{new Date(a.starts_at).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })} · {a.patients?.full_name}</span>
              <span className="text-sm text-slate-500">{a.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
