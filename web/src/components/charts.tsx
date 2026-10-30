import { Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtClock } from '../lib/format';

export const SERIES = {
  s1: '#3987e5',
  s2: '#d95926',
  s3: '#199e70',
  s4: '#c98500',
  s5: '#d55181',
  s7: '#9085e9',
  bad: '#e66767',
  grid: '#2c2c29',
  axis: '#8b8a82',
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

/** Single-axis time series; shows a legend on top when there are ≥2 series. */
export function TimeChart({ data, series, height = 200, format, xKey = 't', xFormat = fmtClock, area, refY, refX, yDomain }: Props) {
  const Chart = area ? AreaChart : LineChart;
  return (
    <div>
      {series.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-3.5 rounded" style={{ background: s.color, opacity: s.dashed ? 0.7 : 1 }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <Chart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={SERIES.grid} strokeDasharray="0" vertical={false} />
            <XAxis dataKey={xKey} tickFormatter={xFormat} stroke={SERIES.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={{ stroke: SERIES.grid }} minTickGap={40} />
            <YAxis stroke={SERIES.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={64} tickFormatter={format} domain={yDomain ?? [0, 'auto']} />
            <Tooltip content={<ChartTooltip series={series} format={format} xFormat={xFormat} />} cursor={{ stroke: SERIES.axis, strokeWidth: 1 }} isAnimationActive={false} />
            {refY?.map((r) => (
              <ReferenceLine key={r.label} y={r.value} stroke={SERIES.bad} strokeDasharray="4 4" label={{ value: r.label, fill: SERIES.bad, fontSize: 10, position: 'insideBottomRight' }} />
            ))}
            {refX?.map((r) => (
              <ReferenceLine key={r.label} x={r.value} stroke={SERIES.bad} strokeDasharray="4 4" label={{ value: r.label, fill: SERIES.bad, fontSize: 10, position: 'insideTopRight' }} />
            ))}
            {series.map((s) =>
              area ? (
                <Area key={s.key} type="monotone" dataKey={s.key} stroke={s.color} fill={s.color} fillOpacity={0.12} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
              ) : (
                <Line key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? '5 4' : undefined} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#161615' }} isAnimationActive={false} connectNulls />
              ),
            )}
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
