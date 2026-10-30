import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { GitCompare, Search, Trash2 } from 'lucide-react';
import { api, errorText } from '../lib/api';
import { profileLabel } from '../lib/constants';
import { locale, t } from '../lib/i18n';
import { fmtMs, fmtNum, fmtPct } from '../lib/format';
import { Alert, Badge, Button, Card, Empty, Input, Loading, PageHeader, Select, Stat, Tabs, useLoad, useToast } from '../components/ui';
import { SERIES, TimeChart } from '../components/charts';
import { SiteForm } from '../components/SiteForm';

export default function SiteDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [tab, setTab] = useState<'bench' | 'settings' | 'probe'>('bench');
  const { data, loading, reload } = useLoad(() => api.get(`/api/sites/${id}/benchmark`), [id]);
  const [kind, setKind] = useState('');
  const [sel, setSel] = useState<string[]>([]);

  if (loading && !data) return <Loading />;
  if (!data) return <Alert tone="bad">{t('Site not found')}</Alert>;
  const site = data.site;
  const runs: any[] = data.runs.filter((r: any) => !kind || r.kind === kind);
  const trend = [...runs].reverse().map((r, i) => ({
    i,
    label: new Date(r.createdAt).toLocaleDateString(locale(), { day: '2-digit', month: 'short' }),
    p95: r.latency?.p95 ?? null,
    p50: r.latency?.p50 ?? null,
    rps: r.rpsAvg ?? null,
    err: r.errorRate != null ? r.errorRate * 100 : null,
    cap: r.capacity?.maxHealthy?.rps ?? null,
  }));
  const kinds = [...new Set<string>(data.runs.map((r: any) => r.kind))];
  const xf = (i: number) => trend[i]?.label ?? '';
  const toggle = (rid: string) => setSel((s) => (s.includes(rid) ? s.filter((x) => x !== rid) : [...s.slice(-1), rid]));

  const del = async () => {
    if (!confirm(t('Delete site “{name}” and its entire run history?', { name: site.name }))) return;
    try {
      await api.del(`/api/sites/${id}`);
      nav('/sites');
    } catch (e) {
      toast(errorText(e), 'bad');
    }
  };

  return (
    <>
      <PageHeader
        back={<Link to="/sites">← {t('Sites')}</Link>}
        title={site.name}
        subtitle={<span className="font-mono text-xs">{site.baseUrl}</span>}
        actions={
          <>
            <Button onClick={() => nav(`/plans/new?siteId=${id}`)}>{t('Create test plan')}</Button>
            <Button onClick={() => nav(`/workflows/new?siteId=${id}`)}>{t('Create workflow')}</Button>
          </>
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'bench', label: t('Benchmark') },
          { value: 'settings', label: t('Settings') },
          { value: 'probe', label: t('Inspect page') },
        ]}
      />

      {tab === 'bench' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label={t('Best p95')} value={fmtMs(data.best.p95)} />
            <Stat label={t('Highest peak rps')} value={fmtNum(data.best.rpsPeak)} />
            <Stat label={t('Measured capacity')} value={data.best.capacityRps ? `${fmtNum(data.best.capacityRps, 1)} rps` : '—'} sub={t('from breakpoint tests')} />
            <Stat label={t('Baseline run')} value={data.baseline ? fmtMs(data.baseline.latency?.p95) : '—'} sub={data.baseline ? `p95 · ${data.baseline.name}` : t('mark one on a run page')} />
          </div>

          {runs.length === 0 ? (
            <Card>
              <Empty title={t('No completed runs to benchmark yet')}>{t('Create and run a test plan; results are compared here over time.')}</Empty>
            </Card>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  className="w-56"
                  value={kind}
                  onChange={(e) => setKind(e.target.value)}
                  options={[{ value: '', label: t('All test types') }, ...kinds.map((k) => ({ value: k, label: profileLabel(k) }))]}
                />
                <span className="text-xs text-ink-3">{t('{n} runs', { n: runs.length })}</span>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <Card title={t('Latency trend')}>
                  <TimeChart
                    data={trend}
                    xKey="i"
                    xFormat={xf}
                    format={(v) => fmtMs(v)}
                    series={[
                      { key: 'p50', label: 'p50', color: SERIES.s1 },
                      { key: 'p95', label: 'p95', color: SERIES.s2 },
                    ]}
                  />
                </Card>
                <Card title={t('Average requests/s')}>
                  <TimeChart data={trend} xKey="i" xFormat={xf} format={(v) => fmtNum(v, 1)} series={[{ key: 'rps', label: 'rps', color: SERIES.s3 }]} />
                </Card>
                <Card title={t('Error rate (%)')}>
                  <TimeChart data={trend} xKey="i" xFormat={xf} format={(v) => `%${v.toFixed(2)}`} series={[{ key: 'err', label: t('errors %'), color: SERIES.bad }]} />
                </Card>
                <Card title={t('Capacity (highest healthy rps)')}>
                  {trend.some((t) => t.cap) ? (
                    <TimeChart data={trend.filter((t) => t.cap)} xKey="i" xFormat={xf} format={(v) => fmtNum(v, 1)} series={[{ key: 'cap', label: t('capacity rps'), color: SERIES.s7 }]} />
                  ) : (
                    <Empty title={t('No breakpoint tests yet')}>{t('Run a plan with the “Breakpoint” profile.')}</Empty>
                  )}
                </Card>
              </div>

              <Card
                title={t('Run history')}
                pad={false}
                actions={
                  <Button size="sm" icon={<GitCompare className="size-3.5" />} disabled={sel.length !== 2} onClick={() => nav(`/compare?a=${sel[0]}&b=${sel[1]}`)}>
                    {t('Compare 2 selected runs')}
                  </Button>
                }
              >
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-xs text-ink-3">
                        <th className="w-8 px-3 py-2" />
                        <th className="px-3 py-2 font-medium">{t('Run')}</th>
                        <th className="px-3 py-2 font-medium">{t('Date')}</th>
                        <th className="px-3 py-2 text-right font-medium">p50</th>
                        <th className="px-3 py-2 text-right font-medium">p95</th>
                        <th className="px-3 py-2 text-right font-medium">p99</th>
                        <th className="px-3 py-2 text-right font-medium">{t('Avg rps')}</th>
                        <th className="px-3 py-2 text-right font-medium">{t('Peak VUs')}</th>
                        <th className="px-3 py-2 text-right font-medium">{t('Errors')}</th>
                        <th className="px-3 py-2 text-right font-medium">{t('Capacity')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map((r) => {
                        const b = data.baseline;
                        const d = b && b.id !== r.id && b.latency?.p95 && r.latency?.p95 ? ((r.latency.p95 - b.latency.p95) / b.latency.p95) * 100 : null;
                        return (
                          <tr key={r.id} className="border-b border-line/60 hover:bg-surface-2">
                            <td className="px-3 py-2">
                              <input type="checkbox" aria-label={t('Select for comparison')} checked={sel.includes(r.id)} onChange={() => toggle(r.id)} />
                            </td>
                            <td className="px-3 py-2">
                              <Link to={`/runs/${r.id}`} className="font-medium hover:underline">
                                {r.name}
                              </Link>
                              <div className="mt-0.5 flex gap-1">
                                <span className="text-xs text-ink-3">{profileLabel(r.kind)}</span>
                                {r.isBaseline && <Badge tone="warn">{t('baseline')}</Badge>}
                                {r.thresholdsPassed === false && <Badge tone="bad">{t('threshold failed')}</Badge>}
                              </div>
                            </td>
                            <td className="px-3 py-2 text-xs whitespace-nowrap text-ink-3">{new Date(r.createdAt).toLocaleString(locale())}</td>
                            <td className="tabular px-3 py-2 text-right text-ink-2">{fmtMs(r.latency?.p50)}</td>
                            <td className="tabular px-3 py-2 text-right">
                              {fmtMs(r.latency?.p95)}
                              {d !== null && <span className={`ml-1 text-[11px] ${d > 5 ? 'text-bad' : d < -5 ? 'text-good' : 'text-ink-3'}`}>{d > 0 ? '+' : ''}{d.toFixed(0)}%</span>}
                            </td>
                            <td className="tabular px-3 py-2 text-right text-ink-2">{fmtMs(r.latency?.p99)}</td>
                            <td className="tabular px-3 py-2 text-right text-ink-2">{fmtNum(r.rpsAvg, 1)}</td>
                            <td className="tabular px-3 py-2 text-right text-ink-2">{fmtNum(r.maxVus)}</td>
                            <td className="tabular px-3 py-2 text-right text-ink-2">{fmtPct(r.errorRate)}</td>
                            <td className="tabular px-3 py-2 text-right text-ink-2">{r.capacity?.maxHealthy ? `${r.capacity.maxHealthy.rps} rps` : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          )}
        </div>
      )}

      {tab === 'settings' && (
        <div className="space-y-4">
          <Card>
            <SiteForm site={site} onSaved={() => reload()} />
          </Card>
          <Card title={t('Danger zone')}>
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm text-ink-2">{t('Permanently deletes the site, its plans and its entire run history.')}</div>
              <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={del}>
                {t('Delete site')}
              </Button>
            </div>
          </Card>
        </div>
      )}

      {tab === 'probe' && <ProbePanel siteId={id!} />}
    </>
  );
}

function ProbePanel({ siteId }: { siteId: string }) {
  const [path, setPath] = useState('/');
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setRes(await api.post(`/api/sites/${siteId}/probe`, { path }));
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <Card>
        <p className="mb-3 text-sm text-ink-3">{t('Fetches a page once and lists its links and forms — to find the paths and field names to use in workflow steps.')}</p>
        <div className="flex gap-2">
          <Input value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} placeholder="/products" className="font-mono" />
          <Button variant="primary" icon={<Search className="size-4" />} loading={busy} onClick={run}>
            {t('Inspect')}
          </Button>
        </div>
      </Card>
      {err && <Alert tone="bad">{err}</Alert>}
      {res && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={`${res.status} · ${fmtMs(res.durationMs)} · ${res.title ?? res.contentType}`}>
            <div className="space-y-1 font-mono text-xs text-ink-2">
              <div>{t('final URL: {url}', { url: res.finalUrl })}</div>
              {Object.entries(res.headers ?? {}).map(([k, v]) => (
                <div key={k}>
                  {k}: {String(v)}
                </div>
              ))}
              {res.assets && <div>{t('assets')}: {res.assets.scripts} js · {res.assets.stylesheets} css · {res.assets.images} img</div>}
            </div>
            {res.forms?.length > 0 && (
              <div className="mt-4">
                <div className="mb-1 text-xs font-medium text-ink-2">{t('Forms')}</div>
                {res.forms.map((f: any, i: number) => (
                  <div key={i} className="mb-2 rounded border border-line p-2 font-mono text-xs">
                    <div>
                      {f.method} {f.action || t('(same page)')}
                    </div>
                    <div className="text-ink-3">{f.inputs.map((x: any) => `${x.name}${x.value ? `=${x.value}` : ''} (${x.type})`).join(', ')}</div>
                  </div>
                ))}
              </div>
            )}
            {res.jsonPreview && <pre className="mt-3 max-h-80 overflow-auto rounded bg-bg p-2 text-xs">{res.jsonPreview}</pre>}
          </Card>
          {res.links && (
            <Card title={t('Links ({n})', { n: res.links.length })} pad={false}>
              <ul className="max-h-[480px] overflow-auto text-xs">
                {res.links.map((l: any) => (
                  <li key={l.href} className="border-b border-line/50 px-4 py-1.5">
                    <div className="truncate font-mono text-ink-2">{l.href}</div>
                    {l.text && <div className="truncate text-ink-3">{l.text}</div>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
