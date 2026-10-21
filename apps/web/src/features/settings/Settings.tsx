// Configuración de la clínica (solo administración).
import { useEffect, useState, type FormEvent } from 'react';
import { useSession, useSessionState } from '../../lib/session';
import { go } from '../../lib/router';
import { Button, Card, ErrorText, errorMessage, formatMoney, Loading, SelectInput, SPECIALTY_LABEL, TextInput } from '../../ui';
import CrudTable from './CrudTable';
import Schedules from './Schedules';
import Staff from './Staff';
import { settingsApi, type OrgSettings } from './api';

const SECTIONS = [
  ['organizacion', 'Organización'], ['sedes', 'Sedes'], ['servicios', 'Servicios'], ['convenios', 'EPS y convenios'],
  ['profesionales', 'Profesionales'], ['horarios', 'Horarios'], ['personal', 'Personal'],
] as const;

const SPECIALTIES = Object.entries(SPECIALTY_LABEL).map(([value, label]) => ({ value, label }));

export default function Settings({ section = 'organizacion' }: { section?: string }) {
  const s = useSession();
  return (
    <div className="grid gap-4 md:grid-cols-[200px_1fr]">
      <nav className="flex gap-1 overflow-x-auto md:flex-col" aria-label="Secciones de configuración">
        {SECTIONS.map(([key, label]) => (
          <button key={key} onClick={() => go(`/configuracion/${key}`)}
            className={`whitespace-nowrap rounded px-3 py-1.5 text-left text-sm ${section === key ? 'bg-teal-700 text-white' : 'hover:bg-slate-100'}`}>
            {label}
          </button>
        ))}
      </nav>
      <div className="min-w-0">
        {section === 'organizacion' && <OrganizationForm />}
        {section === 'sedes' && (
          <CrudTable table="sites" title="Sedes" softDelete defaults={{ is_virtual: false, active: true }} columns={[
            { key: 'name', label: 'Nombre', required: true },
            { key: 'address', label: 'Dirección' },
            { key: 'is_virtual', label: 'Terapia en línea', type: 'bool' },
          ]} />
        )}
        {section === 'servicios' && (
          <CrudTable table="services" title="Servicios" softDelete defaults={{ active: true, deposit_percent: 0, duration_minutes: 50 }} columns={[
            { key: 'name', label: 'Nombre', required: true },
            { key: 'specialty', label: 'Especialidad', type: 'select', required: true, options: SPECIALTIES },
            { key: 'duration_minutes', label: 'Duración (min)', type: 'number', required: true },
            { key: 'price_cents', label: 'Precio', type: 'money', required: true, render: (r) => formatMoney(Number(r.price_cents), s.currency) },
            { key: 'deposit_percent', label: 'Anticipo', type: 'select', required: true,
              hint: 'Se cobra al reservar por WhatsApp para reducir inasistencias.',
              options: [{ value: '0', label: 'Sin anticipo' }, { value: '50', label: '50 %' }, { value: '100', label: '100 %' }] },
          ]} />
        )}
        {section === 'convenios' && (
          <CrudTable table="insurers" title="EPS, prepagadas y convenios" softDelete defaults={{ active: true }} columns={[
            { key: 'name', label: 'Nombre', required: true },
            { key: 'kind', label: 'Tipo', type: 'select', required: true, options: [
              { value: 'eps', label: 'EPS' }, { value: 'prepagada', label: 'Prepagada' }, { value: 'convenio', label: 'Convenio' },
              { value: 'aseguradora', label: 'Aseguradora' }, { value: 'particular', label: 'Particular' }] },
            { key: 'code', label: 'Código' },
          ]} />
        )}
        {section === 'profesionales' && (
          <CrudTable table="professionals" title="Profesionales" softDelete defaults={{ active: true }} columns={[
            { key: 'full_name', label: 'Nombre', required: true },
            { key: 'specialty', label: 'Especialidad', type: 'select', required: true, options: SPECIALTIES },
            { key: 'license_number', label: 'Tarjeta profesional' },
            { key: 'phone_e164', label: 'Teléfono', hint: 'Formato internacional: +573001234567' },
            { key: 'user_id', label: 'Acceso al panel', formHidden: true,
              render: (r) => (r.user_id ? 'Sí' : 'No · invítalo en Personal') },
          ]} />
        )}
        {section === 'horarios' && <Schedules />}
        {section === 'personal' && <Staff />}
      </div>
    </div>
  );
}

function OrganizationForm() {
  const s = useSession();
  const { reload } = useSessionState();
  const [org, setOrg] = useState<OrgSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { settingsApi.getOrg(s.orgId).then(setOrg).catch((e) => setError(errorMessage(e))); }, [s.orgId]);
  if (!org) return error ? <ErrorText>{error}</ErrorText> : <Loading />;

  const set = (patch: Partial<OrgSettings>) => { setOrg({ ...org, ...patch }); setSaved(false); };
  const setSetting = (k: string, v: unknown) => set({ settings: { ...org.settings, [k]: v } });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!org) return;
    if (org.on_call_phone_e164 && !/^\+[1-9]\d{6,14}$/.test(org.on_call_phone_e164)) { setError('El teléfono de guardia debe ir en formato +573001234567.'); return; }
    setBusy(true); setError(null);
    try {
      await settingsApi.updateOrg(s.orgId, {
        name: org.name.trim(), timezone: org.timezone, currency: org.currency,
        wa_phone_number_id: org.wa_phone_number_id || null, wa_display_phone: org.wa_display_phone || null,
        on_call_phone_e164: org.on_call_phone_e164 || null,
        crisis_lines: org.crisis_lines.filter((l) => l.name.trim() && l.phone.trim()), settings: org.settings,
      });
      setSaved(true);
      reload();
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Card title="Datos de la clínica">
        <div className="grid gap-3 md:grid-cols-2">
          <TextInput label="Nombre" required value={org.name} onChange={(e) => set({ name: e.target.value })} />
          <SelectInput label="Zona horaria" value={org.timezone} onChange={(e) => set({ timezone: e.target.value })}
            hint="Todas las horas de la agenda y del bot se muestran en esta zona."
            options={['America/Bogota', 'America/Mexico_City', 'America/Lima', 'America/Santiago', 'America/Argentina/Buenos_Aires', 'Europe/Madrid', 'Atlantic/Canary']
              .map((z) => ({ value: z, label: z }))} />
          <SelectInput label="Moneda" value={org.currency} onChange={(e) => set({ currency: e.target.value })}
            options={['COP', 'EUR', 'MXN', 'PEN', 'CLP', 'ARS', 'USD'].map((c) => ({ value: c, label: c }))} />
          <TextInput label="Horas mínimas para cancelar sin perder la sesión del bono" type="number" min={0}
            value={String(org.settings.late_cancel_hours ?? 24)} onChange={(e) => setSetting('late_cancel_hours', Number(e.target.value))} />
          <div className="md:col-span-2">
            <TextInput label="URL de la política de privacidad" type="url" value={String(org.settings.privacy_policy_url ?? '')}
              onChange={(e) => setSetting('privacy_policy_url', e.target.value)} hint="El bot la enlaza al pedir el consentimiento." />
          </div>
        </div>
      </Card>

      <Card title="WhatsApp">
        <div className="grid gap-3 md:grid-cols-2">
          <TextInput label="Phone number ID (Meta)" value={org.wa_phone_number_id ?? ''} onChange={(e) => set({ wa_phone_number_id: e.target.value })}
            hint="Está en developers.facebook.com → tu app → WhatsApp → Configuración de la API." />
          <TextInput label="Número visible" value={org.wa_display_phone ?? ''} onChange={(e) => set({ wa_display_phone: e.target.value })} />
        </div>
      </Card>

      <Card title="Protocolo de crisis">
        <div className="grid gap-3">
          <TextInput label="Teléfono del profesional de guardia" value={org.on_call_phone_e164 ?? ''} placeholder="+573001234567"
            onChange={(e) => set({ on_call_phone_e164: e.target.value.replace(/\s/g, '') })}
            hint="Recibe un aviso por WhatsApp cuando el bot detecta riesgo. Debe haberle escrito al número de la clínica en las últimas 24 h." />
          <p className="text-sm font-medium text-slate-700">Líneas de ayuda que el bot envía al paciente</p>
          {org.crisis_lines.map((l, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="flex-1"><TextInput label="Nombre" value={l.name} onChange={(e) => set({ crisis_lines: org.crisis_lines.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} /></div>
              <div className="w-36"><TextInput label="Teléfono" value={l.phone} onChange={(e) => set({ crisis_lines: org.crisis_lines.map((x, j) => (j === i ? { ...x, phone: e.target.value } : x)) })} /></div>
              <Button type="button" variant="ghost" onClick={() => set({ crisis_lines: org.crisis_lines.filter((_, j) => j !== i) })} aria-label="Quitar línea">✕</Button>
            </div>
          ))}
          <Button type="button" small className="self-start" onClick={() => set({ crisis_lines: [...org.crisis_lines, { name: '', phone: '' }] })}>+ Añadir línea</Button>
          <p className="text-xs text-slate-500">Verifica las líneas vigentes con la secretaría de salud de tu ciudad.</p>
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <Button variant="primary" type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Guardar cambios'}</Button>
        {saved && <span className="text-sm text-green-700">Guardado.</span>}
        <ErrorText>{error}</ErrorText>
      </div>
    </form>
  );
}
