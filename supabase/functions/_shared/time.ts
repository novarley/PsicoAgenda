// Regla del proyecto: en BD y entre módulos solo viajan instantes ISO-8601 en UTC.
// La zona horaria de la organización se aplica únicamente al mostrar texto al paciente.

const LOCALE = 'es-CO';

/** Fecha local (YYYY-MM-DD) de un instante en la zona IANA dada. */
export function localDateKey(instant: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(instant));
}

/** Suma días a una fecha YYYY-MM-DD sin pasar por la zona local del servidor. */
export function addDaysToKey(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "jue 23 oct" — cabe en el título de una fila de lista (24 car.). */
export function formatDayShort(dateKey: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short',
  }).format(new Date(`${dateKey}T12:00:00Z`)).replace(/\./g, '');
}

/** "08:00" en hora local de la organización. */
export function formatTime(instant: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(instant));
}

/** "jueves, 23 de octubre · 08:00" */
export function formatDateTimeLong(instant: Date | string, timeZone: string): string {
  const day = new Intl.DateTimeFormat(LOCALE, {
    timeZone, weekday: 'long', day: 'numeric', month: 'long',
  }).format(new Date(instant));
  return `${day} · ${formatTime(instant, timeZone)}`;
}
