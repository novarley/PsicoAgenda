// Agenda del día por profesional: citas, huecos libres, nueva cita y cambios de estado.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from '../../lib/session';
import { isDemo, supabase } from '../../lib/supabase';
import { onDemoChange } from '../../demo/store';
import { go } from '../../lib/router';
import { addDays, formatDayLong, formatTime, todayKey } from '../../lib/time';
import {
  APPOINTMENT_STATUS, Badge, Button, Empty, ErrorText, errorMessage, formatMoney, Loading, Modal, SelectInput, TextInput,
} from '../../ui';
import { agendaApi, type AgendaAppointment, type Catalog, type PatientHit, type Slot } from './api';

type Prefill = { professionalId?: string; siteId?: string; dateKey: string; startsAt?: string };

export default function Agenda() {
  const s = useSession();
  const [dateKey, setDateKey] = useState(() => todayKey(s.timezone));
  const [profFilter, setProfFilter] = useState<string>(s.isProfessional && !s.isStaff ? s.professionalId ?? '' : '');
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [appts, setAppts] = useState<AgendaAppointment[] | null>(null);
  const [free, setFree] = useState<Record<string, Slot[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AgendaAppointment | null>(null);
  const [creating, setCreating] = useState<Prefill | null>(null);

  // Un profesional sin rol de recepción solo ve su propia columna
  const onlyOwn = s.isProfessional && !s.isStaff;
  const columns = useMemo(() => (catalog?.professionals ?? [])
    .filter((p) => (onlyOwn ? p.id === s.professionalId : !profFilter || p.id === profFilter)), [catalog, onlyOwn, profFilter, s.professionalId]);

  useEffect(() => {
    agendaApi.catalog(s.orgId).then(setCatalog).catch((e) => setError(errorMessage(e)));
  }, [s.orgId]);

  const load = useCallback(async () => {
    if (!catalog) return;
    try {
      setError(null);
      setAppts(await agendaApi.day(s.orgId, dateKey, s.timezone));
      const entries = await Promise.all(columns.map(async (p) => [p.id, await agendaApi.slots(s.orgId, p.id, null, dateKey)] as const));
      setFree(Object.fromEntries(entries));
    } catch (e) { setError(errorMessage(e)); }
  }, [catalog, columns, dateKey, s.orgId, s.timezone]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (isDemo) return onDemoChange(() => void load());
    const ch = supabase.channel('agenda')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'appointments' }, () => void load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  const isToday = dateKey === todayKey(s.timezone);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex items-center gap-1">
          <Button onClick={() => setDateKey(addDays(dateKey, -1))} aria-label="Día anterior">‹</Button>
          <input type="date" value={dateKey} onChange={(e) => e.target.value && setDateKey(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1.5 text-sm" aria-label="Fecha" />
          <Button onClick={() => setDateKey(addDays(dateKey, 1))} aria-label="Día siguiente">›</Button>
          {!isToday && <Button variant="ghost" onClick={() => setDateKey(todayKey(s.timezone))}>Hoy</Button>}
        </div>
        <h1 className="mr-auto text-lg font-semibold first-letter:uppercase">{formatDayLong(dateKey)}</h1>
        {!onlyOwn && catalog && (
          <div className="w-56">
            <SelectInput label="Profesional" value={profFilter} onChange={(e) => setProfFilter(e.target.value)}
              options={[{ value: '', label: 'Todos' }, ...catalog.professionals.map((p) => ({ value: p.id, label: p.name }))]} />
          </div>
        )}
        <Button variant="primary" onClick={() => setCreating({ dateKey, professionalId: columns.length === 1 ? columns[0].id : undefined })}>
          + Nueva cita
        </Button>
      </div>

      <ErrorText>{error}</ErrorText>
      {!appts || !catalog ? <Loading /> : (
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(260px, 1fr))` }}>
          {columns.map((p) => {
            const mine = appts.filter((a) => a.professional_id === p.id);
            const items = [
              ...mine.map((a) => ({ kind: 'appt' as const, at: a.starts_at, a })),
              ...(free[p.id] ?? []).map((slot) => ({ kind: 'free' as const, at: slot.starts_at, slot })),
            ].sort((x, y) => x.at.localeCompare(y.at));
            const active = mine.filter((a) => a.status !== 'cancelled').length;
            return (
              <section key={p.id} className="flex flex-col rounded-lg border bg-white">
                <header className="border-b px-3 py-2">
                  <h2 className="font-semibold">{p.name}</h2>
                  <p className="text-xs text-slate-500">{active} cita(s) · {(free[p.id] ?? []).length} hueco(s) libre(s)</p>
                </header>
                <ul className="flex flex-col gap-1.5 p-2">
                  {items.length === 0 && <li><Empty>Sin horario publicado este día.</Empty></li>}
                  {items.map((it) => it.kind === 'appt' ? (
                    <li key={it.a.id}>
                      <button onClick={() => setSelected(it.a)}
                        className={`w-full rounded border px-2.5 py-1.5 text-left text-sm hover:border-teal-600 ${it.a.status === 'cancelled' ? 'opacity-50' : ''}`}>
                        <span className="flex items-center justify-between gap-2">
                          <span className="font-medium tabular-nums">{formatTime(it.a.starts_at, s.timezone)}</span>
                          <Badge tone={APPOINTMENT_STATUS[it.a.status]?.tone}>{APPOINTMENT_STATUS[it.a.status]?.label ?? it.a.status}</Badge>
                        </span>
                        <span className="block truncate">{it.a.patient_name}</span>
                        <span className="block truncate text-xs text-slate-500">
                          {it.a.service_name} · {it.a.modality === 'online' ? 'En línea' : it.a.site_name}
                        </span>
                      </button>
                    </li>
                  ) : (
                    <li key={`free-${it.slot.starts_at}`}>
                      <button onClick={() => setCreating({ professionalId: p.id, siteId: it.slot.site_id, dateKey, startsAt: it.slot.starts_at })}
                        className="w-full rounded border border-dashed border-slate-300 px-2.5 py-1 text-left text-xs text-slate-500 hover:border-teal-600 hover:text-teal-800">
                        <span className="tabular-nums">{formatTime(it.slot.starts_at, s.timezone)}</span> · Libre — agendar
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {selected && <AppointmentModal appt={selected} onClose={() => setSelected(null)} onChanged={() => { setSelected(null); void load(); }} />}
      {creating && catalog && <NewAppointmentModal catalog={catalog} prefill={creating} onClose={() => setCreating(null)} onBooked={() => void load()} />}
    </div>
  );
}

// -----------------------------------------------------------------------------
function AppointmentModal({ appt, onClose, onChanged }: { appt: AgendaAppointment; onClose: () => void; onChanged: () => void }) {
  const s = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isPast = new Date(appt.starts_at) < new Date();
  const deposit = Math.round(appt.service_price_cents * appt.service_deposit_percent / 100);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await action(); onChanged(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  const can = (to: string) => ({
    confirmed: ['scheduled'].includes(appt.status),
    completed: ['scheduled', 'confirmed'].includes(appt.status) && isPast,
    no_show: ['scheduled', 'confirmed'].includes(appt.status) && isPast,
    cancelled: ['pending_payment', 'scheduled', 'confirmed'].includes(appt.status) && !isPast,
  } as Record<string, boolean>)[to];

  return (
    <Modal title={`${formatTime(appt.starts_at, s.timezone)} · ${appt.patient_name}`} onClose={onClose}>
      <dl className="grid grid-cols-[120px_1fr] gap-y-1.5 text-sm">
        <dt className="text-slate-500">Estado</dt>
        <dd><Badge tone={APPOINTMENT_STATUS[appt.status]?.tone}>{APPOINTMENT_STATUS[appt.status]?.label}</Badge></dd>
        <dt className="text-slate-500">Servicio</dt><dd>{appt.service_name}</dd>
        <dt className="text-slate-500">Lugar</dt><dd>{appt.modality === 'online' ? 'En línea' : appt.site_name}</dd>
        <dt className="text-slate-500">Horario</dt><dd>{formatTime(appt.starts_at, s.timezone)} – {formatTime(appt.ends_at, s.timezone)}</dd>
        <dt className="text-slate-500">Reservada por</dt><dd>{appt.channel === 'whatsapp' ? 'WhatsApp (bot)' : 'Panel'}</dd>
        {appt.status === 'pending_payment' && appt.hold_expires_at && (
          <><dt className="text-slate-500">Anticipo</dt>
            <dd>{formatMoney(deposit, s.currency)} · el hueco se libera a las {formatTime(appt.hold_expires_at, s.timezone)}</dd></>
        )}
      </dl>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={() => go(`/pacientes/${appt.patient_id}`)}>Ver ficha</Button>
        {can('confirmed') && <Button variant="primary" disabled={busy} onClick={() => run(() => agendaApi.setStatus(appt.id, 'confirmed'))}>Confirmar</Button>}
        {can('completed') && <Button variant="primary" disabled={busy} onClick={() => run(() => agendaApi.setStatus(appt.id, 'completed'))}>Atendida</Button>}
        {can('no_show') && <Button disabled={busy} onClick={() => run(() => agendaApi.setStatus(appt.id, 'no_show'))}>No asistió</Button>}
        {can('cancelled') && <Button variant="danger" disabled={busy} onClick={() => run(() => agendaApi.setStatus(appt.id, 'cancelled'))}>Cancelar cita</Button>}
      </div>

      {s.isStaff && appt.status === 'pending_payment' && deposit > 0 && (
        <div className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="mb-2">¿El paciente pagó el anticipo en recepción?</p>
          <div className="flex gap-2">
            {(['cash', 'transfer'] as const).map((provider) => (
              <Button key={provider} small disabled={busy} onClick={() => run(() => agendaApi.recordPayment({
                orgId: s.orgId, patientId: appt.patient_id, appointmentId: appt.id, amountCents: deposit, provider, kind: 'deposit',
              }))}>Registrar {formatMoney(deposit, s.currency)} en {provider === 'cash' ? 'efectivo' : 'transferencia'}</Button>
            ))}
          </div>
        </div>
      )}
      <div className="mt-3"><ErrorText>{error}</ErrorText></div>
    </Modal>
  );
}

// -----------------------------------------------------------------------------
function NewAppointmentModal({ catalog, prefill, onClose, onBooked }: {
  catalog: Catalog; prefill: Prefill; onClose: () => void; onBooked: () => void;
}) {
  const s = useSession();
  const onlyOwn = s.isProfessional && !s.isStaff;
  const [patient, setPatient] = useState<PatientHit | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PatientHit[]>([]);
  const [professionalId, setProfessionalId] = useState(prefill.professionalId ?? (onlyOwn ? s.professionalId ?? '' : ''));
  const professional = catalog.professionals.find((p) => p.id === professionalId);
  const services = catalog.services.filter((v) => !professional || v.specialty === professional.specialty);
  const [serviceId, setServiceId] = useState('');
  const [siteId, setSiteId] = useState(prefill.siteId ?? '');
  const [dateKey, setDateKey] = useState(prefill.dateKey);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [startsAt, setStartsAt] = useState(prefill.startsAt ?? '');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!services.some((v) => v.id === serviceId)) setServiceId(services[0]?.id ?? ''); }, [services, serviceId]);
  useEffect(() => {
    const t = setTimeout(() => { agendaApi.searchPatients(s.orgId, query).then(setHits).catch(() => setHits([])); }, 200);
    return () => clearTimeout(t);
  }, [query, s.orgId]);
  useEffect(() => {
    if (!professionalId) { setSlots(null); return; }
    agendaApi.slots(s.orgId, professionalId, siteId || null, dateKey).then(setSlots).catch((e) => setError(errorMessage(e)));
  }, [professionalId, siteId, dateKey, s.orgId]);

  const slot = slots?.find((x) => x.starts_at === startsAt);
  const service = catalog.services.find((v) => v.id === serviceId);
  const site = catalog.sites.find((x) => x.id === (slot?.site_id ?? siteId));

  async function book() {
    if (!patient || !slot || !service) return;
    setBusy(true); setError(null);
    const r = await agendaApi.book({
      orgId: s.orgId, patientId: patient.id, professionalId, siteId: slot.site_id, serviceId,
      startsAt: slot.starts_at, modality: site?.is_virtual ? 'online' : 'in_person',
    });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    onBooked();
    setResult(r.status === 'pending_payment'
      ? `Cita reservada. Falta el anticipo de ${formatMoney(r.deposit_cents, s.currency)}: el hueco se guarda 30 minutos.`
      : 'Cita agendada. El paciente recibirá los recordatorios por WhatsApp.');
  }

  if (result) {
    return (
      <Modal title="Cita creada" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Listo</Button>}>
        <p className="text-sm">{result}</p>
      </Modal>
    );
  }

  return (
    <Modal title="Nueva cita" onClose={onClose} wide footer={<>
      <Button onClick={onClose}>Cancelar</Button>
      <Button variant="primary" disabled={!patient || !slot || !service || busy} onClick={() => void book()}>{busy ? 'Agendando…' : 'Agendar cita'}</Button>
    </>}>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          {patient ? (
            <div className="flex items-center justify-between rounded border bg-teal-50 px-3 py-2 text-sm">
              <span><strong>{patient.full_name}</strong> · {patient.doc_type} {patient.doc_number}</span>
              <Button small variant="ghost" onClick={() => setPatient(null)}>Cambiar</Button>
            </div>
          ) : (
            <>
              <TextInput label="Paciente" placeholder="Nombre, documento o teléfono" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
              <ul className="max-h-48 overflow-y-auto rounded border">
                {hits.length === 0 && <li className="p-2 text-xs text-slate-500">Sin resultados. Créalo en Pacientes.</li>}
                {hits.map((h) => (
                  <li key={h.id}>
                    <button onClick={() => setPatient(h)} className="w-full px-3 py-1.5 text-left text-sm hover:bg-slate-50">
                      {h.full_name} <span className="text-xs text-slate-500">· {h.doc_type} {h.doc_number}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {!onlyOwn && (
            <SelectInput label="Profesional" value={professionalId} onChange={(e) => { setProfessionalId(e.target.value); setStartsAt(''); }}
              options={[{ value: '', label: 'Elige…' }, ...catalog.professionals.map((p) => ({ value: p.id, label: p.name }))]} />
          )}
          <SelectInput label="Servicio" value={serviceId} onChange={(e) => setServiceId(e.target.value)}
            options={services.map((v) => ({ value: v.id, label: `${v.name} · ${v.duration_minutes} min · ${formatMoney(v.price_cents, s.currency)}` }))} />
          <SelectInput label="Sede" value={siteId} onChange={(e) => { setSiteId(e.target.value); setStartsAt(''); }}
            options={[{ value: '', label: 'Cualquiera' }, ...catalog.sites.map((x) => ({ value: x.id, label: x.name }))]} />
        </div>

        <div className="flex flex-col gap-2">
          <TextInput label="Fecha" type="date" value={dateKey} onChange={(e) => { if (e.target.value) { setDateKey(e.target.value); setStartsAt(''); } }} />
          <p className="text-sm font-medium text-slate-700">Horarios libres</p>
          {!professionalId ? <p className="text-xs text-slate-500">Elige un profesional.</p>
            : !slots ? <Loading />
            : slots.length === 0 ? <p className="text-xs text-slate-500">No hay huecos libres ese día.</p>
            : (
              <div className="grid grid-cols-4 gap-1.5">
                {slots.map((x) => (
                  <button key={x.starts_at} onClick={() => setStartsAt(x.starts_at)}
                    className={`rounded border px-2 py-1 text-sm tabular-nums ${x.starts_at === startsAt ? 'border-teal-700 bg-teal-700 text-white' : 'hover:border-teal-600'}`}>
                    {formatTime(x.starts_at, s.timezone)}
                  </button>
                ))}
              </div>
            )}
          {slot && service && (
            <p className="rounded bg-slate-50 p-2 text-xs text-slate-600">
              {site?.is_virtual ? 'En línea' : site?.name} · {service.duration_minutes} min
              {service.deposit_percent > 0 && <> · anticipo del {service.deposit_percent} % ({formatMoney(service.price_cents * service.deposit_percent / 100, s.currency)})</>}
            </p>
          )}
        </div>
      </div>
      <div className="mt-3"><ErrorText>{error}</ErrorText></div>
    </Modal>
  );
}
