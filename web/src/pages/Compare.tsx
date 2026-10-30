import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { profileLabel } from '../lib/constants';
import { msg, t } from '../lib/i18n';
import { fmtDate, fmtMs, fmtNum, fmtPct } from '../lib/format';
import { Alert, Card, Loading, PageHeader, cx, useLoad } from '../components/ui';
import { SERIES, TimeChart } from '../components/charts';

const ROWS: { key: string; label: string; fmt: (v: any) => string; better: 'lower' | 'higher' }[] = [
  { key: 'p50', label: msg('p50'), fmt: fmtMs, better: 'lower' },
  { key: 'p95', label: msg('p95'), fmt: fmtMs, better: 'lower' },
  { key: 'p99', label: msg('p99'), fmt: fmtMs, better: 'lower' },
  { key: 'avg', label: msg('Average'), fmt: fmtMs, better: 'lower' },
  { key: 'rpsAvg', label: msg('Avg requests/s'), fmt: (v) => fmtNum(v, 1), better: 'higher' },
  { key: 'rpsPeak', label: msg('Peak requests/s'), fmt: (v) => fmtNum(v), better: 'higher' },
  { key: 'errorRate', label: msg('Error rate'), fmt: (v) => fmtPct(v), better: 'lower' },
  { key: 'requests', label: msg('Total requests'), fmt: (v) => fmtNum(v), better: 'higher' },
  { key: 'maxVus', label: msg('Peak VUs'), fmt: (v) => fmtNum(v), better: 'higher' },
  { key: 'capacityRps', label: msg('Capacity (rps)'), fmt: (v) => fmtNum(v, 1), better: 'higher' },
];

export default function ComparePage() {
  const [qs] = useSearchParams();
  const a = qs.get('a');
  const b = qs.get('b');
  const { data, loading, error } = useLoad(() => api.get(`/api/runs/compare?a=${a}&b=${b}`), [a, b]);

  const merged = useMemo(() => {
    if (!data) return [];
    const map = new Map<number, any>();
    for (const p of data.a.metrics) map.set(p.t, { t: p.t, a_p95: p.p95, a_rps: p.rps, a_vus: p.vus });
    for (const p of data.b.metrics) map.set(p.t, { ...(map.get(p.t) ?? { t: p.t }), b_p95: p.p95, b_rps: p.rps, b_vus: p.vus });
    return [...map.values()].sort((x, y) => x.t - y.t);
  }, [data]);

  if (!a || !b) return <Alert>{t('Select two runs to compare.')}</Alert>;
  if (loading) return <Loading />;
  if (error || !data) return <Alert tone="bad">{error}</Alert>;

  const stepRows = (() => {
    const bm = new Map<string, any>((data.b.summary?.steps ?? []).map((s: any) => [s.flow + '|' + s.step, s]));
    return (data.a.summary?.steps ?? []).map((s: any) => ({ a: s, b: bm.get(s.flow + '|' + s.step) }));
  })();

  return (
    <>
      <PageHeader title={t('Run comparison')} subtitle={t('A = before (baseline), B = after. The time axis is relative to test start.')} />
      <div className="mb-4 grid gap-3 md:grid-cols-2">
        {(['a', 'b'] as const).map((k) => (
          <div key={k} className="rounded-lg border border-line bg-surface p-3">
            <div className="flex items-center gap-2">
              <span className={cx('grid size-6 place-items-center rounded text-xs font-bold text-white', k === 'a' ? 'bg-[#3987e5]' : 'bg-[#d95926]')}>{k.toUpperCase()}</span>
              <Link to={`/runs/${data[k].id}`} className="font-medium hover:underline">
                {data[k].name}
              </Link>
            </div>
            <div className="mt-1 text-xs text-ink-3">
              {data[k].siteName} · {profileLabel(data[k].kind)} · {fmtDate(data[k].createdAt)}
            </div>
          </div>
        ))}
      </div>

      <Card title={t('Key metrics')} pad={false} className="mb-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-3">
              <th className="px-4 py-2 font-medium">{t('Metric')}</th>
              <th className="px-4 py-2 text-right font-medium">A</th>
              <th className="px-4 py-2 text-right font-medium">B</th>
              <th className="px-4 py-2 text-right font-medium">{t('Change')}</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => {
              const d = data.deltaPct[r.key];
              const good = d === null ? null : r.better === 'lower' ? d < -2 : d > 2;
              const bad = d === null ? null : r.better === 'lower' ? d > 2 : d < -2;
              return (
                <tr key={r.key} className="border-b border-line/60">
                  <td className="px-4 py-2 text-ink-2">{t(r.label)}</td>
                  <td className="tabular px-4 py-2 text-right">{r.fmt(data.a.kpi[r.key])}</td>
                  <td className="tabular px-4 py-2 text-right">{r.fmt(data.b.kpi[r.key])}</td>
                  <td className={cx('tabular px-4 py-2 text-right', good && 'text-good', bad && 'text-bad', !good && !bad && 'text-ink-3')}>{d === null ? '—' : `${d > 0 ? '+' : ''}${d}%`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card title={t('p95 response time')}>
          <TimeChart
            data={merged}
            format={(v) => fmtMs(v)}
            series={[
              { key: 'a_p95', label: msg('A'), color: SERIES.s1 },
              { key: 'b_p95', label: msg('B'), color: SERIES.s2 },
            ]}
          />
        </Card>
        <Card title={t('Requests / s')}>
          <TimeChart
            data={merged}
            format={(v) => fmtNum(v)}
            series={[
              { key: 'a_rps', label: msg('A'), color: SERIES.s1 },
              { key: 'b_rps', label: msg('B'), color: SERIES.s2 },
            ]}
          />
        </Card>
      </div>

      {stepRows.length > 0 && (
        <Card title={t('p95 per step')} pad={false}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-3">
                <th className="px-4 py-2 font-medium">{t('Step')}</th>
                <th className="px-4 py-2 text-right font-medium">A p95</th>
                <th className="px-4 py-2 text-right font-medium">B p95</th>
                <th className="px-4 py-2 text-right font-medium">{t('Change')}</th>
              </tr>
            </thead>
            <tbody>
              {stepRows.map(({ a: x, b: y }: any) => {
                const d = y && x.p95 ? ((y.p95 - x.p95) / x.p95) * 100 : null;
                return (
                  <tr key={x.flow + x.step} className="border-b border-line/60">
                    <td className="px-4 py-2">
                      {x.step} <span className="text-xs text-ink-3">· {x.flow}</span>
                    </td>
                    <td className="tabular px-4 py-2 text-right">{fmtMs(x.p95)}</td>
                    <td className="tabular px-4 py-2 text-right">{fmtMs(y?.p95)}</td>
                    <td className={cx('tabular px-4 py-2 text-right', d !== null && d > 5 && 'text-bad', d !== null && d < -5 && 'text-good')}>{d === null ? '—' : `${d > 0 ? '+' : ''}${d.toFixed(1)}%`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
