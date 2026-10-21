// Bandeja de WhatsApp: conversaciones derivadas a una persona (crisis, petición del
// paciente, verificación de identidad) y respuesta manual desde el panel.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { inboxApi, type InboxItem, type ThreadMessage } from './api';

type Filter = 'attention' | 'all';

const REASON_LABEL: Record<string, string> = {
  crisis: 'Tras una crisis',   // crisis ya atendida; la abierta se marca aparte en rojo
  user_request: 'Pidió hablar con alguien',
  identity_verification: 'Verificar identidad',
  stuck: 'El bot no entendió',
  staff_takeover: 'Tomada por el equipo',
  staff_reply: 'Respondida por el equipo',
};

const needsAttention = (c: InboxItem) => c.open_crisis || c.human_handoff;
// Crisis primero, luego derivadas, luego el resto; dentro de cada grupo, lo más reciente arriba
const priority = (c: InboxItem) => (c.open_crisis ? 0 : c.human_handoff ? 1 : 2);

export default function Inbox() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [filter, setFilter] = useState<Filter>('attention');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    inboxApi.list().then(setItems).catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(() => {
    reload();
    return inboxApi.subscribe(reload);
  }, [reload]);

  const visible = useMemo(() => items
    .filter((c) => filter === 'all' || needsAttention(c))
    .sort((a, b) => priority(a) - priority(b) || b.last_at.localeCompare(a.last_at)), [items, filter]);
  const attentionCount = items.filter(needsAttention).length;
  const selected = items.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="grid h-[calc(100vh-9rem)] min-h-[520px] grid-cols-1 grid-rows-[minmax(0,1fr)] overflow-hidden rounded-lg border bg-white md:grid-cols-[320px_1fr]">
      <aside className={`flex min-h-0 flex-col border-r ${selected ? 'hidden md:flex' : 'flex'}`}>
        <div className="flex gap-1 border-b p-2 text-sm">
          <FilterButton active={filter === 'attention'} onClick={() => setFilter('attention')}>
            Requieren atención{attentionCount > 0 && <span className="ml-1 rounded-full bg-red-600 px-1.5 text-xs text-white">{attentionCount}</span>}
          </FilterButton>
          <FilterButton active={filter === 'all'} onClick={() => setFilter('all')}>Todas</FilterButton>
        </div>
        {error && <p className="p-3 text-sm text-red-700">{error}</p>}
        <ul className="flex-1 overflow-y-auto">
          {visible.length === 0 && <li className="p-4 text-sm text-slate-500">Nada pendiente. El bot está atendiendo.</li>}
          {visible.map((c) => (
            <li key={c.id}>
              <button onClick={() => setSelectedId(c.id)}
                className={`flex w-full flex-col gap-1 border-b px-3 py-2.5 text-left hover:bg-slate-50 ${c.id === selectedId ? 'bg-teal-50' : ''}`}>
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{c.patient_name ?? `+${c.wa_id}`}</span>
                  <span className="shrink-0 text-xs text-slate-500">{formatWhen(c.last_at)}</span>
                </span>
                <span className="flex flex-wrap gap-1">
                  {c.open_crisis && <Badge tone="red">Crisis</Badge>}
                  {c.human_handoff && !c.open_crisis && <Badge tone="amber">{REASON_LABEL[c.handoff_reason ?? ''] ?? 'Con una persona'}</Badge>}
                  {!c.human_handoff && <Badge tone="slate">Bot atendiendo</Badge>}
                </span>
                <span className="truncate text-sm text-slate-600">
                  {c.last_direction === 'out' && <span className="text-slate-400">→ </span>}{c.last_body ?? 'Sin mensajes'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className={`flex min-h-0 min-w-0 flex-col ${selected ? 'flex' : 'hidden md:flex'}`}>
        {selected
          ? <Thread key={selected.id} convo={selected} onBack={() => setSelectedId(null)} onChanged={reload} />
          : <div className="m-auto p-6 text-center text-slate-500">Elige una conversación para verla y responder.</div>}
      </section>
    </div>
  );
}

function Thread({ convo, onBack, onChanged }: { convo: InboxItem; onBack: () => void; onChanged: () => void }) {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    inboxApi.thread(convo.id).then(setMessages).catch((e) => setError(String(e.message ?? e)));
  }, [convo.id]);

  useEffect(() => {
    load();
    return inboxApi.subscribe(load);
  }, [load]);
  // Solo se desplaza el hilo (scrollIntoView movería también los contenedores padres)
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    const result = await inboxApi.send(convo.id, text);
    setSending(false);
    if (result.ok) { setDraft(''); load(); onChanged(); } else setError(result.error);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
  }

  async function act(action: () => Promise<void>) {
    try { await action(); onChanged(); } catch (e) { setError(String((e as Error).message ?? e)); }
  }

  return (
    <>
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <button onClick={onBack} className="text-sm text-teal-700 md:hidden" aria-label="Volver a la lista">←</button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold">{convo.patient_name ?? 'Paciente sin identificar'}</h2>
          <p className="text-xs text-slate-500">+{convo.wa_id} · {convo.human_handoff ? 'Una persona del equipo está a cargo' : 'El bot está atendiendo'}</p>
        </div>
        {convo.open_crisis && (
          <button onClick={() => act(() => inboxApi.ackCrisis(convo.id))}
            className="rounded bg-red-600 px-3 py-1.5 text-sm text-white">Marcar crisis atendida</button>
        )}
        {convo.human_handoff
          ? <button onClick={() => act(() => inboxApi.setHandoff(convo.id, false))}
              className="rounded border px-3 py-1.5 text-sm">Devolver al bot</button>
          : <button onClick={() => act(() => inboxApi.setHandoff(convo.id, true))}
              className="rounded border border-teal-700 px-3 py-1.5 text-sm text-teal-800">Tomar conversación</button>}
      </header>

      {convo.open_crisis && (
        <div role="alert" className="border-b border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
          <strong>Riesgo detectado.</strong> El bot ya envió las líneas de emergencia y quedó en pausa.
          Contacta al paciente ahora, por este chat o por teléfono, y marca la crisis como atendida cuando lo hayas hecho.
        </div>
      )}

      <div ref={scroller} className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-[#efeae2] p-3">
        {messages.map((m) => (
          <div key={m.message_id} className={`flex ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-1.5 text-sm shadow-sm ${m.direction === 'out' ? 'bg-[#d9fdd3]' : 'bg-white'}`}>
              {m.direction === 'out' && (
                <div className={`mb-0.5 text-xs font-medium ${m.sent_by ? 'text-teal-800' : 'text-slate-500'}`}>{m.sent_by ? 'Equipo' : 'Bot'}</div>
              )}
              {m.body}
              <div className="mt-0.5 text-right text-[11px] text-slate-500">
                {formatTime(m.at)} {m.direction === 'out' && statusIcon(m.status)}
              </div>
            </div>
          </div>
        ))}
      </div>

      <footer className="border-t p-2">
        {!convo.window_open && (
          <p className="mb-2 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
            Pasaron más de 24 h desde el último mensaje del paciente. WhatsApp solo permite enviarle una plantilla aprobada;
            el texto libre se habilita cuando el paciente vuelva a escribir.
          </p>
        )}
        {error && <p className="mb-2 text-xs text-red-700">{error}</p>}
        <div className="flex gap-2">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown}
            disabled={!convo.window_open || sending} rows={2} maxLength={4096}
            placeholder={convo.window_open ? 'Escribe una respuesta… (Enter envía, Shift+Enter salto de línea)' : 'Ventana de 24 h cerrada'}
            className="flex-1 resize-none rounded border px-3 py-2 text-sm disabled:bg-slate-100" />
          <button onClick={() => void send()} disabled={!convo.window_open || sending || !draft.trim()}
            className="self-end rounded bg-teal-700 px-4 py-2 text-sm text-white disabled:opacity-40">
            {sending ? 'Enviando…' : 'Enviar'}
          </button>
        </div>
        {!convo.human_handoff && convo.window_open && (
          <p className="mt-1 text-xs text-slate-500">Al responder, el bot se pausa en esta conversación hasta que la devuelvas.</p>
        )}
      </footer>
    </>
  );
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick}
      className={`rounded px-2.5 py-1 ${active ? 'bg-teal-700 text-white' : 'text-slate-700 hover:bg-slate-100'}`}>
      {children}
    </button>
  );
}

function Badge({ tone, children }: { tone: 'red' | 'amber' | 'slate'; children: ReactNode }) {
  const tones = { red: 'bg-red-100 text-red-800', amber: 'bg-amber-100 text-amber-900', slate: 'bg-slate-100 text-slate-600' };
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

function statusIcon(status: string) {
  if (status === 'failed') return <span className="text-red-600" title="No se entregó">⚠</span>;
  if (status === 'read') return <span className="text-sky-600" title="Leído">✓✓</span>;
  if (status === 'delivered') return <span title="Entregado">✓✓</span>;
  return <span title="Enviado">✓</span>;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
}

function formatWhen(iso: string) {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? formatTime(iso)
    : d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
}
