import { useEffect, useRef, useState } from 'react';
import { Cpu, Database, HardDrive, MemoryStick, Server } from 'lucide-react';
import { api, errorText } from '../lib/api';
import { statusLabel } from '../lib/constants';
import { t } from '../lib/i18n';
import { fmtBytes, fmtDuration, fmtNum } from '../lib/format';
import { Badge, Button, Card, Field, Loading, NumberInput, PageHeader, Select, Stat, useLoad, useToast } from '../components/ui';
import { SERIES, TimeChart } from '../components/charts';

function Meter({ value, max, label }: { value: number; max: number | null; label?: string }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  const tone = pct > 90 ? 'bg-bad' : pct > 75 ? 'bg-warn' : 'bg-accent';
  return (
    <div>
      {label && <div className="mb-1 text-xs text-ink-3">{label}</div>}
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${max ? pct : 0}%` }} />
      </div>
    </div>
  );
}

export default function SystemPage() {
  const toast = useToast();
  const { data, loading, reload } = useLoad(() => api.get('/api/system'), [], 5000);
  // short in-browser history: CPU/RAM per node
  const hist = useRef<Record<string, { t: number; cpu: number | null; mem: number }[]>>({});
  const [, force] = useState(0);
  useEffect(() => {
    if (!data) return;
    const now = Math.round(Date.now() / 1000);
    for (const n of data.nodes) {
      const arr = (hist.current[n.id] ??= []);
      if (arr.at(-1)?.t === now) continue;
      arr.push({ t: now, cpu: n.container?.cpuPct ?? n.processCpuPct, mem: (n.container?.memoryBytes ?? n.processRss) / 1024 / 1024 });
      if (arr.length > 120) arr.shift();
    }
    force((x) => x + 1);
  }, [data]);

  const [days, setDays] = useState<number | undefined>(30);
  const [mode, setMode] = useState('metrics');
  const [retention, setRetention] = useState<{ metricsRetentionDays: number; runsRetentionDays: number } | null>(null);
  useEffect(() => {
    if (data && !retention) setRetention(data.settings);
  }, [data, retention]);

  if (loading && !data) return <Loading />;
  if (!data) return null;
  const pg = data.postgres;
  const rd = data.redis;
  const totalRuns = Object.values<number>(data.runs).reduce((a, b) => a + b, 0);

  return (
    <>
      <PageHeader title={t('System resources')} subtitle={t('How much CPU, memory and storage LoadLab itself uses (refreshes every 5 s)')} />

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={t('Database size')} value={fmtBytes(pg.dbSizeBytes)} sub={t('{n} metric rows', { n: fmtNum(data.metricRows) })} />
        <Stat label={t('Redis memory')} value={fmtBytes(rd.usedMemoryBytes)} sub={t('peak {peak} · {n} keys', { peak: fmtBytes(rd.peakMemoryBytes), n: fmtNum(rd.keys) })} />
        <Stat label={t('Disk (work dir)')} value={data.disk ? fmtBytes(data.disk.totalBytes - data.disk.freeBytes) : '—'} sub={data.disk ? t('{free} free of {total}', { free: fmtBytes(data.disk.freeBytes), total: fmtBytes(data.disk.totalBytes) }) : undefined} />
        <Stat label={t('Run records')} value={fmtNum(totalRuns)} sub={Object.entries(data.runs).map(([k, v]) => `${statusLabel(k)}: ${v}`).join(' · ')} />
      </div>

      <Card title={<span className="inline-flex items-center gap-2"><Server className="size-4 text-accent" /> {t('Services')}</span>} className="mb-4" pad={false}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-3">
                <th className="px-4 py-2 font-medium">{t('Node')}</th>
                <th className="px-4 py-2 font-medium">{t('Role')}</th>
                <th className="px-4 py-2 font-medium">CPU</th>
                <th className="px-4 py-2 font-medium">{t('Memory')}</th>
                <th className="px-4 py-2 font-medium">{t('k6 process')}</th>
                <th className="px-4 py-2 font-medium">{t('Status')}</th>
              </tr>
            </thead>
            <tbody>
              {data.nodes.map((n: any) => {
                const cpu = n.container?.cpuPct ?? n.processCpuPct;
                const cores = n.container?.cpuLimitCores ?? n.cpus;
                const mem = n.container?.memoryBytes ?? n.processRss;
                const memMax = n.container?.memoryLimitBytes ?? n.hostMemTotal;
                return (
                  <tr key={n.id} className="border-b border-line/60 align-top">
                    <td className="px-4 py-2.5">
                      <div className="font-mono text-xs">{n.hostname}</div>
                      <div className="text-[11px] text-ink-3">
                        {t('up {d}', { d: fmtDuration(n.uptimeSec) })}
                        {n.k6Version ? ` · ${n.k6Version.split(' ').slice(0, 2).join(' ')}` : ''}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone={n.role === 'worker' ? 'accent' : 'neutral'}>{n.role === 'worker' ? t('load generator') : t('API / dashboard')}</Badge>
                    </td>
                    <td className="w-48 px-4 py-2.5">
                      <div className="tabular mb-1 text-xs">
                        {cpu != null ? Math.round(cpu) : '—'}% <span className="text-ink-3">/ {t('{n} cores', { n: fmtNum(cores, 1) })}</span>
                      </div>
                      <Meter value={cpu ?? 0} max={cores * 100} />
                    </td>
                    <td className="w-48 px-4 py-2.5">
                      <div className="tabular mb-1 text-xs">
                        {fmtBytes(mem)} <span className="text-ink-3">/ {fmtBytes(memMax)}</span>
                      </div>
                      <Meter value={mem} max={memMax} />
                    </td>
                    <td className="px-4 py-2.5 text-xs text-ink-2">
                      {n.activeRun ? (
                        <>
                          <div className="truncate">{n.activeRun.name}</div>
                          {n.k6 && (
                            <div className="tabular text-ink-3">
                              {t('peak CPU {cpu}% · RAM {ram}', { cpu: n.k6.maxCpuPct, ram: fmtBytes(n.k6.maxRssBytes) })}
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">{n.online ? <Badge tone="good">{t('online')}</Badge> : <Badge tone="bad">{t('not responding')}</Badge>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card title={<span className="inline-flex items-center gap-2"><Cpu className="size-4 text-accent" /> {t('CPU % (this session)')}</span>}>
          <NodeChart hist={hist.current} field="cpu" format={(v) => `${Math.round(v)}%`} />
        </Card>
        <Card title={<span className="inline-flex items-center gap-2"><MemoryStick className="size-4 text-accent" /> {t('Memory MB (this session)')}</span>}>
          <NodeChart hist={hist.current} field="mem" format={(v) => `${Math.round(v)} MB`} />
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={<span className="inline-flex items-center gap-2"><Database className="size-4 text-accent" /> {t('PostgreSQL tables')}</span>} pad={false}>
          <div className="border-b border-line px-4 py-2 text-xs text-ink-3">
            {pg.version} · {t('{n} connections', { n: pg.connections })}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {pg.tables.map((tb: any) => (
                  <tr key={tb.name} className="border-b border-line/60">
                    <td className="px-4 py-1.5 font-mono text-xs">{tb.name}</td>
                    <td className="tabular px-4 py-1.5 text-right text-xs text-ink-3">{t('~{n} rows', { n: fmtNum(tb.rows) })}</td>
                    <td className="tabular px-4 py-1.5 text-right">{fmtBytes(tb.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-2 text-xs text-ink-3">
            Redis {rd.version} · {t('{n} clients', { n: rd.connectedClients })} · {t('{n} ops/s', { n: rd.opsPerSec })} · {rd.maxMemoryBytes ? t('limit {v}', { v: fmtBytes(rd.maxMemoryBytes) }) : t('no memory limit')}
          </div>
        </Card>

        <Card title={<span className="inline-flex items-center gap-2"><HardDrive className="size-4 text-accent" /> {t('Retention & cleanup')}</span>}>
          <div className="space-y-5">
            <div>
              <p className="mb-2 text-sm text-ink-3">
                {t('Per-second metrics are the largest data in the database (a 1-hour test ≈ 3,600 rows). Summaries, step stats and capacity results are never deleted; baseline runs are kept.')}
              </p>
              {retention && (
                <div className="flex flex-wrap items-end gap-3">
                  <Field label={t('Keep per-second metrics (days)')} hint={t('0 = forever')}>
                    <NumberInput className="w-32" value={retention.metricsRetentionDays} onChange={(v) => setRetention({ ...retention, metricsRetentionDays: v ?? 0 })} />
                  </Field>
                  <Field label={t('Keep whole runs (days)')} hint={t('0 = forever')}>
                    <NumberInput className="w-32" value={retention.runsRetentionDays} onChange={(v) => setRetention({ ...retention, runsRetentionDays: v ?? 0 })} />
                  </Field>
                  <Button
                    onClick={async () => {
                      try {
                        await api.put('/api/settings', retention);
                        toast(t('Retention policy saved (applied hourly)'), 'good');
                      } catch (e) {
                        toast(errorText(e), 'bad');
                      }
                    }}
                  >
                    {t('Save')}
                  </Button>
                </div>
              )}
            </div>
            <div className="border-t border-line pt-4">
              <div className="mb-2 text-sm font-medium">{t('Clean up now')}</div>
              <div className="flex flex-wrap items-end gap-3">
                <Field label={t('Older than (days)')}>
                  <NumberInput className="w-24" value={days} onChange={setDays} />
                </Field>
                <Field label={t('What to delete')}>
                  <Select
                    value={mode}
                    onChange={(e) => setMode(e.target.value)}
                    options={[
                      { value: 'metrics', label: t('Per-second metrics only') },
                      { value: 'runs', label: t('Entire runs') },
                    ]}
                  />
                </Field>
                <Button
                  variant="danger"
                  onClick={async () => {
                    if (!confirm(mode === 'runs' ? t('Delete runs older than {d} days?', { d: days ?? 30 }) : t('Delete metrics older than {d} days?', { d: days ?? 30 }))) return;
                    try {
                      const r = await api.post('/api/system/cleanup', { olderThanDays: days ?? 30, mode });
                      toast(t('{n} records deleted', { n: fmtNum(r.deleted) }), 'good');
                      reload();
                    } catch (e) {
                      toast(errorText(e), 'bad');
                    }
                  }}
                >
                  {t('Clean up')}
                </Button>
              </div>
            </div>
            <div className="border-t border-line pt-4 text-xs text-ink-3">
              {t('Server limits: {vus} VUs · {rate} flows/s · {dur} (change with MAX_VUS, MAX_RATE, MAX_DURATION_SEC)', { vus: fmtNum(data.limits.maxVus), rate: fmtNum(data.limits.maxRate), dur: fmtDuration(data.limits.maxDurationSec) })}
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}

const NODE_COLORS = [SERIES.s1, SERIES.s2, SERIES.s3, SERIES.s7, SERIES.s5];

function NodeChart({ hist, field, format }: { hist: Record<string, { t: number; cpu: number | null; mem: number }[]>; field: 'cpu' | 'mem'; format: (v: number) => string }) {
  const ids = Object.keys(hist).slice(0, NODE_COLORS.length);
  const map = new Map<number, any>();
  ids.forEach((id, i) => {
    for (const p of hist[id]) map.set(p.t, { ...(map.get(p.t) ?? { t: p.t }), [`n${i}`]: p[field] });
  });
  const data = [...map.values()].sort((a, b) => a.t - b.t);
  if (data.length < 2) return <div className="py-10 text-center text-xs text-ink-3">{t('Collecting data…')}</div>;
  const t0 = data[0].t;
  return (
    <TimeChart
      data={data.map((d) => ({ ...d, t: d.t - t0 }))}
      format={format}
      series={ids.map((id, i) => ({ key: `n${i}`, label: id.replace(/-\d+$/, ''), color: NODE_COLORS[i] }))}
    />
  );
}
