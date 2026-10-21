// Historia clínica del paciente: notas de evolución, diagnósticos y anamnesis.
// Solo para profesionales tratantes (RLS); las notas privadas solo las ve su autor.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '../../lib/session';
import { isDemo } from '../../lib/supabase';
import { onDemoChange } from '../../demo/store';
import { formatDate, formatDateTime } from '../../lib/time';
import { Badge, Button, Card, Empty, ErrorText, errorMessage, Loading, SelectInput, TextInput } from '../../ui';
import type { AgendaAppointment } from '../agenda/api';
import { ANAMNESIS_TEMPLATE, clinicalApi, COMMON_CODES, SOAP_TEMPLATE, type ClinicalView, type Diagnosis, type NoteView } from './api';

const textareaClass = 'w-full rounded border border-slate-300 px-3 py-2 text-sm leading-relaxed';

export default function ClinicalRecord({ patientId, appointments, appointmentId }: {
  patientId: string; appointments: AgendaAppointment[]; appointmentId?: string;
}) {
  const [view, setView] = useState<ClinicalView | null>(null);
  const [diagnoses, setDiagnoses] = useState<Diagnosis[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([clinicalApi.get(patientId), clinicalApi.diagnoses(patientId)])
      .then(([v, d]) => { setView(v); setDiagnoses(d); setError(null); })
      .catch((e) => setError(errorMessage(e)));
  }, [patientId]);
  useEffect(() => { load(); return isDemo ? onDemoChange(load) : undefined; }, [load]);

  if (error && !view) return <Card><ErrorText>{error}</ErrorText></Card>;
  if (!view) return <Loading />;

  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-start gap-2 rounded border border-teal-200 bg-teal-50 px-3 py-2 text-xs text-teal-950">
        <span aria-hidden>🔒</span>
        <span>Contenido cifrado. Solo lo ven los profesionales que atienden a este paciente; las notas privadas, solo su autor.
          Cada apertura de la historia queda registrada en la auditoría.{isDemo && ' (En la demo no hay cifrado real.)'}</span>
      </p>
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <Notes patientId={patientId} notes={view.notes} appointments={appointments} appointmentId={appointmentId} onChanged={load} />
        <div className="flex flex-col gap-4">
          <Diagnoses patientId={patientId} items={diagnoses} onChanged={load} />
          <Anamnesis patientId={patientId} record={view.record} onChanged={load} />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- notas
function Notes({ patientId, notes, appointments, appointmentId, onChanged }: {
  patientId: string; notes: NoteView[]; appointments: AgendaAppointment[]; appointmentId?: string; onChanged: () => void;
}) {
  const s = useSession();
  const mine = appointments.filter((a) => a.professional_id === s.professionalId && ['completed', 'confirmed', 'scheduled'].includes(a.status)
    && new Date(a.starts_at).getTime() < Date.now() + 86_400_000);
  const [text, setText] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);   // privacidad por defecto (RGPD art. 25), igual que el backend
  const [appt, setAppt] = useState(appointmentId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (appointmentId) box.current?.focus(); }, [appointmentId]);

  async function save() {
    setBusy(true); setError(null);
    try { await clinicalApi.addNote(patientId, text, isPrivate, appt || null); setText(''); onChanged(); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  const apptLabel = (id: string | null) => {
    const a = appointments.find((x) => x.id === id);
    return a ? `Sesión del ${formatDateTime(a.starts_at, s.timezone)}` : null;
  };

  return (
    <Card title="Notas de evolución">
      <div className="mb-4 flex flex-col gap-2 rounded border bg-slate-50 p-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-56 flex-1">
            <SelectInput label="Sesión" value={appt} onChange={(e) => setAppt(e.target.value)}
              options={[{ value: '', label: 'Sin cita asociada' }, ...mine.map((a) => ({ value: a.id, label: formatDateTime(a.starts_at, s.timezone) }))]} />
          </div>
          <Button small onClick={() => setText(text ? `${text}\n\n${SOAP_TEMPLATE}` : SOAP_TEMPLATE)}>Plantilla SOAP</Button>
        </div>
        <textarea ref={box} value={text} onChange={(e) => setText(e.target.value)} rows={6} maxLength={20_000}
          aria-label="Nueva nota de evolución" placeholder="Escribe la nota de la sesión…" className={textareaClass} />
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
            Privada: solo yo podré verla
          </label>
          <Button variant="primary" className="ml-auto" disabled={busy || !text.trim()} onClick={() => void save()}>
            {busy ? 'Guardando…' : 'Guardar nota'}
          </Button>
        </div>
        <ErrorText>{error}</ErrorText>
      </div>

      {notes.length === 0 ? <Empty>Aún no hay notas de evolución.</Empty> : (
        <ol className="flex flex-col gap-3">
          {notes.map((n) => (
            <li key={n.id} className="rounded border p-3">
              <header className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span className="font-medium text-slate-800">{n.author_name}{n.mine && ' (tú)'}</span>
                <span>· {formatDateTime(n.created_at, s.timezone)}</span>
                {n.is_private ? <Badge tone="amber">Privada</Badge> : <Badge tone="slate">Compartida con tratantes</Badge>}
                {apptLabel(n.appointment_id) && <span>· {apptLabel(n.appointment_id)}</span>}
                {n.editable && editing !== n.id && (
                  <Button small variant="ghost" className="ml-auto" onClick={() => setEditing(n.id)}>Corregir</Button>
                )}
              </header>
              {editing === n.id
                ? <EditNote note={n} onDone={() => { setEditing(null); onChanged(); }} />
                : n.content === null
                  ? <p className="text-sm italic text-red-700">No se pudo descifrar esta nota. Avisa a soporte: puede deberse a un cambio de clave.</p>
                  : <p className="whitespace-pre-wrap text-sm leading-relaxed">{n.content}</p>}
            </li>
          ))}
        </ol>
      )}
      <p className="mt-3 text-xs text-slate-500">Las notas se pueden corregir durante 24 horas; después, se agrega una nota nueva.</p>
    </Card>
  );
}

function EditNote({ note, onDone }: { note: NoteView; onDone: () => void }) {
  const [text, setText] = useState(note.content ?? '');
  const [isPrivate, setIsPrivate] = useState(note.is_private);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setError(null);
    try { await clinicalApi.updateNote(note.id, text, isPrivate); onDone(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <div className="flex flex-col gap-2">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} className={textareaClass} aria-label="Corregir nota" />
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} /> Privada</label>
        <Button small className="ml-auto" onClick={onDone}>Cancelar</Button>
        <Button small variant="primary" disabled={busy || !text.trim()} onClick={() => void save()}>Guardar corrección</Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

// -------------------------------------------------------------- diagnósticos
function Diagnoses({ patientId, items, onChanged }: { patientId: string; items: Diagnosis[]; onChanged: () => void }) {
  const s = useSession();
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ codeSystem: 'CIE-10', code: '', description: '', isPrimary: items.every((d) => d.resolved_at) });
  const [error, setError] = useState<string | null>(null);
  const active = items.filter((d) => !d.resolved_at);
  const resolved = items.filter((d) => d.resolved_at);

  function pickCode(code: string) {
    const known = COMMON_CODES.find((c) => c.code === code.trim().toUpperCase());
    setF({ ...f, code, description: known && !f.description ? known.description : f.description });
  }
  async function add() {
    if (!s.professionalId) return;
    setError(null);
    try {
      await clinicalApi.addDiagnosis({ orgId: s.orgId, patientId, professionalId: s.professionalId, ...f });
      setAdding(false); setF({ codeSystem: 'CIE-10', code: '', description: '', isPrimary: false }); onChanged();
    } catch (e) { setError(errorMessage(e)); }
  }

  return (
    <Card title="Diagnósticos" actions={!adding && <Button small variant="primary" onClick={() => setAdding(true)}>+ Añadir</Button>}>
      {adding && (
        <div className="mb-3 flex flex-col gap-2 rounded border bg-slate-50 p-3">
          <div className="grid grid-cols-[110px_1fr] gap-2">
            <SelectInput label="Sistema" value={f.codeSystem} onChange={(e) => setF({ ...f, codeSystem: e.target.value })}
              options={['CIE-10', 'CIE-11', 'DSM-5-TR'].map((v) => ({ value: v, label: v }))} />
            <TextInput label="Código" list="codigos-frecuentes" value={f.code} onChange={(e) => pickCode(e.target.value)} placeholder="F41.1" />
          </div>
          <datalist id="codigos-frecuentes">
            {COMMON_CODES.map((c) => <option key={c.code} value={c.code}>{c.description}</option>)}
          </datalist>
          <TextInput label="Descripción" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isPrimary} onChange={(e) => setF({ ...f, isPrimary: e.target.checked })} /> Diagnóstico principal</label>
          <div className="flex justify-end gap-2">
            <Button small onClick={() => setAdding(false)}>Cancelar</Button>
            <Button small variant="primary" disabled={!f.code.trim() || !f.description.trim()} onClick={() => void add()}>Guardar</Button>
          </div>
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {active.length === 0 && !adding ? <Empty>Sin diagnósticos activos.</Empty> : (
        <ul className="flex flex-col gap-2 text-sm">
          {active.map((d) => (
            <li key={d.id} className="flex items-start gap-2">
              <span className="w-14 shrink-0 font-mono text-xs font-semibold leading-5">{d.code}</span>
              <span className="flex-1">{d.description}{d.is_primary && <> <Badge tone="teal">Principal</Badge></>}
                <span className="block text-xs text-slate-500">{d.code_system} · desde {formatDate(d.diagnosed_at, s.timezone)}</span></span>
              <Button small variant="ghost" onClick={() => void clinicalApi.resolveDiagnosis(d.id).then(onChanged)}>Resolver</Button>
            </li>
          ))}
        </ul>
      )}
      {resolved.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-xs text-slate-500">{resolved.length} resuelto(s)</summary>
          <ul className="mt-2 flex flex-col gap-1 text-slate-500">
            {resolved.map((d) => <li key={d.id}><span className="font-mono text-xs">{d.code}</span> {d.description} · hasta {formatDate(d.resolved_at!, s.timezone)}</li>)}
          </ul>
        </details>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- anamnesis
function Anamnesis({ patientId, record, onChanged }: { patientId: string; record: ClinicalView['record']; onChanged: () => void }) {
  const s = useSession();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(record?.anamnesis ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true); setError(null);
    try { await clinicalApi.saveAnamnesis(patientId, text); setEditing(false); onChanged(); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Card title="Anamnesis" actions={!editing && (
      <Button small onClick={() => { setText(record?.anamnesis || ANAMNESIS_TEMPLATE); setEditing(true); }}>{record?.anamnesis ? 'Editar' : 'Escribir'}</Button>
    )}>
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={12} className={textareaClass} aria-label="Anamnesis" />
          <div className="flex justify-end gap-2">
            <Button small onClick={() => setEditing(false)}>Cancelar</Button>
            <Button small variant="primary" disabled={busy} onClick={() => void save()}>{busy ? 'Guardando…' : 'Guardar'}</Button>
          </div>
          <ErrorText>{error}</ErrorText>
        </div>
      ) : record?.anamnesis_unreadable ? (
        <p className="text-sm italic text-red-700">No se pudo descifrar la anamnesis.</p>
      ) : record?.anamnesis ? (
        <>
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{record.anamnesis}</p>
          <p className="mt-2 text-xs text-slate-500">Actualizada {formatDate(record.updated_at, s.timezone)}</p>
        </>
      ) : <Empty>Sin anamnesis registrada.</Empty>}
    </Card>
  );
}
