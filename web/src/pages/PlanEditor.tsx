import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Play, Save, Trash2 } from 'lucide-react';
import type { Me } from '../App';
import { api, errorText } from '../lib/api';
import { profileLabel, sourceLabel } from '../lib/constants';
import { t } from '../lib/i18n';
import { fmtDuration, fmtNum } from '../lib/format';
import { Alert, Badge, Button, Card, Field, Input, Loading, NumberInput, PageHeader, Select, StatusBadge, Toggle, useLoad, useToast } from '../components/ui';
import { useConfirmStart } from '../components/StartConfirm';
import { PROFILE_DEFAULTS, ProfileEditor, type Profile } from '../components/ProfileEditor';
import { RunTable } from '../components/RunTable';
import type { Site } from '../components/SiteForm';

interface PlanCfg {
  flows: { workflowId: string; weight: number }[];
  profile: Profile;
  thresholds: { p95Ms?: number; p99Ms?: number; errorRate?: number; checksRate?: number };
  autoStop: { enabled: boolean; p95Ms?: number; errorRate?: number; windowSec: number; graceSec: number };
  options: { httpTimeoutSec?: number; insecureSkipTLSVerify?: boolean; userAgent?: string; gracefulStopSec?: number; workers?: number; browserVus?: number };
}

const EMPTY: PlanCfg = {
  flows: [],
  profile: PROFILE_DEFAULTS.ramp,
  thresholds: { p95Ms: 800, errorRate: 0.01 },
  autoStop: { enabled: false, windowSec: 10, graceSec: 15 },
  options: {},
};

const pct = (v?: number) => (v === undefined ? undefined : Math.round(v * 10000) / 100);
const frac = (v?: number) => (v === undefined ? undefined : v / 100);

export default function PlanEditorPage({ me }: { me: Me }) {
  const { id } = useParams();
  const isNew = id === 'new';
  const [qs] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const sites = useLoad(() => api.get<Site[]>('/api/sites'));
  const confirmStart = useConfirmStart();

  const [loaded, setLoaded] = useState(isNew);
  const [meta, setMeta] = useState<any>(null);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [siteId, setSiteId] = useState(qs.get('siteId') ?? '');
  const [schedule, setSchedule] = useState('');
  const [cfg, setCfg] = useState<PlanCfg>(EMPTY);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<any>(null);

  const wfs = useLoad(() => (siteId ? api.get<any[]>(`/api/workflows?siteId=${siteId}`) : Promise.resolve([])), [siteId]);
  const runs = useLoad(() => (isNew ? Promise.resolve([]) : api.get<any[]>(`/api/runs?planId=${id}&limit=20`)), [id], 5000);

  useEffect(() => {
    if (isNew) {
      if (!siteId && sites.data?.length) setSiteId(sites.data[0].id);
      return;
    }
    api
      .get(`/api/plans/${id}`)
      .then((p) => {
        setMeta(p);
        setName(p.name);
        setNotes(p.notes);
        setSiteId(p.siteId);
        setSchedule(p.schedule ?? '');
        setCfg({ ...EMPTY, ...p.config });
        setLoaded(true);
        setDirty(false);
      })
      .catch((e) => toast(errorText(e), 'bad'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isNew, sites.data]);

  const upd = (patch: Partial<PlanCfg>) => {
    setCfg((c) => ({ ...c, ...patch }));
    setDirty(true);
  };

  // server-side preview (validation + estimates)
  const pTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!loaded || !siteId || !cfg.flows.length) {
      setPreview(null);
      return;
    }
    clearTimeout(pTimer.current);
    pTimer.current = window.setTimeout(() => {
      api.post('/api/plans/preview', { siteId, config: cfg }).then(setPreview).catch(() => {});
    }, 500);
  }, [cfg, siteId, loaded]);

  const totalWeight = cfg.flows.reduce((a, f) => a + (f.weight || 0), 0);
  const wfById = useMemo(() => Object.fromEntries((wfs.data ?? []).map((w) => [w.id, w])), [wfs.data]);
  const isBreak = cfg.profile.kind === 'breakpoint';

  const save = async () => {
    setBusy(true);
    try {
      const body = { name: name || t('Untitled plan'), siteId, notes, schedule: schedule.trim() || null, config: { ...cfg, autoStop: { ...cfg.autoStop, enabled: isBreak || cfg.autoStop.enabled } } };
      const p = isNew ? await api.post('/api/plans', body) : await api.put(`/api/plans/${id}`, body);
      setMeta(p);
      setDirty(false);
      toast(t('Plan saved'), 'good');
      if (isNew) nav(`/plans/${p.id}`, { replace: true });
      return p;
    } catch (e) {
      toast(errorText(e), 'bad');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    const siteName = sites.data?.find((s) => s.id === siteId)?.name;
    if (!(await confirmStart(name || t('Untitled plan'), [siteName, profileLabel(cfg.profile.kind)].filter(Boolean).join(' · ')))) return;
    let pid = id;
    if (isNew || dirty) {
      const p = await save();
      if (!p) return;
      pid = p.id;
    }
    setBusy(true);
    try {
      const r = await api.post(`/api/plans/${pid}/start`);
      toast(t('Test queued'), 'good');
      nav(`/runs/${r.id}`);
    } catch (e) {
      toast(errorText(e), 'bad');
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) return <Loading />;

  return (
    <>
      <PageHeader
        back={<Link to="/plans">← {t('Test plans')}</Link>}
        title={
          <span className="flex items-center gap-2">
            {name || t('New test plan')}
            {meta && <StatusBadge status={meta.status} />}
            {meta && meta.source !== 'panel' && <Badge tone="accent">{t('{source} draft', { source: sourceLabel(meta.source) })}</Badge>}
            {dirty && <Badge tone="warn">{t('unsaved')}</Badge>}
          </span>
        }
        subtitle={t('Defines which site gets which user flows under what kind of load')}
        actions={
          <>
            <Button icon={<Save className="size-4" />} onClick={save} loading={busy}>
              {t('Save')}
            </Button>
            <Button variant="primary" icon={<Play className="size-4" />} onClick={start} loading={busy} disabled={!siteId || !cfg.flows.length || preview?.ok === false}>
              {t('Start')}
            </Button>
          </>
        }
      />

      {meta?.source === 'mcp' && meta.status === 'draft' && (
        <div className="mb-4">
          <Alert tone="accent" title={t('This plan was drafted over MCP')}>
            {notes || t('Review the settings; pressing “Start” approves it and runs the test.')}
          </Alert>
        </div>
      )}
      {preview && !preview.ok && (
        <div className="mb-4">
          <Alert tone="bad" title={t('The plan cannot run as it is')}>
            {preview.errors.join('\n')}
          </Alert>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card title={t('General')}>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label={t('Plan name')}>
                <Input value={name} onChange={(e) => (setName(e.target.value), setDirty(true))} placeholder={t('Pre-campaign capacity test')} />
              </Field>
              <Field label={t('Site')}>
                <Select
                  value={siteId}
                  onChange={(e) => {
                    setSiteId(e.target.value);
                    upd({ flows: [] });
                  }}
                  options={[{ value: '', label: t('Select…') }, ...(sites.data ?? []).map((s) => ({ value: s.id, label: s.name }))]}
                />
              </Field>
              <Field label={t('Notes')} className="md:col-span-2">
                <Input value={notes} onChange={(e) => (setNotes(e.target.value), setDirty(true))} />
              </Field>
            </div>
          </Card>

          <Card title={t('User mix')} actions={<span className="text-xs text-ink-3">{t('Each iteration picks a flow by weight')}</span>}>
            {!siteId ? (
              <p className="text-sm text-ink-3">{t('Select a site first.')}</p>
            ) : !wfs.data?.length ? (
              <p className="text-sm text-ink-3">
                {t('No workflows for this site.')} <Link className="text-accent hover:underline" to={`/workflows/new?siteId=${siteId}`}>{t('Create a workflow →')}</Link>
              </p>
            ) : (
              <div className="space-y-2">
                {wfs.data.map((w) => {
                  const f = cfg.flows.find((x) => x.workflowId === w.id);
                  const share = f && totalWeight ? (f.weight / totalWeight) * 100 : 0;
                  return (
                    <div key={w.id} className="flex items-center gap-3 rounded-md border border-line px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={t('Select {name}', { name: w.name })}
                        checked={!!f}
                        onChange={(e) => upd({ flows: e.target.checked ? [...cfg.flows, { workflowId: w.id, weight: 1 }] : cfg.flows.filter((x) => x.workflowId !== w.id) })}
                      />
                      <div className="min-w-0 flex-1">
                        <Link to={`/workflows/${w.id}`} className="text-sm font-medium hover:underline">
                          {w.name}
                        </Link>
                        <div className="flex gap-1 text-xs text-ink-3">
                          {w.siteId ? null : <span>{t('shared module')} ·</span>}
                          <StatusBadge status={w.status} />
                          {w.definition?.engine === 'browser' && <Badge tone="accent">{t('Browser')}</Badge>}
                        </div>
                      </div>
                      {f && (
                        <>
                          <div className="hidden h-1.5 w-32 overflow-hidden rounded-full bg-surface-3 sm:block">
                            <div className="h-full rounded-full bg-accent" style={{ width: `${share}%` }} />
                          </div>
                          <span className="tabular w-12 text-right text-xs text-ink-2">{share.toFixed(0)}%</span>
                          <NumberInput className="w-20" min={0} value={f.weight} onChange={(v) => upd({ flows: cfg.flows.map((x) => (x.workflowId === w.id ? { ...x, weight: v ?? 0 } : x)) })} aria-label={t('Weight')} />
                        </>
                      )}
                    </div>
                  );
                })}
                {cfg.flows.some((f) => wfById[f.workflowId]?.status === 'draft') && <Alert tone="warn">{t('Some selected workflows are drafts. They can run, but reviewing them first is recommended.')}</Alert>}
              </div>
            )}
          </Card>

          <Card title={t('Load profile')}>
            <ProfileEditor value={cfg.profile} onChange={(profile) => upd({ profile, ...(profile.kind === 'breakpoint' ? { autoStop: { ...cfg.autoStop, enabled: true, p95Ms: cfg.autoStop.p95Ms ?? 1500, errorRate: cfg.autoStop.errorRate ?? 0.05 } } : {}) })} />
          </Card>
        </div>

        <div className="space-y-4">
          <Card title={t('Summary')}>
            {preview?.ok ? (
              <dl className="grid grid-cols-2 gap-y-2 text-sm">
                <dt className="text-ink-3">{t('Test type')}</dt>
                <dd>{profileLabel(cfg.profile.kind)}</dd>
                <dt className="text-ink-3">{t('Estimated duration')}</dt>
                <dd>{fmtDuration(preview.meta.estDurationSec)}</dd>
                <dt className="text-ink-3">{t('Peak VUs')}</dt>
                <dd className="tabular">{fmtNum(preview.meta.peakVus)}</dd>
                {preview.meta.shards > 1 && (
                  <>
                    <dt className="text-ink-3">{t('Workers')}</dt>
                    <dd className={preview.meta.shards > preview.workersOnline ? 'text-bad' : ''}>
                      {t('{n} (of {online} online)', { n: preview.meta.shards, online: preview.workersOnline })}
                    </dd>
                  </>
                )}
                {preview.meta.browserVus > 0 && (
                  <>
                    <dt className="text-ink-3">{t('Browser VUs')}</dt>
                    <dd className={preview.browserWorkersOnline ? 'tabular' : 'tabular text-bad'}>
                      {t('{n} (browser workers online: {online})', { n: preview.meta.browserVus, online: preview.browserWorkersOnline ?? 0 })}
                    </dd>
                  </>
                )}
                <dt className="text-ink-3">{t('Flows')}</dt>
                <dd>
                  {preview.flows
                    .map((f: any) => `${f.name} (${f.engine === 'browser' ? `${t('browser')}, ` : ''}${t('{n} requests', { n: f.requests })})`)
                    .join(', ')}
                </dd>
              </dl>
            ) : (
              <p className="text-sm text-ink-3">{t('A summary appears here once a site, at least one workflow and a profile are selected.')}</p>
            )}
          </Card>

          <Card title={t('Pass/fail thresholds')} actions={<span className="text-xs text-ink-3">{t('pass / fail')}</span>}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="p95 < (ms)">
                <NumberInput value={cfg.thresholds.p95Ms} onChange={(v) => upd({ thresholds: { ...cfg.thresholds, p95Ms: v } })} />
              </Field>
              <Field label="p99 < (ms)">
                <NumberInput value={cfg.thresholds.p99Ms} onChange={(v) => upd({ thresholds: { ...cfg.thresholds, p99Ms: v } })} />
              </Field>
              <Field label={t('Error rate < (%)')}>
                <NumberInput step={0.1} value={pct(cfg.thresholds.errorRate)} onChange={(v) => upd({ thresholds: { ...cfg.thresholds, errorRate: frac(v) } })} />
              </Field>
              <Field label={t('Check success > (%)')}>
                <NumberInput step={0.1} value={pct(cfg.thresholds.checksRate)} onChange={(v) => upd({ thresholds: { ...cfg.thresholds, checksRate: frac(v) } })} />
              </Field>
            </div>
          </Card>

          <Card title={t('Auto-stop')}>
            <div className="space-y-3">
              {isBreak ? (
                <p className="text-xs text-ink-3">{t('Required for breakpoint tests: when a threshold is exceeded within the last {w} s, the test stops and the highest healthy rate so far is recorded as “capacity”.', { w: cfg.autoStop.windowSec })}</p>
              ) : (
                <Toggle checked={cfg.autoStop.enabled} onChange={(v) => upd({ autoStop: { ...cfg.autoStop, enabled: v } })} label={t('Stop the test when a threshold is exceeded')} />
              )}
              {(isBreak || cfg.autoStop.enabled) && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="p95 > (ms)">
                    <NumberInput value={cfg.autoStop.p95Ms} onChange={(v) => upd({ autoStop: { ...cfg.autoStop, p95Ms: v } })} />
                  </Field>
                  <Field label={t('Errors > (%)')}>
                    <NumberInput step={0.5} value={pct(cfg.autoStop.errorRate)} onChange={(v) => upd({ autoStop: { ...cfg.autoStop, errorRate: frac(v) } })} />
                  </Field>
                  <Field label={t('Window (s)')}>
                    <NumberInput value={cfg.autoStop.windowSec} onChange={(v) => upd({ autoStop: { ...cfg.autoStop, windowSec: v ?? 10 } })} />
                  </Field>
                  <Field label={t('Warm-up (s)')} hint={t('Never stops during this time')}>
                    <NumberInput value={cfg.autoStop.graceSec} onChange={(v) => upd({ autoStop: { ...cfg.autoStop, graceSec: v ?? 15 } })} />
                  </Field>
                </div>
              )}
            </div>
          </Card>

          <Card title={t('Advanced')}>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('HTTP timeout (s)')}>
                  <NumberInput value={cfg.options.httpTimeoutSec} onChange={(v) => upd({ options: { ...cfg.options, httpTimeoutSec: v } })} placeholder="30" />
                </Field>
                <Field label={t('Graceful stop (s)')}>
                  <NumberInput value={cfg.options.gracefulStopSec} onChange={(v) => upd({ options: { ...cfg.options, gracefulStopSec: v } })} placeholder="10" />
                </Field>
              </div>
              <Field
                label={t('Workers')}
                hint={t('Split the test across several workers; each sends an equal share of the VUs and rate. Use it when one worker’s CPU is the limit. {online} online.', { online: preview?.workersOnline ?? '?' })}
              >
                <NumberInput min={1} max={32} value={cfg.options.workers} onChange={(v) => upd({ options: { ...cfg.options, workers: v && v > 1 ? v : undefined } })} placeholder="1" />
              </Field>
              {preview?.flows?.some((f: any) => f.engine === 'browser') && preview.flows.some((f: any) => f.engine !== 'browser') && (
                <Field
                  label={t('Browser VUs')}
                  hint={t('Real Chromium users that run the browser workflows for the whole test, next to the HTTP load, and measure what users see. Each needs about half a CPU core.')}
                >
                  <NumberInput min={1} max={100} value={cfg.options.browserVus} onChange={(v) => upd({ options: { ...cfg.options, browserVus: v && v > 1 ? v : undefined } })} placeholder="1" />
                </Field>
              )}
              <Field label="User-Agent">
                <Input value={cfg.options.userAgent ?? ''} onChange={(e) => upd({ options: { ...cfg.options, userAgent: e.target.value || undefined } })} placeholder="LoadLab/1.0 (+k6)" />
              </Field>
              <Toggle checked={!!cfg.options.insecureSkipTLSVerify} onChange={(v) => upd({ options: { ...cfg.options, insecureSkipTLSVerify: v || undefined } })} label={t('Skip TLS certificate verification (staging)')} />
              <Field label={t('Schedule (cron, optional)')} hint={t('E.g. 0 3 * * * → every night at 03:00 (server time). For regular benchmarks.')}>
                <Input className="font-mono" value={schedule} onChange={(e) => (setSchedule(e.target.value), setDirty(true))} placeholder="0 3 * * *" />
              </Field>
              <p className="text-[11px] text-ink-3">
                {t('Server limits: up to {vus} VUs, {rate} flows/s, {dur}.', { vus: fmtNum(me.limits.maxVus), rate: fmtNum(me.limits.maxRate), dur: fmtDuration(me.limits.maxDurationSec) })}
              </p>
            </div>
          </Card>
        </div>
      </div>

      {!isNew && (
        <Card title={t('Runs of this plan')} className="mt-4" pad={false}>
          {runs.data?.length ? <RunTable runs={runs.data} showSite={false} onChange={runs.reload} /> : <p className="p-4 text-sm text-ink-3">{t('Not run yet.')}</p>}
        </Card>
      )}

      {!isNew && (
        <div className="mt-8 flex justify-end">
          <Button
            variant="danger"
            icon={<Trash2 className="size-4" />}
            onClick={async () => {
              if (!confirm(t('Delete this plan? (Past runs are kept)'))) return;
              await api.del(`/api/plans/${id}`);
              nav('/plans');
            }}
          >
            {t('Delete plan')}
          </Button>
        </div>
      )}
    </>
  );
}
