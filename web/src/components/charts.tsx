import { createContext, useContext, useId, useMemo, useState, type ReactNode } from 'react';
import { Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ZoomOut } from 'lucide-react';
import { fmtClock } from '../lib/format';
import { t } from '../lib/i18n';
import { cx } from './ui';

export const SERIES = {
  // CSS variables, so charts follow the light/dark theme without re-rendering
  s1: 'var(--color-s1)',
  s2: 'var(--color-s2)',
  s3: 'var(--color-s3)',
  s4: 'var(--color-s4)',
  s5: 'var(--color-s5)',
  s7: 'var(--color-s7)',
  bad: 'var(--color-bad)',
  grid: 'var(--color-line)',
  axis: 'var(--color-ink-3)',
};

export interface SeriesDef {
  key: string;
  label: string;
  color: string;
  dashed?: boolean;
}

interface Props {
  data: any[];
  series: SeriesDef[];
  height?: number;
  format?: (v: number) => string;
  xKey?: string;
  xFormat?: (v: number) => string;
  area?: boolean;
  refY?: { value: number; label: string }[];
  refX?: { value: number; label: string }[];
  yDomain?: [number | string, number | string];
}

type Range = [number, number];
interface Group {
  syncId: string;
  zoom: Range | null;
  setZoom: (r: Range | null) => void;
}
const GroupCtx = createContext<Group | null>(null);

/**
 * Charts inside a group share the hover line (same moment in every chart) and the zoom range:
 * drag across one chart to zoom all of them, double-click or "Reset zoom" to go back.
 */
export function ChartGroup({ children }: { children: ReactNode }) {
  const syncId = useId();
  const [zoom, setZoom] = useState<Range | null>(null);
  const value = useMemo(() => ({ syncId, zoom, setZoom }), [syncId, zoom]);
  return <GroupCtx.Provider value={value}>{children}</GroupCtx.Provider>;
}

function ChartTooltip({ active, payload, label, series, format, xFormat }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-line-strong bg-surface-2 px-2.5 py-2 text-xs shadow-lg">
      <div className="mb-1 text-ink-3">{xFormat ? xFormat(label) : label}</div>
      {series.map((s: SeriesDef) => {
        const p = payload.find((x: any) => x.dataKey === s.key);
        if (!p || p.value === null || p.value === undefined) return null;
        return (
          <div key={s.key} className="flex items-center gap-2">
            <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} />
            <span className="text-ink-2">{s.label}</span>
            <span className="tabular ml-auto pl-3 font-medium text-ink">{format ? format(p.value) : p.value}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Single-axis time series. Legend items toggle their series; drag to zoom, double-click to reset. */
export function TimeChart({ data, series, height = 200, format, xKey = 't', xFormat = fmtClock, area, refY, refX, yDomain }: Props) {
  const Chart = area ? AreaChart : LineChart;
  const group = useContext(GroupCtx);
  const [ownZoom, setOwnZoom] = useState<Range | null>(null);
  const zoom = group ? group.zoom : ownZoom;
  const setZoom = group ? group.setZoom : setOwnZoom;
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const view = useMemo(() => (zoom ? data.filter((d) => d[xKey] >= zoom[0] && d[xKey] <= zoom[1]) : data), [data, zoom, xKey]);
  const xAt = (s: any): number | undefined => {
    const i = Number(s?.activeTooltipIndex);
    return Number.isInteger(i) ? view[i]?.[xKey] : undefined;
  };
  const endDrag = () => {
    if (drag && drag.a !== drag.b) setZoom([Math.min(drag.a, drag.b), Math.max(drag.a, drag.b)]);
    setDrag(null);
  };
  const toggle = (key: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(key)) next.delete(key);
      else if (next.size < series.length - 1) next.add(key); // keep at least one series visible
      return next;
    });
  const shown = series.filter((s) => !hidden.has(s.key));

  return (
    <div>
      {(series.length > 1 || zoom) && (
        <div className="mb-2 flex items-start gap-2">
          <div className="flex flex-1 flex-wrap gap-x-1 gap-y-1 text-xs">
            {series.length > 1 &&
              series.map((s) => {
                const off = hidden.has(s.key);
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => toggle(s.key)}
                    aria-pressed={!off}
                    title={off ? t('Show {name}', { name: s.label }) : t('Hide {name}', { name: s.label })}
                    className={cx('inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors hover:bg-surface-2', off ? 'text-ink-3 line-through opacity-60' : 'text-ink-2')}
                  >
                    <span className="inline-block h-0.5 w-3.5 rounded" style={{ background: s.color, opacity: s.dashed ? 0.7 : 1 }} />
                    {s.label}
                  </button>
                );
              })}
          </div>
          {zoom && (
            <button type="button" onClick={() => setZoom(null)} className="inline-flex shrink-0 items-center gap-1 rounded border border-line px-1.5 py-0.5 text-xs text-ink-2 hover:bg-surface-2 hover:text-ink">
              <ZoomOut className="size-3" /> {t('Reset zoom')}
            </button>
          )}
        </div>
      )}
      <div style={{ height }} className="cursor-crosshair select-none [&_*]:outline-none" title={zoom ? undefined : t('Drag across the chart to zoom in')}>
        <ResponsiveContainer width="100%" height="100%">
          <Chart
            data={view}
            margin={{ top: 6, right: 8, bottom: 0, left: 0 }}
            syncId={group?.syncId}
            syncMethod="value"
            onMouseDown={(s: any) => {
              const x = xAt(s);
              if (x !== undefined) setDrag({ a: x, b: x });
            }}
            onMouseMove={(s: any) => {
              const x = xAt(s);
              if (drag && x !== undefined) setDrag({ ...drag, b: x });
            }}
            onMouseUp={endDrag}
            onMouseLeave={() => drag && endDrag()}
            onDoubleClick={() => setZoom(null)}
          >
            <CartesianGrid stroke={SERIES.grid} strokeDasharray="0" vertical={false} />
            <XAxis dataKey={xKey} tickFormatter={xFormat} stroke={SERIES.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={{ stroke: SERIES.grid }} minTickGap={40} />
            <YAxis stroke={SERIES.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={64} tickFormatter={format} domain={yDomain ?? [0, 'auto']} />
            <Tooltip content={<ChartTooltip series={shown} format={format} xFormat={xFormat} />} cursor={{ stroke: SERIES.axis, strokeWidth: 1, strokeDasharray: '3 3' }} isAnimationActive={false} />
            {refY?.map((r) => (
              <ReferenceLine key={r.label} y={r.value} stroke={SERIES.bad} strokeDasharray="4 4" label={{ value: r.label, fill: SERIES.bad, fontSize: 10, position: 'insideBottomRight' }} />
            ))}
            {refX?.map((r) => (
              <ReferenceLine key={r.label} x={r.value} stroke={SERIES.bad} strokeDasharray="4 4" label={{ value: r.label, fill: SERIES.bad, fontSize: 10, position: 'insideTopRight' }} />
            ))}
            {shown.map((s) =>
              area ? (
                <Area key={s.key} type="monotone" dataKey={s.key} stroke={s.color} fill={s.color} fillOpacity={0.12} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--color-surface)' }} isAnimationActive={false} connectNulls />
              ) : (
                <Line key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? '5 4' : undefined} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--color-surface)' }} isAnimationActive={false} connectNulls />
              ),
            )}
            {drag && drag.a !== drag.b && <ReferenceArea x1={Math.min(drag.a, drag.b)} x2={Math.max(drag.a, drag.b)} fill="var(--color-accent)" fillOpacity={0.12} stroke="var(--color-accent)" strokeOpacity={0.4} />}
          </Chart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Load-shape preview chart for profiles. */
export function StagePreview({ points, unit }: { points: { t: number; v: number }[]; unit: string }) {
  return <TimeChart data={points} series={[{ key: 'v', label: unit, color: SERIES.s1 }]} height={140} area xKey="t" format={(v) => `${Math.round(v)}`} />;
}
