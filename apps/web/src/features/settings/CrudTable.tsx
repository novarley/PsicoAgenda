// Tabla de mantenimiento genérica: lista + alta/edición en un modal a partir de una
// definición de columnas. Sirve para sedes, servicios, EPS, profesionales, horarios…
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useSession } from '../../lib/session';
import { isDemo } from '../../lib/supabase';
import { onDemoChange } from '../../demo/store';
import { zonedToUtc, formatDateTime } from '../../lib/time';
import { Badge, Button, Empty, ErrorText, errorMessage, formatMoney, Loading, Modal, SelectInput, TextInput } from '../../ui';
import { settingsApi, type AnyRow, type CatalogTable } from './api';

export interface Column {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'money' | 'select' | 'bool' | 'time' | 'datetime';
  options?: { value: string; label: string }[];
  required?: boolean;
  hint?: string;
  hideInTable?: boolean;
  /** Solo informativa: se muestra en la tabla pero no se edita. */
  formHidden?: boolean;
  render?: (row: AnyRow) => ReactNode;
}

interface Props {
  table: CatalogTable;
  title: string;
  columns: Column[];
  defaults?: Record<string, unknown>;
  filter?: Record<string, string>;
  /** Catálogos con historial (citas) no se borran: se desactivan con la columna "active". */
  softDelete?: boolean;
  emptyText?: string;
  validate?: (row: Record<string, unknown>) => string | null;
}

export default function CrudTable({ table, title, columns, defaults = {}, filter, softDelete, emptyText, validate }: Props) {
  const s = useSession();
  const [rows, setRows] = useState<AnyRow[] | null>(null);
  const [editing, setEditing] = useState<AnyRow | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filterKey = JSON.stringify(filter ?? {});

  const load = useCallback(() => {
    settingsApi.list(table, s.orgId, JSON.parse(filterKey)).then(setRows).catch((e) => setError(errorMessage(e)));
  }, [table, s.orgId, filterKey]);
  useEffect(() => { load(); return isDemo ? onDemoChange(load) : undefined; }, [load]);

  async function remove(row: AnyRow) {
    setError(null);
    try {
      if (softDelete) await settingsApi.update(table, row.id, { active: !row.active });
      else if (confirm('¿Eliminar este registro?')) await settingsApi.remove(table, row.id);
      load();
    } catch (e) { setError(errorMessage(e)); }
  }

  const visible = columns.filter((c) => !c.hideInTable);
  return (
    <section className="rounded-lg border bg-white">
      <header className="flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="font-semibold">{title}</h2>
        <Button variant="primary" small onClick={() => setEditing('new')}>+ Añadir</Button>
      </header>
      <div className="p-2">
        <ErrorText>{error}</ErrorText>
        {!rows ? <Loading /> : rows.length === 0 ? <Empty>{emptyText ?? 'Aún no hay registros.'}</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>{visible.map((c) => <th key={c.key} className="px-2 py-1.5">{c.label}</th>)}<th /></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`border-t ${softDelete && r.active === false ? 'opacity-50' : ''}`}>
                    {visible.map((c) => <td key={c.key} className="px-2 py-1.5">{c.render ? c.render(r) : display(c, r[c.key], s.currency, s.timezone)}</td>)}
                    <td className="whitespace-nowrap px-2 py-1.5 text-right">
                      <Button small variant="ghost" onClick={() => setEditing(r)}>Editar</Button>
                      <Button small variant="ghost" onClick={() => void remove(r)}>
                        {softDelete ? (r.active === false ? 'Activar' : 'Desactivar') : 'Eliminar'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {editing && (
        <RowForm title={editing === 'new' ? `Añadir · ${title}` : `Editar · ${title}`} columns={columns} validate={validate}
          initial={editing === 'new' ? { ...defaults, ...filter } : editing}
          onClose={() => setEditing(null)}
          onSave={async (row) => {
            if (editing === 'new') await settingsApi.insert(table, s.orgId, { ...defaults, ...filter, ...row });
            else await settingsApi.update(table, editing.id, row);
            load();
          }} />
      )}
    </section>
  );
}

function display(c: Column, v: unknown, currency: string, tz: string): ReactNode {
  if (v === null || v === undefined || v === '') return <span className="text-slate-400">—</span>;
  switch (c.type) {
    case 'money': return formatMoney(Number(v), currency);
    case 'bool': return v ? <Badge tone="green">Sí</Badge> : <Badge tone="slate">No</Badge>;
    case 'select': return c.options?.find((o) => o.value === String(v))?.label ?? String(v);
    case 'time': return String(v).slice(0, 5);
    case 'datetime': return formatDateTime(String(v), tz);
    default: return String(v);
  }
}

/** ISO UTC → valor de <input type="datetime-local"> en la zona de la clínica. */
function toLocalInput(iso: string, tz: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function RowForm({ title, columns: allColumns, initial, onClose, onSave, validate }: {
  title: string; columns: Column[]; initial: Record<string, unknown>; onClose: () => void;
  onSave: (row: Record<string, unknown>) => Promise<void>; validate?: (row: Record<string, unknown>) => string | null;
}) {
  const s = useSession();
  const columns = allColumns.filter((c) => !c.formHidden);
  const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries(columns.map((c) => {
    const v = initial[c.key];
    if (c.type === 'bool') return [c.key, v === undefined ? true : Boolean(v)];
    if (c.type === 'money') return [c.key, v == null ? '' : String(Number(v) / 100)];
    if (c.type === 'time') return [c.key, v == null ? '' : String(v).slice(0, 5)];
    if (c.type === 'datetime') return [c.key, v ? toLocalInput(String(v), s.timezone) : ''];
    return [c.key, v == null ? '' : String(v)];
  })));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const row: Record<string, unknown> = {};
    for (const c of columns) {
      const v = values[c.key];
      if (c.type === 'bool') row[c.key] = Boolean(v);
      else if (v === '') row[c.key] = null;
      else if (c.type === 'number') row[c.key] = Number(v);
      else if (c.type === 'money') row[c.key] = Math.round(Number(v) * 100);
      else if (c.type === 'datetime') { const [d, t] = String(v).split('T'); row[c.key] = zonedToUtc(d, t, s.timezone); }
      else row[c.key] = v;
    }
    const problem = validate?.(row);
    if (problem) { setError(problem); return; }
    setBusy(true); setError(null);
    try { await onSave(row); onClose(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  return (
    <Modal title={title} onClose={onClose} footer={<>
      <Button onClick={onClose}>Cancelar</Button>
      <Button variant="primary" type="submit" form="row-form" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</Button>
    </>}>
      <form id="row-form" onSubmit={submit} className="grid gap-3">
        {columns.map((c) => {
          const v = values[c.key];
          const set = (val: string | boolean) => setValues({ ...values, [c.key]: val });
          if (c.type === 'bool') {
            return (
              <label key={c.key} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={Boolean(v)} onChange={(e) => set(e.target.checked)} /> {c.label}
              </label>
            );
          }
          if (c.type === 'select') {
            return <SelectInput key={c.key} label={c.label} hint={c.hint} required={c.required} value={String(v)} onChange={(e) => set(e.target.value)}
              options={[...(c.required ? [] : [{ value: '', label: '—' }]), ...(c.options ?? [])]} />;
          }
          const inputTypes: Record<string, string> = { number: 'number', money: 'number', time: 'time', datetime: 'datetime-local' };
          const inputType = inputTypes[c.type ?? ''] ?? 'text';
          return <TextInput key={c.key} label={c.type === 'money' ? `${c.label} (${s.currency})` : c.label} hint={c.hint}
            required={c.required} type={inputType} step={c.type === 'money' ? '100' : undefined} min={c.type === 'number' || c.type === 'money' ? 0 : undefined}
            value={String(v)} onChange={(e) => set(e.target.value)} />;
        })}
      </form>
      <div className="mt-3"><ErrorText>{error}</ErrorText></div>
    </Modal>
  );
}
