// Lista de pacientes con búsqueda y alta. El formulario se reutiliza en la ficha.
import { useEffect, useState, type FormEvent } from 'react';
import { useSession } from '../../lib/session';
import { isDemo } from '../../lib/supabase';
import { onDemoChange } from '../../demo/store';
import { go } from '../../lib/router';
import { Badge, Button, Empty, ErrorText, errorMessage, Loading, Modal, SelectInput, TextInput } from '../../ui';
import { DOC_TYPES, patientsApi, type Insurer, type Patient, type PatientInput } from './api';

export default function Patients() {
  const s = useSession();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Patient[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const load = () => patientsApi.list(s.orgId, q).then(setRows).catch((e) => setError(errorMessage(e)));
    const t = setTimeout(load, 200);
    const off = isDemo ? onDemoChange(load) : undefined;
    return () => { clearTimeout(t); off?.(); };
  }, [q, s.orgId]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <h1 className="mr-auto text-lg font-semibold">Pacientes</h1>
        <div className="w-72"><TextInput label="Buscar" placeholder="Nombre, documento o teléfono" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {/* Solo admin/recepción: RLS no deja a un profesional leer un paciente sin cita con él */}
        {s.isStaff && <Button variant="primary" onClick={() => setCreating(true)}>+ Nuevo paciente</Button>}
      </div>
      {s.isProfessional && !s.isStaff && (
        <p className="text-xs text-slate-500">Ves solo a los pacientes que tienen o tuvieron cita contigo.</p>
      )}
      <ErrorText>{error}</ErrorText>
      {!rows ? <Loading /> : rows.length === 0 ? <Empty>No hay pacientes que coincidan.</Empty> : (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr><th className="px-3 py-2">Nombre</th><th className="px-3 py-2">Documento</th><th className="px-3 py-2">Teléfono</th><th className="px-3 py-2">WhatsApp</th></tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="cursor-pointer border-t hover:bg-slate-50" onClick={() => go(`/pacientes/${p.id}`)}>
                  <td className="px-3 py-2 font-medium text-teal-800">{p.full_name}</td>
                  <td className="px-3 py-2 tabular-nums">{p.doc_type} {p.doc_number}</td>
                  <td className="px-3 py-2 tabular-nums">{p.phone_e164 ?? '—'}</td>
                  <td className="px-3 py-2">{p.whatsapp_opt_in ? <Badge tone="green">Autorizado</Badge> : <Badge tone="amber">Sin autorización</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <PatientFormModal title="Nuevo paciente" onClose={() => setCreating(false)}
          onSubmit={async (input) => { const p = await patientsApi.create(s.orgId, input); go(`/pacientes/${p.id}`); }} />
      )}
    </div>
  );
}

/** Normaliza un teléfono a E.164: "300 123 4567" en Colombia → "+573001234567". */
export function toE164(raw: string, countryCode: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits;
  const prefix: Record<string, string> = { CO: '57', ES: '34', MX: '52', PE: '51', CL: '56', AR: '54' };
  return digits.length <= 10 && prefix[countryCode] ? `+${prefix[countryCode]}${digits}` : `+${digits}`;
}

export function PatientFormModal({ title, initial, onClose, onSubmit }: {
  title: string; initial?: Patient; onClose: () => void; onSubmit: (input: PatientInput) => Promise<void>;
}) {
  const s = useSession();
  const [insurers, setInsurers] = useState<Insurer[]>([]);
  const [f, setF] = useState({
    doc_type: initial?.doc_type ?? 'CC', doc_number: initial?.doc_number ?? '', full_name: initial?.full_name ?? '',
    birth_date: initial?.birth_date ?? '', sex: initial?.sex ?? '', phone: initial?.phone_e164 ?? '', email: initial?.email ?? '',
    address: initial?.address ?? '', insurer_id: initial?.insurer_id ?? '',
    ec_name: initial?.emergency_contact?.name ?? '', ec_phone: initial?.emergency_contact?.phone ?? '',
    consent_given: Boolean(initial?.data_consent_at), whatsapp_opt_in: initial?.whatsapp_opt_in ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  useEffect(() => { patientsApi.insurers(s.orgId).then(setInsurers).catch(() => setInsurers([])); }, [s.orgId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const phone = toE164(f.phone, s.countryCode);
    if (phone && !/^\+[1-9]\d{6,14}$/.test(phone)) { setError('Teléfono inválido.'); return; }
    if (!/^[A-Za-z0-9.\s-]{3,24}$/.test(f.doc_number)) { setError('Número de documento inválido.'); return; }
    setBusy(true); setError(null);
    try {
      await onSubmit({
        doc_type: f.doc_type, doc_number: f.doc_number, full_name: f.full_name.trim().replace(/\s+/g, ' '),
        birth_date: f.birth_date || null, sex: f.sex || null, phone_e164: phone, email: f.email.trim() || null,
        address: f.address.trim() || null, insurer_id: f.insurer_id || null,
        emergency_contact: f.ec_name.trim() ? { name: f.ec_name.trim(), phone: toE164(f.ec_phone, s.countryCode) ?? '' } : null,
        consent_given: f.consent_given, whatsapp_opt_in: f.whatsapp_opt_in,
      });
      onClose();
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  return (
    <Modal title={title} onClose={onClose} wide footer={<>
      <Button onClick={onClose}>Cancelar</Button>
      <Button variant="primary" type="submit" form="patient-form" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</Button>
    </>}>
      <form id="patient-form" onSubmit={submit} className="grid gap-3 md:grid-cols-2">
        <SelectInput label="Tipo de documento" value={f.doc_type} onChange={set('doc_type')} options={DOC_TYPES} />
        <TextInput label="Número de documento" required value={f.doc_number} onChange={set('doc_number')} />
        <div className="md:col-span-2"><TextInput label="Nombre completo" required minLength={3} value={f.full_name} onChange={set('full_name')} /></div>
        <TextInput label="Fecha de nacimiento" type="date" value={f.birth_date} onChange={set('birth_date')} />
        <SelectInput label="Sexo" value={f.sex} onChange={set('sex')} options={[{ value: '', label: '—' }, { value: 'F', label: 'Femenino' }, { value: 'M', label: 'Masculino' }, { value: 'X', label: 'Otro / prefiere no decir' }]} />
        <TextInput label="Teléfono (WhatsApp)" type="tel" placeholder="300 123 4567" value={f.phone} onChange={set('phone')} />
        <TextInput label="Correo" type="email" value={f.email} onChange={set('email')} />
        <TextInput label="Dirección" value={f.address} onChange={set('address')} />
        <SelectInput label="EPS / convenio" value={f.insurer_id} onChange={set('insurer_id')}
          options={[{ value: '', label: 'Particular' }, ...insurers.map((i) => ({ value: i.id, label: i.name }))]} />
        <TextInput label="Contacto de emergencia" value={f.ec_name} onChange={set('ec_name')} />
        <TextInput label="Teléfono de emergencia" type="tel" value={f.ec_phone} onChange={set('ec_phone')} />
        <div className="flex flex-col gap-2 rounded border bg-slate-50 p-3 text-sm md:col-span-2">
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={f.consent_given} disabled={Boolean(initial?.data_consent_at)}
              onChange={(e) => setF({ ...f, consent_given: e.target.checked })} className="mt-0.5" />
            <span>El paciente autorizó el tratamiento de sus datos personales y de salud (Habeas Data / RGPD).
              {initial?.data_consent_at && <span className="text-slate-500"> Ya registrado.</span>}</span>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={f.whatsapp_opt_in} disabled={!f.consent_given}
              onChange={(e) => setF({ ...f, whatsapp_opt_in: e.target.checked })} className="mt-0.5" />
            <span>Acepta recibir recordatorios y mensajes de la clínica por WhatsApp.</span>
          </label>
        </div>
      </form>
      <div className="mt-3"><ErrorText>{error}</ErrorText></div>
    </Modal>
  );
}
