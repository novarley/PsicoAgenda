// Esqueleto del panel: acceso por enlace mágico (solo personal invitado),
// alertas de crisis en tiempo real y agenda del día. Lo que cada rol ve lo decide RLS.
import { useEffect, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';

interface CrisisEvent { id: string; severity: 'high' | 'medium'; created_at: string }
interface Appointment { id: string; starts_at: string; status: string; patients: { full_name: string } | null }

export default function App() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  return (
    <main className="mx-auto max-w-4xl p-4 font-sans text-slate-800">
      <h1 className="mb-6 text-2xl font-semibold">PsicoAgenda</h1>
      {session ? <Dashboard /> : <Login />}
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

function Dashboard() {
  const [crises, setCrises] = useState<CrisisEvent[]>([]);
  const [today, setToday] = useState<Appointment[]>([]);

  useEffect(() => {
    supabase.from('crisis_events').select('id, severity, created_at')
      .is('acknowledged_at', null).order('created_at', { ascending: false })
      .then(({ data }) => setCrises(data ?? []));

    // Las alertas de crisis llegan al instante (Supabase Realtime, incluido en el plan gratis)
    const channel = supabase.channel('crisis')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'crisis_events' },
        (payload) => setCrises((c) => [payload.new as CrisisEvent, ...c]))
      .subscribe();

    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    supabase.from('appointments').select('id, starts_at, status, patients(full_name)')
      .gte('starts_at', start.toISOString()).lt('starts_at', end.toISOString()).order('starts_at')
      .then(({ data }) => setToday((data ?? []) as unknown as Appointment[]));

    return () => { supabase.removeChannel(channel); };
  }, []);

  return (
    <div className="flex flex-col gap-6">
      {crises.length > 0 && (
        <section role="alert" className="rounded border-2 border-red-600 bg-red-50 p-4">
          <h2 className="font-semibold text-red-800">⚠️ {crises.length} alerta(s) de crisis sin atender</h2>
          <p className="text-sm">Abre la bandeja de WhatsApp y contacta al paciente ahora.</p>
        </section>
      )}
      <section>
        <h2 className="mb-2 text-lg font-semibold">Agenda de hoy</h2>
        {today.length === 0 ? <p className="text-slate-500">Sin citas hoy.</p> : (
          <ul className="divide-y rounded border">
            {today.map((a) => (
              <li key={a.id} className="flex justify-between p-3">
                <span>{new Date(a.starts_at).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })} · {a.patients?.full_name}</span>
                <span className="text-sm text-slate-500">{a.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <button className="self-start text-sm underline" onClick={() => supabase.auth.signOut()}>Cerrar sesión</button>
    </div>
  );
}
