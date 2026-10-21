// Fechas en la zona horaria de la CLÍNICA (no la del navegador): una recepcionista
// conectada desde otro país ve la agenda igual que en la sede. En BD todo es UTC.

/** YYYY-MM-DD de un instante en la zona IANA dada. */
export function localDateKey(instant: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(instant));
}

export function todayKey(timeZone: string): string {
  return localDateKey(new Date(), timeZone);
}

export function addDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Minutos que la zona va por delante de UTC en ese instante (Bogotá: -300). */
function offsetMinutes(utcMs: number, timeZone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - utcMs) / 60_000);
}

/** "2026-10-22" + "08:00" en America/Bogota → "2026-10-22T13:00:00.000Z". Respeta horario de verano. */
export function zonedToUtc(dateKey: string, hhmm: string, timeZone: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let ts = guess - offsetMinutes(guess, timeZone) * 60_000;
  ts = guess - offsetMinutes(ts, timeZone) * 60_000;   // segunda pasada: cruces de cambio de hora
  return new Date(ts).toISOString();
}

/** [inicio, fin) del día local en UTC, para consultar la BD. */
export function dayRangeUtc(dateKey: string, timeZone: string): [string, string] {
  return [zonedToUtc(dateKey, '00:00', timeZone), zonedToUtc(addDays(dateKey, 1), '00:00', timeZone)];
}

export function formatTime(instant: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat('es-CO', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(instant));
}

export function formatDayLong(dateKey: string): string {
  return new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' })
    .format(new Date(`${dateKey}T12:00:00Z`));
}

export function formatDate(instant: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat('es-CO', { timeZone, day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(instant));
}

export function formatDateTime(instant: Date | string, timeZone: string): string {
  return `${formatDate(instant, timeZone)} · ${formatTime(instant, timeZone)}`;
}

/** "2026-10" → ["2026-10-01", "2026-10-31"] */
export function monthRange(monthKey: string): [string, string] {
  const [y, m] = monthKey.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${monthKey}-01`, `${monthKey}-${String(last).padStart(2, '0')}`];
}

export function formatMonth(monthKey: string): string {
  return new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', month: 'short', year: '2-digit' })
    .format(new Date(`${monthKey}-15T12:00:00Z`)).replace('.', '').replace(' de ', ' ');
}

export const WEEKDAYS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
