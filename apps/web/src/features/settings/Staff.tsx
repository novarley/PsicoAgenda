// Personal de la clínica: lista, roles e invitación por correo.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSession } from '../../lib/session';
import { isDemo } from '../../lib/supabase';
import { onDemoChange } from '../../demo/store';
import { Badge, Button, Card, ErrorText, errorMessage, Loading, Modal, ROLE_LABEL, SelectInput, SPECIALTY_LABEL, TextInput } from '../../ui';
import { settingsApi, type StaffMember } from './api';

export default function Staff() {
  const s = useSession();
  const [rows, setRows] = useState<StaffMember[] | null>(null);
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    settingsApi.staff(s.orgId).then(setRows).catch((e) => setError(errorMessage(e)));
  }, [s.orgId]);
  useEffect(() => { load(); return isDemo ? onDemoChange(load) : undefined; }, [load]);

  async function removeRole(m: StaffMember, role: string) {
    if (!confirm(`¿Quitar el rol "${ROLE_LABEL[role]}" a ${m.full_name ?? m.email}?`)) return;
    setError(null);
    try { await settingsApi.removeRole(s.orgId, m.user_id, role); load(); } catch (e) { setError(errorMessage(e)); }
  }

  return (
    <Card title="Personal" actions={<Button variant="primary" small onClick={() => setInviting(true)}>+ Invitar</Button>}>
      <ErrorText>{error}</ErrorText>
      {notice && <p className="mb-2 rounded bg-green-50 px-3 py-2 text-sm text-green-900">{notice}</p>}
      {!rows ? <Loading /> : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500"><tr><th className="py-1.5">Nombre</th><th>Correo</th><th>Roles</th></tr></thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.user_id} className="border-t">
                <td className="py-2 font-medium">{m.full_name ?? '—'}{m.user_id === s.userId && <span className="text-xs text-slate-500"> (tú)</span>}</td>
                <td className="text-slate-600">{m.email ?? '—'}</td>
                <td className="flex flex-wrap gap-1 py-2">
                  {m.roles.map((r) => (
                    <span key={r} className="inline-flex items-center gap-1">
                      <Badge tone={r === 'admin' ? 'teal' : r === 'professional' ? 'blue' : 'slate'}>{ROLE_LABEL[r]}</Badge>
                      <button onClick={() => void removeRole(m, r)} aria-label={`Quitar rol ${ROLE_LABEL[r]}`} className="text-xs text-slate-400 hover:text-red-600">✕</button>
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-3 text-xs text-slate-500">
        Recepción ve agenda, pacientes y la bandeja de WhatsApp. Un profesional ve solo su agenda y a sus pacientes.
        Administración ve además métricas y configuración, pero no el contenido clínico.
      </p>
      {inviting && <InviteModal onClose={() => setInviting(false)} onDone={(msg) => { setNotice(msg); load(); }} />}
    </Card>
  );
}

function InviteModal({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const s = useSession();
  const [f, setF] = useState({ email: '', fullName: '', role: 'receptionist', specialty: 'psychology', licenseNumber: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const r = await settingsApi.invite({
      orgId: s.orgId, email: f.email.trim(), fullName: f.fullName.trim(), role: f.role,
      ...(f.role === 'professional' ? { specialty: f.specialty, licenseNumber: f.licenseNumber.trim() } : {}),
    });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    onDone(r.invited ? `Invitación enviada a ${f.email}. Entrará con el enlace del correo.` : `${f.fullName} ya tenía cuenta: se le añadió el rol.`);
    onClose();
  }

  return (
    <Modal title="Invitar a una persona" onClose={onClose} footer={<>
      <Button onClick={onClose}>Cancelar</Button>
      <Button variant="primary" type="submit" form="invite-form" disabled={busy}>{busy ? 'Enviando…' : 'Enviar invitación'}</Button>
    </>}>
      <form id="invite-form" onSubmit={submit} className="grid gap-3">
        <TextInput label="Nombre completo" required minLength={3} value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
        <TextInput label="Correo" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <SelectInput label="Rol" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}
          options={Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label }))} />
        {f.role === 'professional' && (
          <>
            <SelectInput label="Especialidad" value={f.specialty} onChange={(e) => setF({ ...f, specialty: e.target.value })}
              options={Object.entries(SPECIALTY_LABEL).map(([value, label]) => ({ value, label }))} />
            <TextInput label="Tarjeta profesional / nº colegiado" value={f.licenseNumber} onChange={(e) => setF({ ...f, licenseNumber: e.target.value })} />
          </>
        )}
      </form>
      <div className="mt-3"><ErrorText>{error}</ErrorText></div>
    </Modal>
  );
}
