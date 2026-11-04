import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Copy, FlaskConical, Play, Save, Trash2 } from 'lucide-react';
import { api, errorText } from '../lib/api';
import { sourceLabel } from '../lib/constants';
import { t } from '../lib/i18n';
import { fmtDate } from '../lib/format';
import { Alert, Badge, Button, Card, Field, Input, KeyValueEditor, Loading, Modal, PageHeader, Select, StatusBadge, Tabs, Textarea, Toggle, useLoad, useToast } from '../components/ui';
import { FlowView, StepForm, TEMPLATES, getAt, updateAt, type Engine, type Path, type Step } from '../components/WorkflowBuilder';
import { DebugTrace, type DebugEntry } from '../components/DebugTrace';
import type { Site } from '../components/SiteForm';

interface Definition {
  engine?: Engine;
  variables?: Record<string, string>;
  resetSession?: boolean;
  steps: Step[];
}

export default function WorkflowEditorPage() {
  const { id } = useParams();
  const isNew = id === 'new';
  const [qs] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();

  const sites = useLoad(() => api.get<Site[]>('/api/sites'));
  const allWf = useLoad(() => api.get<any[]>('/api/workflows'));

  const [loaded, setLoaded] = useState(isNew);
  const [meta, setMeta] = useState<any>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [siteId, setSiteId] = useState<string>(qs.get('siteId') ?? '');
  const [def, setDef] = useState<Definition>(() => structuredClone(TEMPLATES[0].def));
  const [selected, setSelected] = useState<Path | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<'flow' | 'json' | 'versions' | 'help'>('flow');
  const [validation, setValidation] = useState<{ ok: boolean; errors: string[]; warnings: string[]; requestCount: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [templatePick, setTemplatePick] = useState(isNew);

  useEffect(() => {
    if (isNew) return;
    api
      .get(`/api/workflows/${id}`)
      .then((w) => {
        setMeta(w);
        setName(w.name);
        setDescription(w.description);
        setSiteId(w.siteId ?? '');
        setDef(w.definition);
        setLoaded(true);
        setDirty(false);
      })
      .catch((e) => toast(errorText(e), 'bad'));
  }, [id, isNew, toast]);

  // live validation
  const vTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!loaded) return;
    clearTimeout(vTimer.current);
    vTimer.current = window.setTimeout(() => {
      api
        .post('/api/workflows/validate', { definition: def, siteId: siteId || undefined })
        .then(setValidation)
        .catch(() => {});
    }, 500);
    return () => clearTimeout(vTimer.current);
  }, [def, siteId, loaded]);

  const change = useCallback((d: Definition) => {
    setDef(d);
    setDirty(true);
  }, []);

  const setSteps = (steps: Step[]) => change({ ...def, steps });
  const sel = selected ? getAt(def.steps, selected) : null;

  const modules = useMemo(() => Object.fromEntries((allWf.data ?? []).map((w) => [w.id, w.name])), [allWf.data]);

  const save = async (status?: string) => {
    setSaving(true);
    try {
      const body = { name: name || t('Untitled workflow'), description, siteId: siteId || null, definition: def, ...(status ? { status } : {}) };
      const w = isNew ? await api.post('/api/workflows', body) : await api.put(`/api/workflows/${id}`, body);
      setMeta(w);
      setDirty(false);
      toast(status === 'active' ? t('Workflow activated') : t('Saved'), 'good');
      if (isNew) nav(`/workflows/${w.id}`, { replace: true });
      return w;
    } catch (e) {
      toast(errorText(e), 'bad');
      return null;
    } finally {
      setSaving(false);
    }
  };

  // --- debug run ---
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugSite, setDebugSite] = useState('');
  const [debugRun, setDebugRun] = useState<any>(null);
  const [debugEntries, setDebugEntries] = useState<DebugEntry[]>([]);
  const startDebug = async () => {
    let wid = id;
    if (isNew || dirty) {
      const w = await save();
      if (!w) return;
      wid = w.id;
    }
    const sid = siteId || debugSite;
    if (!sid) {
      toast(t('Select a site for the debug run'), 'bad');
      return;
    }
    try {
      setDebugEntries([]);
      const r = await api.post(`/api/workflows/${wid}/debug`, { siteId: sid });
      setDebugRun({ id: r.id, status: 'queued' });
      setDebugOpen(true);
    } catch (e) {
      toast(errorText(e), 'bad');
    }
  };
  useEffect(() => {
    if (!debugRun || ['completed', 'failed', 'stopped', 'canceled'].includes(debugRun.status)) return;
    const es = new EventSource(`/api/runs/${debugRun.id}/live`);
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data);
      if (ev.type === 'debug') setDebugEntries((x) => [...x, ev.data]);
      if (ev.type === 'status') {
        setDebugRun((r: any) => ({ ...r, status: ev.data.status }));
        if (ev.data.done) {
          es.close();
          api.get(`/api/runs/${debugRun.id}`).then((r) => {
            setDebugRun(r);
            if (r.summary?.debug) setDebugEntries(r.summary.debug);
          });
        }
      }
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debugRun?.id]);

  if (!loaded) return <Loading />;

  const siteOptions = [{ value: '', label: t('Shared module (all sites)') }, ...(sites.data ?? []).map((s) => ({ value: s.id, label: s.name }))];

  return (
    <>
      <PageHeader
        back={<Link to="/workflows">← {t('Workflows')}</Link>}
        title={
          <span className="flex items-center gap-2">
            {name || t('New workflow')}
            {meta && <StatusBadge status={meta.status} />}
            {meta && meta.source !== 'panel' && <Badge tone="accent">{sourceLabel(meta.source)}</Badge>}
            {dirty && <Badge tone="warn">{t('unsaved')}</Badge>}
          </span>
        }
        subtitle={meta ? t('Version {v} · updated {date}', { v: meta.version, date: fmtDate(meta.updatedAt) }) : t('Define the user journey step by step')}
        actions={
          <>
            <Button icon={<FlaskConical className="size-4" />} onClick={() => (siteId ? startDebug() : setDebugOpen(true))}>
              {t('Debug run')}
            </Button>
            {!isNew && (
              <Button
                icon={<Copy className="size-4" />}
                onClick={async () => {
                  const w = await api.post(`/api/workflows/${id}/duplicate`, {});
                  nav(`/workflows/${w.id}`);
                }}
              >
                {t('Duplicate')}
              </Button>
            )}
            {meta?.status === 'draft' && (
              <Button icon={<CheckCircle2 className="size-4" />} onClick={() => save('active')} loading={saving}>
                {t('Approve & activate')}
              </Button>
            )}
            <Button variant="primary" icon={<Save className="size-4" />} onClick={() => save()} loading={saving}>
              {t('Save')}
            </Button>
          </>
        }
      />

      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <Field label={t('Name')}>
          <Input value={name} onChange={(e) => (setName(e.target.value), setDirty(true))} placeholder={t('E.g. Product checkout flow')} />
        </Field>
        <Field label={t('Site')} hint={t('Shared modules (e.g. Sign in) can be included in other workflows')}>
          <Select value={siteId} onChange={(e) => (setSiteId(e.target.value), setDirty(true))} options={siteOptions} />
        </Field>
        <Field label={t('Description')}>
          <Input value={description} onChange={(e) => (setDescription(e.target.value), setDirty(true))} />
        </Field>
      </div>

      {validation && (validation.errors.length > 0 || validation.warnings.length > 0) && (
        <div className="mb-4 space-y-2">
          {validation.errors.length > 0 && (
            <Alert tone="bad" title={t('Errors')}>
              {validation.errors.join('\n')}
            </Alert>
          )}
          {validation.warnings.length > 0 && <Alert tone="warn">{validation.warnings.join('\n')}</Alert>}
        </div>
      )}

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'flow', label: t('Flow') },
          { value: 'json', label: 'JSON' },
          ...(!isNew ? [{ value: 'versions' as const, label: t('Versions') }] : []),
          { value: 'help', label: t('Guide') },
        ]}
      />

      {tab === 'flow' && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="space-y-4">
            <Card title={t('Flow')} actions={validation && <span className="text-xs text-ink-3">{def.engine === 'browser' ? t('{n} page visits / iteration', { n: validation.requestCount }) : t('{n} requests / iteration', { n: validation.requestCount })}</span>}>
              <FlowView steps={def.steps} selected={selected} onSelect={setSelected} onChange={setSteps} modules={modules} engine={def.engine ?? 'http'} />
            </Card>
            <Card title={t('Flow settings')}>
              <div className="space-y-4">
                <Field
                  label={t('Runs in')}
                  hint={
                    def.engine === 'browser'
                      ? t('A real Chromium page per virtual user: measures what users see (Web Vitals), but costs about half a CPU core each. Needs a worker with a browser.')
                      : t('Sends HTTP requests directly: light enough for thousands of virtual users.')
                  }
                >
                  <Select
                    value={def.engine ?? 'http'}
                    onChange={(e) => change({ ...def, engine: e.target.value === 'browser' ? 'browser' : undefined })}
                    options={[
                      { value: 'http', label: t('HTTP (protocol level)') },
                      { value: 'browser', label: t('Browser (Chromium)') },
                    ]}
                  />
                </Field>
                {def.engine === 'browser' ? (
                  <p className="text-xs text-ink-3">{t('Every iteration starts as a new visitor with an empty browser.')}</p>
                ) : (
                  <Toggle checked={def.resetSession !== false} onChange={(v) => change({ ...def, resetSession: v })} label={t('New visitor every iteration (reset cookies)')} />
                )}
                <Field label={t('Workflow variables')} hint={t('Override site variables')}>
                  <KeyValueEditor value={def.variables ?? {}} onChange={(v) => change({ ...def, variables: Object.keys(v).length ? v : undefined })} keyPlaceholder={t('name')} />
                </Field>
              </div>
            </Card>
          </div>
          <div className="lg:sticky lg:top-4 lg:self-start">
            <Card title={sel ? t('Step settings') : t('Select a step')}>
              {sel && selected ? (
                <StepForm key={selected.join('.')} step={sel} workflows={allWf.data ?? []} selfId={id} onChange={(p) => setSteps(updateAt(def.steps, selected, p))} />
              ) : (
                <p className="text-sm text-ink-3">{t('Click a step in the flow on the left to edit it. Add new steps with “Add step”; use group steps to build probabilistic (funnel) and repeating flows.')}</p>
              )}
            </Card>
          </div>
        </div>
      )}

      {tab === 'json' && <JsonTab def={def} onChange={change} />}
      {tab === 'versions' && <VersionsTab id={id!} onRestore={(d) => (change(d), setTab('flow'))} />}
      {tab === 'help' && <HelpTab />}

      {!isNew && (
        <div className="mt-8 flex justify-end">
          <Button
            variant="danger"
            icon={<Trash2 className="size-4" />}
            onClick={async () => {
              if (!confirm(t('Delete this workflow?'))) return;
              const r = await api.del(`/api/workflows/${id}`);
              if (r.message) toast(r.message);
              nav('/workflows');
            }}
          >
            {t('Delete')}
          </Button>
        </div>
      )}

      <Modal open={templatePick} onClose={() => setTemplatePick(false)} title={t('How do you want to start?')}>
        <div className="space-y-2">
          {TEMPLATES.map((tpl) => (
            <button
              key={tpl.key}
              onClick={() => {
                setDef(structuredClone(tpl.def));
                setTemplatePick(false);
                setDirty(true);
              }}
              className="flex w-full items-start gap-3 rounded-md border border-line p-3 text-left hover:border-accent hover:bg-surface-2"
            >
              <span className="mt-0.5 text-accent">{tpl.icon}</span>
              <div>
                <div className="text-sm font-medium">{t(tpl.label)}</div>
                <div className="text-xs text-ink-3">{t(tpl.desc)}</div>
              </div>
            </button>
          ))}
          <p className="pt-2 text-xs text-ink-3">
            {t('Want to record your own browsing? Use “Import HAR” on the Workflows page to build a flow from the browser’s network log.')}
          </p>
        </div>
      </Modal>

      <Modal
        open={debugOpen}
        onClose={() => setDebugOpen(false)}
        title={t('Debug run (1 user, 1 iteration)')}
        wide
        footer={
          <>
            {debugRun && (
              <Link to={`/runs/${debugRun.id}`} className="mr-auto self-center text-xs text-ink-3 hover:text-ink">
                {t('Run page →')}
              </Link>
            )}
            <Button variant="primary" icon={<Play className="size-4" />} onClick={startDebug}>
              {debugRun ? t('Run again') : t('Run')}
            </Button>
          </>
        }
      >
        {!siteId && (
          <Field label={t('Which site should it run against?')} className="mb-4">
            <Select value={debugSite} onChange={(e) => setDebugSite(e.target.value)} options={[{ value: '', label: t('Select…') }, ...(sites.data ?? []).map((s) => ({ value: s.id, label: s.name }))]} />
          </Field>
        )}
        {debugRun && (
          <div className="mb-3 flex items-center gap-2 text-sm">
            <StatusBadge status={debugRun.status} />
            {debugRun.error && <span className="text-bad">{debugRun.error}</span>}
          </div>
        )}
        {debugRun ? <DebugTrace entries={debugEntries} /> : <p className="text-sm text-ink-3">{t('Shows each step’s status code, duration, extracted variables and a response preview. Think times are skipped.')}</p>}
      </Modal>
    </>
  );
}

function JsonTab({ def, onChange }: { def: Definition; onChange: (d: Definition) => void }) {
  const [text, setText] = useState(() => JSON.stringify(def, null, 2));
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setText(JSON.stringify(def, null, 2)), [def]);
  return (
    <Card title={t('Workflow definition (JSON)')} actions={<span className="text-xs text-ink-3">{t('Changes apply when the field loses focus')}</span>}>
      {err && <div className="mb-2 text-xs text-bad">{err}</div>}
      <Textarea
        rows={28}
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          try {
            const d = JSON.parse(text);
            if (!Array.isArray(d.steps)) throw new Error(t('a steps array is required'));
            setErr(null);
            onChange(d);
          } catch (e) {
            setErr((e as Error).message);
          }
        }}
      />
    </Card>
  );
}

function VersionsTab({ id, onRestore }: { id: string; onRestore: (d: Definition) => void }) {
  const { data, loading } = useLoad(() => api.get<any[]>(`/api/workflows/${id}/versions`), [id]);
  if (loading) return <Loading />;
  return (
    <Card title={t('Version history')} pad={false}>
      <ul className="divide-y divide-line/60">
        {(data ?? []).map((v) => (
          <li key={v.version} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <span className="font-mono">v{v.version}</span>
            <Badge>{sourceLabel(v.source)}</Badge>
            <span className="text-ink-3">{fmtDate(v.createdAt)}</span>
            <span className="text-xs text-ink-3">{t('{n} steps', { n: v.definition?.steps?.length ?? 0 })}</span>
            <Button size="sm" className="ml-auto" onClick={() => onRestore(v.definition)}>
              {t('Load this version')}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function HelpTab() {
  const { data } = useLoad(() => api.get('/api/dsl'));
  return (
    <Card title={t('Workflow DSL guide')}>
      <pre className="overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-2">{data?.doc ?? '…'}</pre>
    </Card>
  );
}
