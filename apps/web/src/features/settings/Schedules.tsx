// Horario semanal y ausencias de cada profesional. Es lo que el bot y la agenda
// usan para calcular huecos libres (función available_slots).
import { useEffect, useState } from 'react';
import { useSession } from '../../lib/session';
import { WEEKDAYS } from '../../lib/time';
import { SelectInput } from '../../ui';
import CrudTable from './CrudTable';
import { settingsApi, type AnyRow } from './api';

export default function Schedules() {
  const s = useSession();
  const [professionals, setProfessionals] = useState<AnyRow[]>([]);
  const [sites, setSites] = useState<AnyRow[]>([]);
  const [professionalId, setProfessionalId] = useState(s.professionalId && !s.isAdmin ? s.professionalId : '');

  useEffect(() => {
    settingsApi.list('professionals', s.orgId).then((p) => {
      const active = p.filter((x) => x.active !== false);
      setProfessionals(active);
      setProfessionalId((cur) => cur || String(active[0]?.id ?? ''));
    });
    settingsApi.list('sites', s.orgId).then((x) => setSites(x.filter((r) => r.active !== false)));
  }, [s.orgId]);

  const siteOptions = sites.map((x) => ({ value: x.id, label: String(x.name) }));
  return (
    <div className="flex flex-col gap-3">
      <div className="w-72">
        <SelectInput label="Profesional" value={professionalId} onChange={(e) => setProfessionalId(e.target.value)}
          options={professionals.map((p) => ({ value: p.id, label: String(p.full_name) }))} />
      </div>
      {professionalId && (
        <>
          <CrudTable key={`rules-${professionalId}`} table="availability_rules" title="Horario semanal (hora local de la clínica)"
            filter={{ professional_id: professionalId }} defaults={{ slot_minutes: 50 }}
            emptyText="Sin horario: el bot no ofrecerá citas con este profesional."
            validate={(r) => (String(r.end_time) <= String(r.start_time) ? 'La hora de fin debe ser posterior a la de inicio.' : null)}
            columns={[
              { key: 'weekday', label: 'Día', type: 'select', required: true, options: WEEKDAYS.map((d, i) => ({ value: String(i + 1), label: d })) },
              { key: 'site_id', label: 'Sede', type: 'select', required: true, options: siteOptions },
              { key: 'start_time', label: 'Desde', type: 'time', required: true },
              { key: 'end_time', label: 'Hasta', type: 'time', required: true },
              { key: 'slot_minutes', label: 'Duración del hueco (min)', type: 'number', required: true, hint: 'Entre 10 y 240 minutos.' },
            ]} />
          <CrudTable key={`off-${professionalId}`} table="time_off" title="Ausencias y bloqueos"
            filter={{ professional_id: professionalId }} emptyText="Sin ausencias programadas."
            validate={(r) => (String(r.ends_at) <= String(r.starts_at) ? 'El fin debe ser posterior al inicio.' : null)}
            columns={[
              { key: 'starts_at', label: 'Desde', type: 'datetime', required: true },
              { key: 'ends_at', label: 'Hasta', type: 'datetime', required: true },
              { key: 'reason', label: 'Motivo', hint: 'Vacaciones, congreso, incapacidad…' },
            ]} />
        </>
      )}
    </div>
  );
}
