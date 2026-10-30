import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { GitCompare, OctagonX, RotateCcw, Square, Star, Trash2, TrendingUp, Zap } from 'lucide-react';
import { api, errorText } from '../lib/api';
import { ACTIVE_STATUSES, profileLabel, sourceLabel } from '../lib/constants';
import { fmtBytes, fmtClock, fmtCompact, fmtDate, fmtDuration, fmtMs, fmtNum, fmtPct } from '../lib/format';
import { t, tServer } from '../lib/i18n';
import { Alert, Badge, Button, Card, Loading, PageHeader, PassBadge, Stat, StatusBadge, cx, useToast } from '../components/ui';
import { SERIES, TimeChart } from '../components/charts';
import { DebugTrace, type DebugEntry } from '../components/DebugTrace';

interface Point {
  t: number;
  vus: number;
  rps: number;
  iters: number;
  err_rate: number;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  avg: number | null;
  max: number | null;
  bytes_in: number;
  dropped: number;
  gen_cpu: number | null;
}

export default function RunDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [run, setRun] = useState<any>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [steps, setSteps] = useState<any[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [debug, setDebug] = useState<DebugEntry[]>([]);
  const [breach, setBreach] = useState<any>(null);
  const seen = useRef(new Set<number>());

  const loadRun = async () => {
    const r = await api.get(`/api/runs/${id}`);
    setRun(r);
    if (r.summary?.steps) setSteps(r.summary.steps);
    else if (r.liveSteps) setSteps(r.liveSteps);
    if (r.summary?.debug) setDebug(r.summary.debug);
    return r;
  };

  const addPoints = (list: Point[]) => {
    const fresh = list.filter((p) => !seen.current.has(p.t));
    if (!fresh.length) return;
    fresh.forEach((p) => seen.current.add(p.t));
    setPoints((cur) => [...cur, ...fresh].sort((a, b) => a.t - b.t));
  };

  useEffect(() => {
    seen.current = new Set();
    setPoints([]);
    setLogs([]);
    setDebug([]);
    setBreach(null);
    let es: EventSource | null = null;
    let cancelled = false;
    (async () => {
      let r;
      try {
        r = await loadRun();
      } catch (e) {
        toast(errorText(e), 'bad');
        return;
      }
      if (cancelled) return;
      if (ACTIVE_STATUSES.includes(r.status)) {
        es = new EventSource(`/api/runs/${id}/live`);
        es.onmessage = (m) => {
          const ev = JSON.parse(m.data);
          if (ev.type === 'metric') addPoints([ev.data]);
          else if (ev.type === 'steps') setSteps(ev.data);
          else if (ev.type === 'log') setLogs((l) => [...l.slice(-100), ev.data]);
          else if (ev.type === 'debug') setDebug((d) => [...d, ev.data]);
          else if (ev.type === 'breach') setBreach(ev.data);
          else if (ev.type === 'status') {
            setRun((x: any) => ({ ...x, status: ev.data.status, stopReason: ev.data.stopReason ?? x.stopReason }));
            if (ev.data.done) {
              es?.close();
              setTimeout(() => {
                loadRun();
                api.get<Point[]>(`/api/runs/${id}/metrics`).then(addPoints);
              }, 500);
            }
          }
        };
      }
      addPoints(await api.get<Point[]>(`/api/runs/${id}/metrics`));
    })();
    return () => {
      cancelled = true;
      es?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // tick every second while running so the elapsed time updates
  const [, tick] = useState(0);
  useEffect(() => {
    if (!run || !ACTIVE_STATUSES.includes(run.status)) return;
    const h = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(h);
  }, [run?.status]);

  const live = run && ACTIVE_STATUSES.includes(run.status);
  const last = points.at(-1);
  const chartData = useMemo(() => points.map((p) => ({ ...p, err: p.err_rate * 100 })), [points]);
  const totals = useMemo(() => {
    const reqs = points.reduce((a, p) => a + p.rps, 0);
    const fails = points.reduce((a, p) => a + p.rps * p.err_rate, 0);
    return { reqs, errRate: reqs ? fails / reqs : 0 };
  }, [points]);

  if (!run) return <Loading />;

  const s = run.summary;
  const meta = run.meta ?? {};
  const plan = run.plan ?? {};
  const elapsed = run.startedAt ? ((run.finishedAt ? Date.parse(run.finishedAt) : Date.now()) - Date.parse(run.startedAt)) / 1000 : 0;
  const progress = meta.estDurationSec ? Math.min(100, (elapsed / meta.estDurationSec) * 100) : 0;
  const cap = run.capacity;
  const breachT = cap?.breachAt?.t ?? breach?.t;
  const p95Limit = plan.thresholds?.p95Ms;
  const autoP95 = plan.autoStop?.enabled ? plan.autoStop.p95Ms : undefined;
  const breakLabel = t('breakpoint');

  const act = async (fn: () => Promise<any>, ok?: string) => {
    try {
      await fn();
      if (ok) toast(ok, 'good');
      await loadRun();
    } catch (e) {
      toast(errorText(e), 'bad');
    }
  };

  return (
    <>
      <PageHeader
        back={
          <span>
            <Link to="/runs">← {t('Runs')}</Link> · <Link to={`/sites/${run.siteId}`}>{run.siteName}</Link>
            {run.planId && (
              <>
                {' '}
                · <Link to={`/plans/${run.planId}`}>{t('plan')}</Link>
              </>
            )}
          </span>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {run.name}
            <StatusBadge status={run.status} />
            <PassBadge passed={run.thresholdsPassed} />
            {run.isBaseline && (
              <Badge tone="warn">
                <Star className="size-3" /> {t('baseline')}
              </Badge>
            )}
          </span>
        }
        subtitle={`${profileLabel(run.kind)} · ${sourceLabel(run.trigger)} · ${fmtDate(run.createdAt)}${run.workerId ? ` · ${run.workerId}` : ''}`}
        actions={
          live ? (
            <>
              <Button variant="danger" icon={<Square className="size-4" />} onClick={() => act(() => api.post(`/api/runs/${id}/stop`), t('Stop requested'))} disabled={run.status === 'stopping'}>
                {run.status === 'stopping' ? t('Stopping…') : t('Stop')}
              </Button>
              {run.status === 'stopping' && (
                <Button variant="danger" icon={<OctagonX className="size-4" />} onClick={() => act(() => api.post(`/api/runs/${id}/stop`, { force: true }), t('Force-stopped'))}>
                  {t('Force stop')}
                </Button>
              )}
            </>
          ) : (
            <>
              <Button
                icon={<RotateCcw className="size-4" />}
                onClick={async () => {
                  try {
                    const r = await api.post(`/api/runs/${id}/rerun`);
                    nav(`/runs/${r.id}`);
                  } catch (e) {
                    toast(errorText(e), 'bad');
                  }
                }}
              >
                {t('Run again')}
              </Button>
              {run.kind !== 'debug' && (
                <Button
                  icon={<Star className="size-4" />}
                  onClick={() => act(() => api.post(`/api/runs/${id}/baseline`, { value: !run.isBaseline }), run.isBaseline ? t('Baseline removed') : t('Marked as baseline run'))}
                >
                  {run.isBaseline ? t('Remove baseline') : t('Make baseline')}
                </Button>
              )}
              <CompareWithBaseline run={run} />
              <Button
                variant="ghost"
                icon={<Trash2 className="size-4" />}
                onClick={() => {
                  if (confirm(t('Delete this run and its metrics?'))) act(() => api.del(`/api/runs/${id}`)).then(() => nav('/runs'));
                }}
              >
                {t('Delete')}
              </Button>
            </>
          )
        }
      />

      {live && (
        <div className="mb-4">
          <div className="mb-1 flex justify-between text-xs text-ink-3">
            <span>
              {run.status === 'queued' ? t('Waiting for a free worker…') : t('Elapsed {time}', { time: fmtClock(Math.round(elapsed)) })}
              {meta.estDurationSec ? ` / ~${fmtClock(meta.estDurationSec)}` : ''}
            </span>
            <span>{tServer(run.stopReason)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      {run.error && (
        <div className="mb-4">
          <Alert tone="bad" title={t('Error')}>
            {tServer(run.error)}
          </Alert>
        </div>
      )}
      {!live && run.stopReason && run.status !== 'failed' && (
        <div className="mb-4">
          <Alert tone={cap?.breached ? 'accent' : 'warn'}>{tServer(run.stopReason)}</Alert>
        </div>
      )}
      {s?.warnings?.map((w: string) => (
        <div key={w} className="mb-2">
          <Alert tone="warn">{tServer(w)}</Alert>
        </div>
      ))}

      {(cap || run.kind === 'breakpoint') && <CapacityCard cap={cap} live={live} breach={breach} />}

      {run.kind === 'debug' ? (
        <Card title={t('Step-by-step trace')}>
          <DebugTrace entries={debug} />
        </Card>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {live ? (
              <>
                <Stat label={t('Virtual users')} value={fmtNum(last?.vus)} sub={meta.peakVus ? t('peak {n}', { n: fmtNum(meta.peakVus) }) : undefined} />
                <Stat label={t('Requests / s')} value={fmtNum(last?.rps)} sub={t('{n} flows/s', { n: fmtNum(last?.iters) })} />
                <Stat label={t('p95 (now)')} value={fmtMs(last?.p95)} tone={p95Limit && last?.p95 && last.p95 > p95Limit ? 'bad' : undefined} />
                <Stat label={t('p50 (now)')} value={fmtMs(last?.p50)} />
                <Stat label={t('Error rate')} value={fmtPct(totals.errRate)} tone={totals.errRate > 0.01 ? 'bad' : undefined} sub={t('now {v}', { v: fmtPct(last?.err_rate) })} />
                <Stat label={t('Total requests')} value={fmtCompact(totals.reqs)} sub={last?.gen_cpu != null ? t('k6 CPU {v}%', { v: Math.round(last.gen_cpu) }) : undefined} />
              </>
            ) : s ? (
              <>
                <Stat label={t('Total requests')} value={fmtCompact(s.requests)} sub={t('{n} flows · {d}', { n: fmtNum(s.iterations), d: fmtDuration(s.durationSec) })} />
                <Stat label={t('Avg / peak rps')} value={fmtNum(s.rpsAvg, 1)} sub={t('peak {n}', { n: fmtNum(s.rpsPeak) })} />
                <Stat label="p95" value={fmtMs(s.latency?.p95)} sub={`p99 ${fmtMs(s.latency?.p99)}`} tone={p95Limit && s.latency?.p95 > p95Limit ? 'bad' : undefined} />
                <Stat label={t('Median')} value={fmtMs(s.latency?.p50)} sub={t('avg {avg} · max {max}', { avg: fmtMs(s.latency?.avg), max: fmtMs(s.latency?.max) })} />
                <Stat label={t('Error rate')} value={fmtPct(s.errorRate)} sub={t('{n} failed', { n: fmtNum(s.failed) })} tone={s.errorRate > 0.01 ? 'bad' : s.errorRate === 0 ? 'good' : undefined} />
                <Stat label={t('Peak VUs')} value={fmtNum(s.maxVus)} sub={t('{v} received', { v: fmtBytes(s.bytesIn) })} />
              </>
            ) : null}
          </div>

          {points.length > 0 && (
            <div className="mb-4 grid gap-4 lg:grid-cols-2">
              <Card title={t('Response time')}>
                <TimeChart
                  data={chartData}
                  format={(v) => fmtMs(v)}
                  series={[
                    { key: 'p50', label: 'p50', color: SERIES.s1 },
                    { key: 'p95', label: 'p95', color: SERIES.s2 },
                    { key: 'p99', label: 'p99', color: SERIES.s3 },
                  ]}
                  refY={[
                    ...(p95Limit ? [{ value: p95Limit, label: t('threshold p95 {v}ms', { v: p95Limit }) }] : []),
                    ...(autoP95 && autoP95 !== p95Limit ? [{ value: autoP95, label: t('stop at {v}ms', { v: autoP95 }) }] : []),
                  ]}
                  refX={breachT !== undefined ? [{ value: breachT, label: breakLabel }] : undefined}
                />
              </Card>
              <Card title={t('Requests / s')}>
                <TimeChart data={chartData} area format={(v) => fmtNum(v)} series={[{ key: 'rps', label: t('requests/s'), color: SERIES.s1 }]} refX={breachT !== undefined ? [{ value: breachT, label: breakLabel }] : undefined} />
              </Card>
              <Card title={t('Virtual users (VUs)')}>
                <TimeChart data={chartData} area format={(v) => fmtNum(v)} series={[{ key: 'vus', label: 'VU', color: SERIES.s7 }]} />
              </Card>
              <Card title={t('Error rate (%)')}>
                <TimeChart data={chartData} area format={(v) => `${v.toFixed(2)}%`} series={[{ key: 'err', label: t('errors %'), color: SERIES.bad }]} />
              </Card>
              {points.some((p) => p.gen_cpu != null) && (
                <Card title={t('Load generator (k6) CPU %')} className="lg:col-span-2">
                  <TimeChart data={chartData} height={140} format={(v) => `${Math.round(v)}%`} series={[{ key: 'gen_cpu', label: 'k6 CPU', color: SERIES.s4 }]} />
                  <p className="mt-2 text-xs text-ink-3">{t('If this approaches ~85% of the core count, the limit is the load generator, not your site.')}</p>
                </Card>
              )}
            </div>
          )}

          <StepsTable steps={steps} />

          {s && (
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              {s.flows?.length > 0 && (
                <Card title={t('Flows')} pad={false}>
                  <SimpleTable
                    head={[t('Flow'), t('Completed'), t('Aborted'), t('Duration p95')]}
                    rows={s.flows.map((f: any) => [f.name, fmtNum(f.completed), <span className={f.aborted ? 'text-bad' : ''}>{fmtNum(f.aborted)}</span>, fmtMs(f.duration?.p95)])}
                  />
                </Card>
              )}
              {s.thresholds?.length > 0 && (
                <Card title={t('Thresholds')} pad={false}>
                  <SimpleTable
                    head={[t('Metric'), t('Condition'), t('Result')]}
                    rows={s.thresholds.map((th: any) => [th.metric, <code>{th.expr}</code>, th.ok ? <Badge tone="good">{t('passed')}</Badge> : <Badge tone="bad">{t('failed')}</Badge>])}
                  />
                </Card>
              )}
              <Card title={t('Status codes')} pad={false}>
                <SimpleTable
                  head={[t('Code'), t('Count')]}
                  rows={(s.statuses ?? []).map((x: any) => [<span className={Number(x.key) >= 400 || x.key === '0' ? 'text-bad' : ''}>{x.key === '0' ? t('0 (connection error)') : x.key}</span>, fmtNum(x.count)])}
                />
              </Card>
              {(s.abortedAt?.length > 0 || s.errorCodes?.length > 0) && (
                <Card title={t('Where did users get stuck?')} pad={false}>
                  <SimpleTable head={[t('Flow → step'), t('Aborted')]} rows={(s.abortedAt ?? []).map((x: any) => [x.key, fmtNum(x.count)])} />
                  {s.errorCodes?.length > 0 && <SimpleTable head={[t('k6 error code'), t('Count')]} rows={s.errorCodes.map((x: any) => [x.key, fmtNum(x.count)])} />}
                </Card>
              )}
              {s.checks?.length > 0 && (
                <Card title={t('Checks')} pad={false} className="lg:col-span-2">
                  <SimpleTable
                    head={[t('Check'), t('Passed'), t('Failed'), t('Success')]}
                    rows={s.checks.map((c: any) => {
                      const r = c.pass / Math.max(1, c.pass + c.fail);
                      return [c.name, fmtNum(c.pass), <span className={c.fail ? 'text-bad' : ''}>{fmtNum(c.fail)}</span>, fmtPct(r, 1)];
                    })}
                  />
                </Card>
              )}
            </div>
          )}
        </>
      )}

      <details className="mt-4 rounded-lg border border-line bg-surface">
        <summary className="cursor-pointer px-4 py-2.5 text-sm text-ink-2">{t('Plan configuration and logs')}</summary>
        <div className="grid gap-4 p-4 lg:grid-cols-2">
          <pre className="max-h-96 overflow-auto rounded bg-bg p-3 font-mono text-xs text-ink-2">{JSON.stringify({ ...plan, flows: run.flows }, null, 2)}</pre>
          <pre className="max-h-96 overflow-auto rounded bg-bg p-3 font-mono text-xs whitespace-pre-wrap text-ink-2">{(run.logs ?? logs.join('\n')) || t('No logs')}</pre>
        </div>
      </details>
    </>
  );
}

function CapacityCard({ cap, live, breach }: { cap: any; live: boolean; breach: any }) {
  if (!cap) {
    return (
      <div className="mb-4">
        <Alert tone="accent" title={t('Searching for the breakpoint')}>
          {t('The rate keeps rising; when the p95 or error threshold is exceeded the test stops itself and reports capacity.')}
          {breach ? `\n${t('Threshold exceeded: {reason}', { reason: tServer(breach.reason) })}` : ''}
        </Alert>
      </div>
    );
  }
  const mh = cap.maxHealthy;
  return (
    <div className="mb-4 rounded-lg border border-accent/40 bg-accent/5 p-4">
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-lg bg-accent/20">
            <Zap className="size-5 text-[#86b6ef]" />
          </div>
          <div>
            <div className="text-xs text-ink-3">{t('Measured capacity (highest healthy)')}</div>
            <div className="tabular text-3xl font-semibold tracking-tight">{mh ? t('{n} requests/s', { n: fmtNum(mh.rps, 1) }) : '—'}</div>
          </div>
        </div>
        {mh && (
          <div className="grid grid-cols-3 gap-6 text-sm">
            <div>
              <div className="text-xs text-ink-3">{t('Flows / s')}</div>
              <div className="tabular font-medium">{fmtNum(mh.iterRate, 2)}</div>
            </div>
            <div>
              <div className="text-xs text-ink-3">{t('Concurrent VUs')}</div>
              <div className="tabular font-medium">{fmtNum(mh.vus)}</div>
            </div>
            <div>
              <div className="text-xs text-ink-3">{t('p95 at that point')}</div>
              <div className="tabular font-medium">{fmtMs(mh.p95)}</div>
            </div>
          </div>
        )}
      </div>
      <p className="mt-3 text-sm text-ink-2">
        <TrendingUp className="mr-1 inline size-4 text-ink-3" />
        {cap.breached
          ? t('The system broke down at about {rps} requests/s ({reason}). Thresholds: p95 ≤ {p95} ms, errors ≤ {err}.', {
              rps: fmtNum(cap.breachAt?.rps, 1),
              reason: tServer(cap.reason),
              p95: cap.limits.p95Ms ?? '—',
              err: cap.limits.errorRate != null ? fmtPct(cap.limits.errorRate, 1) : '—',
            })
          : live
            ? t('No threshold exceeded yet.')
            : t('No threshold was exceeded during the test — the system held up to the highest target rate. Try again with a higher max rate.')}
      </p>
    </div>
  );
}

function StepsTable({ steps }: { steps: any[] }) {
  if (!steps.length) return null;
  const maxP95 = Math.max(...steps.map((s) => s.p95 ?? 0), 1);
  return (
    <Card title={t('Performance per step')} pad={false}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-3">
              <th className="px-4 py-2 font-medium">{t('Flow / step')}</th>
              <th className="px-4 py-2 text-right font-medium">{t('Requests')}</th>
              <th className="px-4 py-2 text-right font-medium">{t('Errors')}</th>
              <th className="px-4 py-2 text-right font-medium">p50</th>
              <th className="px-4 py-2 font-medium">p95</th>
              <th className="px-4 py-2 text-right font-medium">p99</th>
              <th className="px-4 py-2 text-right font-medium">max</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((s) => (
              <tr key={s.flow + s.step} className="border-b border-line/60">
                <td className="px-4 py-2">
                  <div className="font-medium">{s.step}</div>
                  <div className="text-xs text-ink-3">{s.flow}</div>
                </td>
                <td className="tabular px-4 py-2 text-right text-ink-2">{fmtNum(s.count)}</td>
                <td className={cx('tabular px-4 py-2 text-right', s.errRate > 0.01 ? 'text-bad' : 'text-ink-2')}>{fmtPct(s.errRate)}</td>
                <td className="tabular px-4 py-2 text-right text-ink-2">{fmtMs(s.p50)}</td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-3">
                      <div className="h-full rounded-full bg-[#d95926]" style={{ width: `${((s.p95 ?? 0) / maxP95) * 100}%` }} />
                    </div>
                    <span className="tabular text-xs">{fmtMs(s.p95)}</span>
                  </div>
                </td>
                <td className="tabular px-4 py-2 text-right text-ink-2">{fmtMs(s.p99)}</td>
                <td className="tabular px-4 py-2 text-right text-ink-3">{fmtMs(s.max)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function SimpleTable({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-line text-left text-xs text-ink-3">
          {head.map((h, i) => (
            <th key={h} className={cx('px-4 py-2 font-medium', i > 0 && 'text-right')}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-line/60">
            {r.map((c, j) => (
              <td key={j} className={cx('px-4 py-1.5', j > 0 ? 'tabular text-right text-ink-2' : 'break-all')}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CompareWithBaseline({ run }: { run: any }) {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  if (run.kind === 'debug') return null;
  return (
    <Button
      icon={<GitCompare className="size-4" />}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const b = await api.get(`/api/sites/${run.siteId}/benchmark`);
          const base = b.baseline && b.baseline.id !== run.id ? b.baseline : b.runs.find((r: any) => r.id !== run.id && r.kind === run.kind);
          if (base) nav(`/compare?a=${base.id}&b=${run.id}`);
          else alert(t('No other run to compare with'));
        } finally {
          setBusy(false);
        }
      }}
    >
      {t('Compare with baseline')}
    </Button>
  );
}
