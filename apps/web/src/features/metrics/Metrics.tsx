// Dashboard de rendimiento: ocupación por profesional, asistencia vs ausentismo e ingresos.
import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../../lib/session';
import { formatMonth, monthRange, todayKey } from '../../lib/time';
import { Card, ErrorText, errorMessage, formatMoney, Loading, SelectInput } from '../../ui';
import BarChart from './BarChart';
import { metricsApi, shiftMonth, type MonthAttendance, type MonthRevenue, type Occupancy } from './api';

const NO_SHOW_TARGET = 5;   // objetivo del proyecto: ausentismo < 5 %

export default function Metrics() {
  const s = useSession();
  const current = todayKey(s.timezone).slice(0, 7);
  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(current, i - 5));
  const [month, setMonth] = useState(current);
  const [occupancy, setOccupancy] = useState<Occupancy[] | null>(null);
  const [attendance, setAttendance] = useState<MonthAttendance[] | null>(null);
  const [revenue, setRevenue] = useState<MonthRevenue[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([metricsApi.attendance(s.orgId, months[0]), metricsApi.revenue(s.orgId, months[0])])
      .then(([a, r]) => { setAttendance(a); setRevenue(r); })
      .catch((e) => setError(errorMessage(e)));
  }, [s.orgId, months[0]]);

  useEffect(() => {
    setOccupancy(null);
    const [from, to] = monthRange(month);
    metricsApi.occupancy(s.orgId, from, to).then(setOccupancy).catch((e) => setError(errorMessage(e)));
  }, [s.orgId, month]);

  const att = useMemo(() => new Map((attendance ?? []).map((a) => [a.month, a])), [attendance]);
  const rev = useMemo(() => new Map((revenue ?? []).map((r) => [r.month, r])), [revenue]);
  const noShowPct = (m: string) => {
    const a = att.get(m);
    const closed = (a?.attended ?? 0) + (a?.no_shows ?? 0);
    return closed ? (100 * (a?.no_shows ?? 0)) / closed : 0;
  };

  // Los gráficos empiezan en el primer mes con datos: un mes sin citas no es "0 % de ausentismo"
  const firstWithData = months.findIndex((m) => att.has(m) || rev.has(m));
  const chartMonths = firstWithData < 0 ? [] : months.slice(firstWithData);

  const sel = att.get(month);
  const selNoShow = noShowPct(month);
  const closed = (sel?.attended ?? 0) + (sel?.no_shows ?? 0);
  const totalAvail = (occupancy ?? []).reduce((m, o) => m + o.available_minutes, 0);
  const totalBooked = (occupancy ?? []).reduce((m, o) => m + o.booked_minutes, 0);
  const pct = (n: number) => `${n.toLocaleString('es-CO', { maximumFractionDigits: 1 })} %`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="mr-auto text-lg font-semibold">Métricas</h1>
        <div className="w-44">
          <SelectInput label="Mes" value={month} onChange={(e) => setMonth(e.target.value)}
            options={[...months].reverse().map((m) => ({ value: m, label: formatMonth(m) }))} />
        </div>
      </div>
      <ErrorText>{error}</ErrorText>

      {!attendance || !revenue ? <Loading /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Stat label="Citas del mes" value={String(sel?.booked ?? 0)} note={`${sel?.cancelled ?? 0} canceladas`} />
            <Stat label="Asistencia" value={closed ? pct((100 * (sel?.attended ?? 0)) / closed) : '—'} note={`${sel?.attended ?? 0} atendidas`} />
            <Stat label="Ausentismo" value={closed ? pct(selNoShow) : '—'}
              note={closed ? (selNoShow < NO_SHOW_TARGET ? `✓ Por debajo de la meta del ${NO_SHOW_TARGET} %` : `✗ Por encima de la meta del ${NO_SHOW_TARGET} %`) : 'Sin citas cerradas'}
              noteTone={closed ? (selNoShow < NO_SHOW_TARGET ? 'good' : 'bad') : undefined} />
            <Stat label="Ocupación" value={totalAvail ? pct((100 * totalBooked) / totalAvail) : '—'} note="Minutos reservados / publicados" />
            <Stat label="Ingresos" value={formatMoney(rev.get(month)?.total_cents ?? 0, s.currency)} note={`${rev.get(month)?.payments ?? 0} pagos aprobados`} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <BarChart title="Ausentismo por mes" format={(v) => pct(v)}
                target={{ value: NO_SHOW_TARGET, label: `Meta ${NO_SHOW_TARGET} %` }}
                data={chartMonths.map((m) => ({ key: m, label: formatMonth(m), value: Math.round(noShowPct(m) * 10) / 10 }))} />
              <p className="mt-2 text-xs text-slate-500">Inasistencias sobre citas que ya ocurrieron (atendidas + no asistió).</p>
            </Card>
            <Card>
              <BarChart title="Ingresos por mes" format={(v) => compactMoney(v, s.currency)}
                data={chartMonths.map((m) => ({ key: m, label: formatMonth(m), value: rev.get(m)?.total_cents ?? 0 }))} />
              <p className="mt-2 text-xs text-slate-500">Pagos aprobados: pasarela, efectivo y transferencias registradas.</p>
            </Card>
          </div>
        </>
      )}

      <Card title={`Ocupación por profesional · ${formatMonth(month)}`}>
        {!occupancy ? <Loading /> : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr><th className="py-1.5">Profesional</th><th className="w-1/2">Ocupación</th><th className="text-right">Atendidas</th><th className="text-right">No asistió</th><th className="text-right">Canceladas</th></tr>
            </thead>
            <tbody>
              {occupancy.map((o) => (
                <tr key={o.professional_id} className="border-t">
                  <td className="py-2 pr-2">{o.full_name}</td>
                  <td className="pr-3">
                    {o.occupancy_pct === null ? <span className="text-xs text-slate-400">Sin horario publicado</span> : (
                      <div className="flex items-center gap-2">
                        <div className="h-3 flex-1 rounded-r bg-slate-100" aria-hidden>
                          <div className="h-full rounded-r bg-teal-600" style={{ width: `${Math.min(100, o.occupancy_pct)}%` }} />
                        </div>
                        <span className="w-14 text-right tabular-nums">{pct(o.occupancy_pct)}</span>
                      </div>
                    )}
                  </td>
                  <td className="text-right tabular-nums">{o.attended}</td>
                  <td className="text-right tabular-nums">{o.no_shows}</td>
                  <td className="text-right tabular-nums">{o.cancelled}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value, note, noteTone }: { label: string; value: string; note?: string; noteTone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-lg border bg-white p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold tabular-nums">{value}</p>
      {note && <p className={`mt-0.5 text-xs ${noteTone === 'good' ? 'text-green-800' : noteTone === 'bad' ? 'text-red-800' : 'text-slate-500'}`}>{note}</p>}
    </div>
  );
}

function compactMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(cents / 100);
}
