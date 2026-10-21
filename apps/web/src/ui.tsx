// Componentes de interfaz compartidos (Tailwind). Pocos y sencillos a propósito.
import { useEffect, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-teal-700 text-white hover:bg-teal-800 disabled:opacity-40',
  secondary: 'border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:opacity-40',
  ghost: 'text-teal-800 hover:bg-teal-50 disabled:opacity-40',
};

export function Button({ variant = 'secondary', small, className = '', ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; small?: boolean }) {
  return (
    <button {...props}
      className={`rounded ${small ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm'} font-medium ${VARIANTS[variant]} ${className}`} />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={id} className="font-medium text-slate-700">{label}</label>
      {children(id)}
      {hint && <span className="text-xs text-slate-500">{hint}</span>}
    </div>
  );
}

const inputClass = 'w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-sm disabled:bg-slate-100';

export function TextInput({ label, hint, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return <Field label={label} hint={hint}>{(id) => <input id={id} {...props} className={inputClass} />}</Field>;
}

export function SelectInput({ label, hint, options, ...props }: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string; hint?: string; options: { value: string; label: string }[];
}) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <select id={id} {...props} className={inputClass}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
    </Field>
  );
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border bg-white ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
          <h2 className="font-semibold">{title}</h2>
          <div className="flex gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export type Tone = 'red' | 'amber' | 'green' | 'blue' | 'slate' | 'teal';
const TONES: Record<Tone, string> = {
  red: 'bg-red-100 text-red-800', amber: 'bg-amber-100 text-amber-900', green: 'bg-green-100 text-green-800',
  blue: 'bg-sky-100 text-sky-800', slate: 'bg-slate-100 text-slate-700', teal: 'bg-teal-100 text-teal-900',
};
export function Badge({ tone = 'slate', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${TONES[tone]}`}>{children}</span>;
}

export function Modal({ title, onClose, children, footer, wide }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}
        className={`mt-10 w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} rounded-lg bg-white shadow-xl`}>
        <header className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Cerrar" className="text-slate-500 hover:text-slate-800">✕</button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto p-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t px-4 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? <p role="alert" className="text-sm text-red-700">{children}</p> : null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-slate-500">{children}</p>;
}

export function Loading() {
  return <p className="py-6 text-center text-sm text-slate-500">Cargando…</p>;
}

// ------------------------------------------------------------------ formatos
export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(cents / 100);
}

export const APPOINTMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending_payment: { label: 'Esperando anticipo', tone: 'amber' },
  scheduled: { label: 'Agendada', tone: 'blue' },
  confirmed: { label: 'Confirmada', tone: 'teal' },
  completed: { label: 'Atendida', tone: 'green' },
  no_show: { label: 'No asistió', tone: 'red' },
  cancelled: { label: 'Cancelada', tone: 'slate' },
  rescheduled: { label: 'Reagendada', tone: 'slate' },
};

export const SPECIALTY_LABEL: Record<string, string> = {
  psychology: 'Psicología', psychiatry: 'Psiquiatría', general_medicine: 'Medicina general', other: 'Otra',
};

export const ROLE_LABEL: Record<string, string> = {
  admin: 'Administración', receptionist: 'Recepción', professional: 'Profesional',
};

export const errorMessage = (e: unknown) => String((e as { message?: string })?.message ?? e);
