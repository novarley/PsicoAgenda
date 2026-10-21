// Ficha del paciente: datos, historial de citas, bonos y documentos.
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../lib/session';
import { isDemo } from '../../lib/supabase';
import { onDemoChange } from '../../demo/store';
import { go } from '../../lib/router';
import { formatDate, formatDateTime } from '../../lib/time';
import { APPOINTMENT_STATUS, Badge, Button, Card, Empty, ErrorText, errorMessage, Loading, SelectInput } from '../../ui';
import type { AgendaAppointment } from '../agenda/api';
import { DOC_TYPES, DOCUMENT_KINDS, patientsApi, type Bono, type Insurer, type Patient, type PatientDocument } from './api';
import { PatientFormModal } from './Patients';
import ClinicalRecord from '../clinical/ClinicalRecord';

type Tab = 'datos' | 'citas' | 'bonos' | 'documentos' | 'historia';

export default function PatientDetail({ id, initialTab, appointmentId }: { id: string; initialTab?: string; appointmentId?: string }) {
  const s = useSession();
  const [p, setP] = useState<Patient | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>(initialTab === 'historia' && s.isProfessional ? 'historia' : 'datos');
  const [editing, setEditing] = useState(false);
  const [appts, setAppts] = useState<AgendaAppointment[]>([]);
  const [bonos, setBonos] = useState<Bono[]>([]);
  const [docs, setDocs] = useState<PatientDocument[]>([]);
  const [insurers, setInsurers] = useState<Insurer[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([patientsApi.get(id), patientsApi.appointments(id), patientsApi.bonos(id), patientsApi.documents(id), patientsApi.insurers(s.orgId)])
      .then(([pat, a, b, d, i]) => { setP(pat); setAppts(a); setBonos(b); setDocs(d); setInsurers(i); })
      .catch((e) => setError(errorMessage(e)));
  }, [id, s.orgId]);
  useEffect(() => { load(); return isDemo ? onDemoChange(load) : undefined; }, [load]);

  if (p === undefined) return <Loading />;
  if (p === null) return <Card><Empty>No encontré este paciente o no tienes acceso a su ficha.</Empty></Card>;

  const age = p.birth_date ? Math.floor((Date.now() - new Date(`${p.birth_date}T12:00:00Z`).getTime()) / 31_557_600_000) : null;
  const attended = appts.filter((a) => a.status === 'completed').length;
  const noShows = appts.filter((a) => a.status === 'no_show').length;
  const tabs: [Tab, string][] = [['datos', 'Datos'], ['citas', `Citas (${appts.length})`], ['bonos', `Bonos (${bonos.length})`], ['documentos', `Documentos (${docs.length})`]];
  if (s.isProfessional) tabs.push(['historia', 'Historia clínica']);

  return (
    <div className="flex flex-col gap-3">
      <button onClick={() => go('/pacientes')} className="self-start text-sm text-teal-800 hover:underline">← Pacientes</button>
      <header className="flex flex-wrap items-start gap-3 rounded-lg border bg-white p-4">
        <div className="mr-auto">
          <h1 className="text-xl font-semibold">{p.full_name}</h1>
          <p className="text-sm text-slate-600">
            {DOC_TYPES.find((d) => d.value === p.doc_type)?.label ?? p.doc_type} {p.doc_number}
            {age !== null && <> · {age} años</>} · {insurers.find((i) => i.id === p.insurer_id)?.name ?? 'Particular'}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {p.data_consent_at ? <Badge tone="green">Consentimiento de datos registrado</Badge> : <Badge tone="red">Sin consentimiento de datos</Badge>}
            {p.whatsapp_opt_in ? <Badge tone="green">Recibe WhatsApp</Badge> : <Badge tone="amber">No recibe WhatsApp</Badge>}
            {appts.length > 0 && <Badge tone="slate">{attended} atendidas · {noShows} inasistencias</Badge>}
          </div>
        </div>
        <Button onClick={() => setEditing(true)}>Editar datos</Button>
      </header>

      <nav className="flex flex-wrap gap-1 border-b text-sm" role="tablist">
        {tabs.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-3 py-2 ${tab === key ? 'border-teal-700 font-medium text-teal-800' : 'border-transparent text-slate-600'}`}>
            {label}
          </button>
        ))}
      </nav>
      <ErrorText>{error}</ErrorText>

      {tab === 'datos' && (
        <Card>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {[
              ['Teléfono', p.phone_e164], ['Correo', p.email], ['Dirección', p.address],
              ['Fecha de nacimiento', p.birth_date ? formatDate(`${p.birth_date}T12:00:00Z`, 'UTC') : null],
              ['Sexo', { F: 'Femenino', M: 'Masculino', X: 'Otro' }[p.sex ?? ''] ?? null],
              ['Contacto de emergencia', p.emergency_contact ? `${p.emergency_contact.name} · ${p.emergency_contact.phone}` : null],
              ['Consentimiento', p.data_consent_at ? formatDateTime(p.data_consent_at, s.timezone) : 'Pendiente'],
              ['Paciente desde', formatDate(p.created_at, s.timezone)],
            ].map(([k, v]) => (
              <div key={k as string} className="flex flex-col"><dt className="text-xs text-slate-500">{k}</dt><dd>{v || '—'}</dd></div>
            ))}
          </dl>
        </Card>
      )}

      {tab === 'citas' && (
        <Card>
          {appts.length === 0 ? <Empty>Sin citas todavía.</Empty> : (
            <ul className="divide-y text-sm">
              {appts.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <span className="w-44 tabular-nums">{formatDateTime(a.starts_at, s.timezone)}</span>
                  <span className="flex-1">{a.service_name} · {a.modality === 'online' ? 'En línea' : a.site_name}</span>
                  <Badge tone={APPOINTMENT_STATUS[a.status]?.tone}>{APPOINTMENT_STATUS[a.status]?.label ?? a.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === 'bonos' && (
        <Card>
          {bonos.length === 0 ? <Empty>El paciente no tiene bonos.</Empty> : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {bonos.map((b) => {
                const left = b.sessions_total - b.sessions_used;
                return (
                  <li key={b.id} className="rounded border p-3 text-sm">
                    <div className="flex items-center justify-between"><strong>{b.plan_name}</strong>
                      <Badge tone={b.status === 'active' ? 'green' : 'slate'}>{b.status === 'active' ? 'Activo' : b.status === 'exhausted' ? 'Agotado' : b.status}</Badge></div>
                    <div className="mt-2 h-2 overflow-hidden rounded bg-slate-100" aria-hidden>
                      <div className="h-full bg-teal-600" style={{ width: `${(b.sessions_used / b.sessions_total) * 100}%` }} />
                    </div>
                    <p className="mt-1 text-xs text-slate-600">{b.sessions_used} de {b.sessions_total} usadas · quedan <strong>{left}</strong>
                      {b.expires_at && <> · vence {formatDate(b.expires_at, s.timezone)}</>}</p>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-500">La venta de bonos desde el panel llega en la siguiente iteración.</p>
        </Card>
      )}

      {tab === 'documentos' && <Documents patientId={p.id} docs={docs} onChanged={load} />}

      {tab === 'historia' && <ClinicalRecord patientId={p.id} appointments={appts} appointmentId={appointmentId} />}

      {editing && (
        <PatientFormModal title="Editar paciente" initial={p} onClose={() => setEditing(false)}
          onSubmit={async (input) => { await patientsApi.update(p.id, input, Boolean(p.data_consent_at)); load(); }} />
      )}
    </div>
  );
}

function Documents({ patientId, docs, onChanged }: { patientId: string; docs: PatientDocument[]; onChanged: () => void }) {
  const s = useSession();
  const [kind, setKind] = useState('referral');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true); setError(null);
    try { await patientsApi.upload(s.orgId, patientId, file, kind); onChanged(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function open(path: string) {
    const url = await patientsApi.documentUrl(path).catch((e) => { setError(errorMessage(e)); return null; });
    if (url) window.open(url, '_blank', 'noopener');
    else if (isDemo) setError('En modo demo los documentos no tienen archivo real.');
  }

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="w-56"><SelectInput label="Tipo" value={kind} onChange={(e) => setKind(e.target.value)}
          options={Object.entries(DOCUMENT_KINDS).map(([value, label]) => ({ value, label }))} /></div>
        <label className={`cursor-pointer rounded bg-teal-700 px-3 py-1.5 text-sm font-medium text-white ${busy ? 'opacity-40' : ''}`}>
          {busy ? 'Subiendo…' : 'Subir archivo'}
          <input type="file" className="sr-only" disabled={busy} accept=".pdf,image/*" onChange={(e) => void upload(e.target.files?.[0])} />
        </label>
        <span className="text-xs text-slate-500">PDF o imagen, máx. 10 MB. Se guarda en un bucket privado.</span>
      </div>
      <ErrorText>{error}</ErrorText>
      {docs.length === 0 ? <Empty>Sin documentos.</Empty> : (
        <ul className="divide-y text-sm">
          {docs.map((d) => (
            <li key={d.id} className="flex items-center gap-3 py-2">
              <Badge tone="slate">{DOCUMENT_KINDS[d.kind] ?? d.kind}</Badge>
              <span className="flex-1 truncate">{d.storage_path.split('/').pop()}</span>
              <span className="text-xs text-slate-500">{formatDate(d.created_at, s.timezone)}</span>
              <Button small onClick={() => void open(d.storage_path)}>Abrir</Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
