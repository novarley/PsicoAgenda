// Gráfico de columnas de UNA serie, en SVG y sin dependencias.
// Specs: barra <= 24 px, extremo de datos redondeado 4 px y base recta, cuadrícula de
// 1 px continua y discreta, etiqueta directa solo en la última barra, tooltip en
// hover/foco con área de impacto de toda la banda, y vista de tabla alternativa.
import { useState } from 'react';

export interface Datum { key: string; label: string; value: number }

interface Props {
  title: string;
  data: Datum[];
  format: (v: number) => string;
  /** Línea de referencia (p. ej. meta del 5 % de ausentismo). */
  target?: { value: number; label: string };
  height?: number;
}

const W = 560;
const PAD = { top: 18, right: 12, bottom: 28, left: 70 };
const COLOR = '#0d9488';            // teal-600, validado contra la superficie clara
const GRID = '#e2e8f0';             // slate-200
const INK_MUTED = '#64748b';        // slate-500

/** Columna con las dos esquinas superiores redondeadas (extremo de datos) y la base recta. */
function columnPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / exp / 2) * 2 * exp;
}

export default function BarChart({ title, data, format, target, height = 220 }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const max = niceMax(Math.max(...data.map((d) => d.value), target?.value ?? 0));
  const innerW = W - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const band = innerW / Math.max(data.length, 1);
  const barW = Math.min(24, band * 0.6);
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const ticks = [0, max / 2, max];

  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-slate-800">{title}</span>
        <button onClick={() => setAsTable(!asTable)} className="text-xs text-teal-800 hover:underline">
          {asTable ? 'Ver gráfico' : 'Ver tabla'}
        </button>
      </figcaption>

      {asTable ? (
        <table className="text-sm">
          <thead className="text-left text-xs text-slate-500"><tr><th className="py-1">Mes</th><th className="text-right">Valor</th></tr></thead>
          <tbody>{data.map((d) => <tr key={d.key} className="border-t"><td className="py-1">{d.label}</td><td className="text-right tabular-nums">{format(d.value)}</td></tr>)}</tbody>
        </table>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${height}`} className="h-auto w-full" role="img" aria-label={`${title}. ${data.map((d) => `${d.label}: ${format(d.value)}`).join('; ')}`}>
            {ticks.filter((t) => !target || Math.abs(y(t) - y(target.value)) > 14).map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
                <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={INK_MUTED}>{format(t)}</text>
              </g>
            ))}
            {target && (
              <g>
                <line x1={PAD.left} x2={W - PAD.right} y1={y(target.value)} y2={y(target.value)} stroke="#334155" strokeWidth={1} />
                {/* En el margen del eje: fuera del área de barras, nunca la tapa una columna */}
                <text x={PAD.left - 6} y={y(target.value)} dy="0.32em" textAnchor="end" fontSize={11} fontWeight={600} fill="#334155">{target.label}</text>
              </g>
            )}
            {data.map((d, i) => {
              const cx = PAD.left + band * i + band / 2;
              const h = Math.max(0, PAD.top + innerH - y(d.value));
              const isLast = i === data.length - 1;
              return (
                <g key={d.key}>
                  <path d={columnPath(cx - barW / 2, y(d.value), barW, h)} fill={COLOR} opacity={hover === null || hover === i ? 1 : 0.55} />
                  <text x={cx} y={height - PAD.bottom + 16} textAnchor="middle" fontSize={11} fill={INK_MUTED}>{d.label}</text>
                  {isLast && (
                    <text x={cx} y={y(d.value) - 6} textAnchor="middle" fontSize={11} fontWeight={600} fill="#0f172a"
                      stroke="#ffffff" strokeWidth={3} paintOrder="stroke">{format(d.value)}</text>
                  )}
                  {/* Área de impacto: toda la banda, más grande que la barra */}
                  <rect x={PAD.left + band * i} y={PAD.top} width={band} height={innerH} fill="transparent" tabIndex={0}
                    onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                    aria-label={`${d.label}: ${format(d.value)}`} />
                </g>
              );
            })}
          </svg>
          {hover !== null && data[hover] && (
            <div className="pointer-events-none absolute -translate-x-1/2 rounded border bg-white px-2 py-1 text-xs shadow"
              style={{ left: `${((PAD.left + band * hover + band / 2) / W) * 100}%`, top: 0 }}>
              <span className="text-slate-500">{data[hover].label}</span> · <strong className="tabular-nums">{format(data[hover].value)}</strong>
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
